// Fronta změn a synchronizace s OneDrivem.
// Každá změna se uloží nejdřív do IndexedDB, pak se odešle. Zápis vždy
// vychází z čerstvé verze souboru na serveru (kontrola eTag), takže se
// sloučí po polích a Claudova sekce Souvislosti zůstane netknutá.
import { parseTask, applyPatch } from './format.js';
import { GraphError, OfflineError, AuthError } from './graph.js';

const MAX_RETRY = 4;
const PARALLEL = 6;

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

  kick() {
    if (this.running) { this.again = true; return; }
    this.run();
  }

  async run() {
    this.running = true;
    this.onStatus({ state: 'sync' });
    try {
      const drained = await this.drain();
      if (drained) await this.refresh();
      const pending = await this.pendingCount();
      this.onStatus({ state: 'ok', at: new Date(), pending });
    } catch (e) {
      const pending = await this.pendingCount().catch(() => 0);
      if (e instanceof OfflineError) this.onStatus({ state: 'offline', pending });
      else if (e instanceof AuthError) this.onStatus({ state: 'auth', pending });
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

  // Odešle frontu. Vrací false, když čeká operace s odkladem (odškrtnutí – 5 s na vrácení).
  async drain() {
    const ops = (await this.db.all('queue')).sort((a, b) => a.seq - b.seq);
    for (const op of ops) {
      if (op.notBefore && op.notBefore > Date.now()) {
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.kick(), op.notBefore - Date.now() + 100);
        return false;
      }
      const still = await this.db.get('queue', op.seq);
      if (!still) continue;
      await this.process(op);
      await this.db.del('queue', op.seq);
    }
    return true;
  }

  async process(op) {
    if (op.type === 'create') return this.doCreate(op);
    if (op.type === 'update') return this.doUpdate(op);
    if (op.type === 'done') return this.doDone(op);
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
    for (let i = 0; i < MAX_RETRY; i++) {
      let it;
      try { it = await this.b.getItem(id); } catch (e) { if (e.status === 404) break; throw e; }
      if (it.parentId !== ukolyId) break; // už je v HOTOVO (nebo jinde) – hotovo
      const text = await this.b.getText(it);
      const p = parseTask(text);
      let eTag = it.eTag;
      try {
        if (p.fm.stav !== 'hotovo') {
          const next = applyPatch(text, { fields: { stav: 'hotovo', hotovo: op.at } });
          eTag = (await this.b.put(id, next, eTag)).eTag;
        }
        try { await this.b.moveToDone(id, eTag); }
        catch (e) {
          if (e.status !== 409) throw e;
          await this.b.moveToDone(id, eTag, it.name.replace(/\.md$/, `-${Date.now() % 100000}.md`));
        }
        break;
      } catch (e) { if (e.status === 412) continue; throw e; }
    }
    await this.db.del('tasks', op.taskId);
    await this.db.del('tasks', id);
    await this.emit();
  }

  // Načte seznam z OneDrivu; stahuje jen soubory se změněným eTagem.
  async refresh() {
    const items = await this.b.list();
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
        const text = await this.b.getText(it);
        await this.db.put('tasks', makeTask(it.id, it.name, text, it.eTag));
      }));
    }
    const serverIds = new Set(items.map((it) => it.id));
    for (const t of local.values()) {
      if (!serverIds.has(t.id) && !pending.has(t.id) && !String(t.id).startsWith('tmp-')) await this.db.del('tasks', t.id);
    }
    await this.emit();
  }

  async emit() { this.onTasks(await this.db.all('tasks')); }
}
