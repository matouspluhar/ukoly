// Demo režim (?demo): falešný OneDrive v localStorage, bez přihlášení.
// Slouží k vyzkoušení vzhledu a k testům; skutečná data nepoužívá.
import { GraphError, OfflineError } from './graph.js';
import { newTaskText, applyPatch, localDate } from './format.js';

const KEY = 'ukoly-demo-drive';
const UKOLY = 'f-ukoly', HOTOVO = 'f-hotovo';

function seed() {
  const today = localDate();
  const d = new Date(); const plus = (n) => { const x = new Date(d); x.setDate(x.getDate() + n); return localDate(x); };
  const files = {};
  const add = (id, name, text, extra = {}) => {
    const lines = Object.entries(extra).map(([k, v]) => `${k}: ${v}`).join('\n');
    files[id] = { id, name, parent: UKOLY, text: lines ? text.replace(/^zakazka:.*$/m, (m) => (extra.zakazka ? '' : m + '\n') + lines) : text, v: 1 };
  };
  add('d1', '20261124-1631 koupit-mleko.md', applyPatch(newTaskText({ nazev: 'Koupit mléko', note: 'mléko, rohlíky, máslo' }), { fields: { muj_den: today } }).replace('zdroj: app', 'zdroj: claude'), { odhad: '15 min' });
  add('d2', '20261120-0900 odevzdat-dps-fasady.md', newTaskText({ nazev: 'Odevzdat DPS fasády', termin: today, ohen: true }).replace('## Souvislosti\n', '## Souvislosti\nNavazuje na kontrolu detailů oplechování. Před odevzdáním projít katalogové listy.\n'),
    { zakazka: 2612, odhad: '2 h', dalsi_krok: 'Projít výkresy D.1.2 proti tabulce změn   # NÁVRH' });
  add('d3', '20261121-1015 zavolat-investorovi.md', newTaskText({ nazev: 'Zavolat investorovi kvůli statice', termin: plus(3) }), { zakazka: 2609, odhad: '30 min' });
  add('d4', '20261122-1800 precist-kapitolu-o-zettelkastenu.md', newTaskText({ nazev: 'Přečíst kapitolu o Zettelkastenu' }), { odhad: '1 h' });
  add('d5', '20261122-1900 zkontrolovat-zalohy.md', newTaskText({ nazev: 'Zkontrolovat zálohy' }), { zakazka: 'PENÍZE', odhad: '30 min' });
  add('d6', '20261123-0800 situace-pro-dpz.md', newTaskText({ nazev: 'Opravit situaci pro DPZ', termin: plus(2) }), { zakazka: 2612, odhad: 'půlden', ceka_na: 'Adam – půdorysy obou schodišť' });
  add('d7', '20261119-0800 poslat-fakturu.md', newTaskText({ nazev: 'Poslat fakturu za studii', termin: plus(-2) }), { zakazka: 2609, odhad: '15 min' });
  add('d8', '20261118-0800 detail-soklu.md', newTaskText({ nazev: 'Nakreslit detail soklu', termin: plus(9) }), { zakazka: 2612, odhad: '2 h', dalsi_krok: 'Vyjmout řez z modelu a doplnit kóty' });
  add('d9', '20261118-0900 ucebnice-kapitola.md', newTaskText({ nazev: 'Připravit cvičení na rozpočet' }), { zakazka: 'TUL', odhad: '2 h', muj_den: today });
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
