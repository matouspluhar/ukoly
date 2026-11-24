// Fronta změn a synchronizace s OneDrivem.
// Každá změna se uloží nejdřív do IndexedDB, pak se odešle. Zápis vždy
// vychází z čerstvé verze souboru na serveru (kontrola eTag), takže se
// sloučí po polích a Claudova sekce Souvislosti zůstane netknutá.
import { parseTask, applyPatch } from './format.js';
import { GraphError, OfflineError, AuthError } from './graph.js';

const MAX_RETRY = 4;
const PARALLEL = 6;
const TRANSIENT = new Set([408, 423, 429, 500, 502, 503, 504]);

// Chyba, kterou má smysl zkusit znovu později (síť, přetížený server, zamčený soubor).
export const isTransient = (e) => e instanceof OfflineError || (e instanceof GraphError && TRANSIENT.has(e.status));
// Chyba, kterou opakování nespraví – operace jde stranou, aby neblokovala frontu.
export const isFatal = (e) => e instanceof GraphError && !TRANSIENT.has(e.status) && e.status !== 401;

// Jeden synchronizátor napříč okny téže aplikace (nainstalovaná appka + karta v prohlížeči).
const withLock = (fn) => (globalThis.navigator?.locks ? navigator.locks.request('ukoly-sync', fn) : fn());

export function makeTask(id, name, text, eTag, extra = {}) {
  const p = parseTask(text);
  return { id, name, text, eTag, fm: p.fm, note: p.note, souvislosti: p.souvislosti, ...extra };
}

export class Sync {
  constructor(backend, db, { onTasks, onStatus }) {
    this.b = backend; this.db = db;
    this.onTasks = onTasks; this.onStatus = onStatus;
    this.running = false; this.again = false; this.timer = null;
  }

  async enqueue(op) {
    const seq = await this.db.add('queue', op);
    this.kick();
    return seq;
  }

  // Vrátí true, pokud se operaci podařilo zrušit dřív, než odešla.
  async cancel(seq) {
    const op = await this.db.get('queue', seq);
    if (!op || !op.notBefore || op.notBefore <= Date.now() + 50) return false;
    await this.db.del('queue', seq);
    return true;
  }

  async pendingCount() { return (await this.db.all('queue')).length; }

  kick(delay = 0) {
    if (delay) { clearTimeout(this.timer); this.timer = setTimeout(() => this.kick(), delay); return; }
    if (this.running) { this.again = true; return; }
    this.run();
  }

  async run() {
    this.running = true;
    this.onStatus({ state: 'sync' });
    try {
      await withLock(async () => {
        await this.drain();
        await this.refresh();
      });
      this.backoff = 0;
      const pending = await this.pendingCount();
      const dead = (await this.db.getMeta('dead', [])).length;
      this.onStatus({ state: dead ? 'error' : 'ok', at: new Date(), pending, msg: dead ? `${dead} změn nešlo zapsat` : '' });
    } catch (e) {
      const pending = await this.pendingCount().catch(() => 0);
      if (isTransient(e)) {
        // Exponenciální odstup 2 s → 60 s, nebo podle Retry-After ze serveru.
        this.backoff = Math.min(60000, (this.backoff || 1000) * 2);
        const wait = e.retryAfter ? e.retryAfter * 1000 : this.backoff;
        if (globalThis.navigator?.onLine !== false) this.kick(wait);
        this.onStatus({ state: e instanceof OfflineError ? 'offline' : 'retry', pending });
      } else if (e instanceof AuthError) this.onStatus({ state: 'auth', pending });
      else { console.error(e); this.onStatus({ state: 'error', msg: e.message, pending }); }
    } finally {
      this.running = false;
      if (this.again) { this.again = false; this.kick(); }
    }
  }

  async resolve(id) {
    if (!String(id).startsWith('tmp-')) return id;
    return (await this.db.getMeta('id:' + id)) || null;
  }

