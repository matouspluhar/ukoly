// Testy fronty a synchronizace proti falešnému OneDrivu (bez prohlížeče).
import assert from 'node:assert/strict';
import { Sync, makeTask } from '../js/sync.js';
import { GraphError, OfflineError } from '../js/graph.js';
import { newTaskText, parseTask } from '../js/format.js';

function memDb() {
  const st = { tasks: new Map(), queue: new Map(), meta: new Map() }; let seq = 0;
  const key = (s, v) => (s === 'tasks' ? v.id : s === 'meta' ? v.k : v.seq);
  return {
    async all(s) { return [...st[s].values()].map((v) => structuredClone(v)); },
    async get(s, k) { const v = st[s].get(k); return v && structuredClone(v); },
    async put(s, v) { st[s].set(key(s, v), structuredClone(v)); },
    async add(s, v) { v = { ...v, seq: ++seq }; st[s].set(v.seq, v); return v.seq; },
    async del(s, k) { st[s].delete(k); },
    async getMeta(k, d = null) { const r = st.meta.get(k); return r ? structuredClone(r.v) : d; },
    async setMeta(k, v) { st.meta.set(k, { k, v: structuredClone(v) }); },
  };
}
function drive() {
  const files = {}; let n = 0; const fail = { next: [] };
  const item = (f) => ({ id: f.id, name: f.name, eTag: `"${f.id}-${f.v}"`, parentId: f.parent });
  const g = async () => { const e = fail.next.shift(); if (e) throw e; };
  const get = (id) => { if (!files[id]) throw new GraphError(404); return files[id]; };
  return {
    files, fail,
    add(name, text, parent = 'U') { const id = 'f' + ++n; files[id] = { id, name, text, parent, v: 1 }; return id; },
    folderId: async () => 'U', doneFolderId: async () => 'H',
    async list() { await g(); return Object.values(files).filter((f) => f.parent === 'U').map(item); },
    async listDone() { return Object.values(files).filter((f) => f.parent === 'H').map(item); },
    async getItem(id) { await g(); return item(get(id)); },
    async getText(it) { return get(it.id).text; },
    async put(id, text, eTag) { await g(); const f = get(id); if (eTag !== item(f).eTag) throw new GraphError(412); f.text = text; f.v++; return item(f); },
    async create(name, text) { await g(); const id = this.add(name, text); return item(files[id]); },
    async move(id, eTag, toDone) { await g(); const f = get(id); if (eTag !== item(f).eTag) throw new GraphError(412); f.parent = toDone ? 'H' : 'U'; f.v++; return item(f); },
  };
}
const mk = () => { const db = memDb(), b = drive(); let st = null; const s = new Sync(b, db, { onTasks() {}, onStatus(x) { st = x; } }); return { db, b, s, status: () => st }; };
const settle = (s) => new Promise((r) => { const t = setInterval(() => { if (!s.running) { clearInterval(t); r(); } }, 5); });

// 1 odškrtnutí s odkladem neblokuje změnu jiného úkolu
{
  const { db, b, s } = mk();
  const a = b.add('a.md', newTaskText({ nazev: 'A' })), c = b.add('c.md', newTaskText({ nazev: 'C' }));
  await db.add('queue', { type: 'done', taskId: a, at: '2026-11-24T10:00', notBefore: Date.now() + 60000 });
  await db.add('queue', { type: 'update', taskId: c, fields: { ohen: true } });
  s.run(); await settle(s); clearTimeout(s.timer);
  assert.equal(parseTask(b.files[c].text).fm.ohen, true, 'změna C prošla');
  assert.equal(b.files[a].parent, 'U', 'A čeká na 5 s');
  assert.equal((await db.all('queue')).length, 1);
}
// 2 neopravitelná chyba jde stranou, fronta pokračuje
{
  const { db, b, s, status } = mk();
  const c = b.add('c.md', newTaskText({ nazev: 'C' }));
  b.fail.next.push(new GraphError(400));
  await db.add('queue', { type: 'update', taskId: c, fields: { ohen: true } });
  await db.add('queue', { type: 'update', taskId: c, fields: { termin: '2026-12-01' } });
  s.run(); await settle(s);
  assert.equal(parseTask(b.files[c].text).fm.termin, '2026-12-01', 'druhá změna prošla');
  assert.equal((await db.getMeta('dead', [])).length, 1, 'první je mezi odloženými');
  assert.equal(status().state, 'error');
}
// 3 přetížený server: fronta zůstane, naplánuje se další pokus
{
  const { db, b, s, status } = mk();
  const c = b.add('c.md', newTaskText({ nazev: 'C' }));
  b.fail.next.push(new GraphError(503, '', 1));
  await db.add('queue', { type: 'update', taskId: c, fields: { ohen: true } });
  s.run(); await settle(s);
  assert.equal(status().state, 'retry');
  assert.equal((await db.all('queue')).length, 1, 'nic se neztratilo');
  await new Promise((r) => setTimeout(r, 1200)); await settle(s);
  assert.equal(parseTask(b.files[c].text).fm.ohen, true, 'po Retry-After prošlo');
  clearTimeout(s.timer);
}
// 4 offline: nic se neztratí
{
  const { db, b, s, status } = mk();
  b.fail.next.push(new OfflineError());
  await db.add('queue', { type: 'create', tempId: 'tmp-1', filename: 'x.md', text: newTaskText({ nazev: 'X' }) });
  s.run(); await settle(s); clearTimeout(s.timer);
  assert.equal(status().state, 'offline');
  assert.equal((await db.all('queue')).length, 1);
}
// 5 souběh: Claude změní soubor mezi čtením a zápisem → 412 → nový pokus, Souvislosti zůstanou
{
  const { db, b, s } = mk();
  const c = b.add('c.md', newTaskText({ nazev: 'C' }));
  const put = b.put.bind(b); let once = true;
  b.put = async (id, text, eTag) => {
    if (once) { once = false; b.files[id].text = b.files[id].text.replace('## Souvislosti\n', '## Souvislosti\nOD CLAUDA\n'); b.files[id].v++; }
    return put(id, text, eTag);
  };
  await db.add('queue', { type: 'update', taskId: c, fields: { ohen: true }, note: 'z aplikace' });
  s.run(); await settle(s);
  const p = parseTask(b.files[c].text);
  assert.ok(p.souvislosti.includes('OD CLAUDA') && p.fm.ohen && p.note === 'z aplikace');
}
// 6 hotovo a vrácení
{
  const { db, b, s } = mk();
  const a = b.add('a.md', newTaskText({ nazev: 'A' }));
  await db.put('tasks', makeTask(a, 'a.md', b.files[a].text, '"x"'));
  await db.add('queue', { type: 'done', taskId: a, at: '2026-11-24T10:00' });
  s.run(); await settle(s);
  assert.equal(b.files[a].parent, 'H');
  assert.equal((await db.get('tasks', a)).fm.stav, 'hotovo', 'hotový zůstal v paměti pro sekci Hotovo');
  await db.add('queue', { type: 'reopen', taskId: a });
  s.run(); await settle(s);
  assert.equal(b.files[a].parent, 'U');
  assert.equal(parseTask(b.files[a].text).fm.stav, 'otevreno');
}
console.log('sync: 6 testů prošlo');
