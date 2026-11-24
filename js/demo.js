// Demo režim (?demo): falešný OneDrive v localStorage, bez přihlášení.
// Slouží k vyzkoušení vzhledu a k testům; skutečná data nepoužívá.
import { GraphError, OfflineError } from './graph.js';
import { newTaskText, applyPatch, localDate } from './format.js';

const KEY = 'ukoly-demo-drive';
const UKOLY = 'f-ukoly', HOTOVO = 'f-hotovo';

function seed() {
  const today = localDate();
  const files = {};
  const add = (id, name, text) => { files[id] = { id, name, parent: UKOLY, text, v: 1 }; };
  add('d1', '20261124-1631 koupit-mleko.md', applyPatch(newTaskText({ nazev: 'Koupit mléko', note: 'mléko, rohlíky, máslo' }), { fields: { muj_den: today } }).replace('zdroj: app', 'zdroj: claude'));
  add('d2', '20261120-0900 skola-odevzdat-dps-fasady.md', newTaskText({ nazev: 'Škola – odevzdat DPS fasády', termin: today, ohen: true }).replace('zakazka:', 'zakazka: 2612').replace('## Souvislosti\n', '## Souvislosti\nNavazuje na kontrolu detailů oplechování. Před odevzdáním projít katalogové listy.\n'));
  add('d3', '20261121-1015 zavolat-investorovi.md', newTaskText({ nazev: 'Zavolat investorovi kvůli statice', termin: '2026-12-01' }).replace('zakazka:', 'zakazka: 2609'));
  add('d4', '20261122-1800 precist-kapitolu-o-zettelkastenu.md', newTaskText({ nazev: 'Přečíst kapitolu o Zettelkastenu' }));
  add('d5', '20261122-1900 penize-zalohy.md', newTaskText({ nazev: 'Peníze – zkontrolovat zálohy' }));
  return { files };
}

export function createDemoBackend() {
  let state = JSON.parse(localStorage.getItem(KEY) || 'null') || seed();
  const save = () => localStorage.setItem(KEY, JSON.stringify(state));
  save();
  const wait = () => new Promise((r) => setTimeout(r, 120));
  const guard = async () => { await wait(); if (window.demoOffline) throw new OfflineError(); };
  const item = (f) => ({ id: f.id, name: f.name, eTag: `"${f.id}-${f.v}"`, parentId: f.parent, isFile: true });
  const get = (id) => { const f = state.files[id]; if (!f) throw new GraphError(404); return f; };

  // Pro testy: změna „od Clauda“ přímo v úložišti.
  window.demoClaudeEdit = (id, fn) => { const f = get(id); f.text = fn(f.text); f.v++; save(); };
  window.demoReset = () => { localStorage.removeItem(KEY); state = seed(); save(); };
  window.demoState = () => state;

  return {
    demo: true,
    async init() { return true; },
    signedIn: () => true,
    userName: () => 'demo',
    login() {}, reauth() {}, logout() { window.demoReset(); location.reload(); },
    folderId: async () => UKOLY,
    async zakazky() { await guard(); return state.zakazky ?? '- 2612 ZŠ Ukázková\n- 2609 Bytový dům Ukázka'; },
    async list() { await guard(); return Object.values(state.files).filter((f) => f.parent === UKOLY).map(item); },
    async listDone() { await guard(); return Object.values(state.files).filter((f) => f.parent === HOTOVO).map(item); },
    doneFolderId: async () => HOTOVO,
    async getItem(id) { await guard(); return item(get(id)); },
    async getText(it) { await guard(); return get(it.id).text; },
    async put(id, text, eTag) {
      await guard(); const f = get(id);
      if (eTag !== item(f).eTag) throw new GraphError(412);
      f.text = text; f.v++; save(); return item(f);
    },
    async create(name, text) {
      await guard();
      if (Object.values(state.files).some((f) => f.parent === UKOLY && f.name === name)) throw new GraphError(409);
      const id = 'n' + Date.now() + Math.random().toString(36).slice(2, 6);
      state.files[id] = { id, name, parent: UKOLY, text, v: 1 }; save(); return item(state.files[id]);
    },
    async move(id, eTag, toDone, newName) {
      await guard(); const f = get(id);
      if (eTag !== item(f).eTag) throw new GraphError(412);
      const target = toDone ? HOTOVO : UKOLY;
      const name = newName || f.name;
      if (Object.values(state.files).some((x) => x !== f && x.parent === target && x.name === name)) throw new GraphError(409);
      f.parent = target; f.name = name; f.v++; save(); return item(f);
    },
  };
}