  // Odešle frontu v pořadí. Operace s odkladem (odškrtnutí – 5 s na vrácení) blokuje jen
  // další změny téhož úkolu, ostatní projdou. Neopravitelná chyba odloží operaci stranou.
  async drain() {
    const ops = (await this.db.all('queue')).sort((a, b) => a.seq - b.seq);
    const blocked = new Set();
    let wake = Infinity;
    for (const op of ops) {
      const key = op.taskId || op.tempId;
      if (blocked.has(key)) continue;
      if (op.notBefore && op.notBefore > Date.now()) {
        blocked.add(key);
        wake = Math.min(wake, op.notBefore);
        continue;
      }
      if (!(await this.db.get('queue', op.seq))) continue; // mezitím zrušeno
      try {
        await this.process(op);
      } catch (e) {
        if (!isFatal(e)) throw e;
        const dead = await this.db.getMeta('dead', []);
        dead.push({ op, status: e.status, at: new Date().toISOString() });
        await this.db.setMeta('dead', dead.slice(-50));
        console.warn('Operace odložena', op, e);
      }
      await this.db.del('queue', op.seq);
    }
    if (wake < Infinity) this.kick(wake - Date.now() + 100);
  }

  async process(op) {
    if (op.type === 'create') return this.doCreate(op);
    if (op.type === 'update') return this.doUpdate(op);
    if (op.type === 'done') return this.doDone(op);
    if (op.type === 'reopen') return this.doReopen(op);
  }

  async doCreate(op) {
    let name = op.filename;
    for (let i = 0; i < 20; i++) {
      try {
        const it = await this.b.create(name, op.text);
        await this.db.setMeta('id:' + op.tempId, it.id);
        const local = await this.db.get('tasks', op.tempId);
        await this.db.del('tasks', op.tempId);
        // Mezitím provedené místní úpravy zůstanou; server je dožene přes navazující operace.
        const text = local ? local.text : op.text;
        await this.db.put('tasks', makeTask(it.id, it.name, text, it.eTag));
        await this.emit();
        return;
      } catch (e) {
        if (e instanceof GraphError && e.status === 409) { name = op.filename.replace(/\.md$/, `-${i + 2}.md`); continue; }
        throw e;
      }
    }
    throw new Error('Nelze založit soubor ' + op.filename);
  }

  async hasLaterOps(id, seq) {
    return (await this.db.all('queue')).some((o) => o.seq > seq && (o.taskId === id || o.tempId === id));
  }

  async doUpdate(op) {
    const id = await this.resolve(op.taskId);
    if (!id) return;
    for (let i = 0; i < MAX_RETRY; i++) {
      let it;
      try { it = await this.b.getItem(id); } catch (e) { if (e.status === 404) return; throw e; }
      const text = await this.b.getText(it);
      const next = applyPatch(text, { fields: op.fields, note: op.note });
      if (next === text) return;
      try {
        const saved = await this.b.put(id, next, it.eTag);
        if (!(await this.hasLaterOps(op.taskId, op.seq))) {
          await this.db.put('tasks', makeTask(id, saved.name, next, saved.eTag));
          await this.emit();
        }
        return;
      } catch (e) { if (e.status === 412) continue; throw e; }
    }
    throw new Error('Úkol se pořád mění, zkusím později');
  }

