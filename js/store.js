// IndexedDB: poslední stav úkolů, fronta změn, drobná metadata.
const DB_NAME = 'ukoly';
const VERSION = 1;

function promisify(req) {
  return new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
}

export async function openStore(name = DB_NAME) {
  const req = indexedDB.open(name, VERSION);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('tasks')) db.createObjectStore('tasks', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('queue')) db.createObjectStore('queue', { keyPath: 'seq', autoIncrement: true });
    if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
  };
  const db = await promisify(req);

  const tx = (store, mode, fn) => new Promise((res, rej) => {
    const t = db.transaction(store, mode);
    const s = t.objectStore(store);
    let out;
    Promise.resolve(fn(s)).then((v) => { out = v; });
    t.oncomplete = () => res(out);
    t.onerror = () => rej(t.error);
    t.onabort = () => rej(t.error);
  });

  return {
    all: (store) => tx(store, 'readonly', (s) => promisify(s.getAll())),
    get: (store, key) => tx(store, 'readonly', (s) => promisify(s.get(key))),
    put: (store, val) => tx(store, 'readwrite', (s) => promisify(s.put(val))),
    add: (store, val) => tx(store, 'readwrite', (s) => promisify(s.add(val))),
    del: (store, key) => tx(store, 'readwrite', (s) => promisify(s.delete(key))),
    async getMeta(k, dflt = null) { const r = await this.get('meta', k); return r ? r.v : dflt; },
    setMeta(k, v) { return this.put('meta', { k, v }); },
  };
}