  async doDone(op) {
    const id = await this.resolve(op.taskId);
    if (!id) return;
    const ukolyId = await this.b.folderId();
    let final = null;
    for (let i = 0; i < MAX_RETRY; i++) {
      let it;
      try { it = await this.b.getItem(id); } catch (e) { if (e.status === 404) break; throw e; }
      const text = await this.b.getText(it);
      if (it.parentId !== ukolyId) { final = { it, text }; break; } // už je v HOTOVO
      const p = parseTask(text);
      let eTag = it.eTag, next = text;
      try {
        if (p.fm.stav !== 'hotovo') {
          next = applyPatch(text, { fields: { stav: 'hotovo', hotovo: op.at } });
          eTag = (await this.b.put(id, next, eTag)).eTag;
        }
        let moved;
        try { moved = await this.b.move(id, eTag, true); }
        catch (e) {
          if (e.status !== 409) throw e;
          moved = await this.b.move(id, eTag, true, it.name.replace(/\.md$/, `-${Date.now() % 100000}.md`));
        }
        final = { it: moved, text: next };
        break;
      } catch (e) { if (e.status === 412) continue; throw e; }
    }
    if (op.taskId !== id) await this.db.del('tasks', op.taskId);
    // Hotový úkol zůstává v místní paměti – ukazuje se ve sbalené sekci Hotovo.
    if (final && !(await this.hasLaterOps(op.taskId, op.seq))) await this.db.put('tasks', makeTask(id, final.it.name, final.text, final.it.eTag));
    else if (!final) await this.db.del('tasks', id);
    await this.emit();
  }

  // Vrácení hotového úkolu mezi otevřené: stav otevreno, hotovo prázdné, přesun zpět do UKOLY.
  async doReopen(op) {
    const id = await this.resolve(op.taskId);
    if (!id) return;
    const doneId = await this.b.doneFolderId();
    for (let i = 0; i < MAX_RETRY; i++) {
      let it;
      try { it = await this.b.getItem(id); } catch (e) { if (e.status === 404) return; throw e; }
      const text = await this.b.getText(it);
      const next = applyPatch(text, { fields: { stav: 'otevreno', hotovo: '' } });
      try {
        let eTag = it.eTag;
        if (next !== text) eTag = (await this.b.put(id, next, eTag)).eTag;
        let moved = it;
        if (it.parentId === doneId) {
          try { moved = await this.b.move(id, eTag, false); }
          catch (e) {
            if (e.status !== 409) throw e;
            moved = await this.b.move(id, eTag, false, it.name.replace(/\.md$/, `-${Date.now() % 100000}.md`));
          }
        }
        if (!(await this.hasLaterOps(op.taskId, op.seq))) await this.db.put('tasks', makeTask(id, moved.name, next, moved.eTag));
        await this.emit();
        return;
      } catch (e) { if (e.status === 412) continue; throw e; }
    }
    throw new Error('Úkol se pořád mění, zkusím později');
  }

  // Načte seznam z OneDrivu; stahuje jen soubory se změněným eTagem.
  async refresh() {
    const open = await this.b.list();
    const done = await this.b.listDone(14);
    const items = open.concat(done);
    const queue = await this.db.all('queue');
    const pending = new Set();
    for (const o of queue) {
      const raw = o.taskId || o.tempId;
      pending.add(raw);
      pending.add(await this.resolve(raw));
    }
    const local = new Map((await this.db.all('tasks')).map((t) => [t.id, t]));
    const toFetch = items.filter((it) => !pending.has(it.id) && local.get(it.id)?.eTag !== it.eTag);

    for (let i = 0; i < toFetch.length; i += PARALLEL) {
      await Promise.all(toFetch.slice(i, i + PARALLEL).map(async (it) => {
        try {
          const text = await this.b.getText(it);
          await this.db.put('tasks', makeTask(it.id, it.name, text, it.eTag));
        } catch (e) {
          if (!isFatal(e)) throw e; // síť → celá obnova později
          console.warn('Soubor nejde načíst', it.name, e);
        }
      }));
    }
    const serverIds = new Set(items.map((it) => it.id));
    for (const t of local.values()) {
      if (!serverIds.has(t.id) && !pending.has(t.id) && !String(t.id).startsWith('tmp-')) await this.db.del('tasks', t.id);
    }
    await this.emit();
  }

  // Víc změn v rychlém sledu = jedno překreslení.
  emit() {
    if (!this.emitting) {
      this.emitting = Promise.resolve().then(async () => {
        this.emitting = null;
        this.onTasks(await this.db.all('tasks'));
      });
    }
    return this.emitting;
  }
}
