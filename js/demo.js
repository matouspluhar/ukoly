// Demo režim (?demo): falešný OneDrive v localStorage, bez přihlášení.
// Slouží k vyzkoušení vzhledu a k testům; skutečná data nepoužívá.
import { GraphError, OfflineError } from './graph.js';
import { localDate } from './format.js';

const KEY = 'ukoly-demo-drive';
const UKOLY = 'f-ukoly', HOTOVO = 'f-hotovo';

// Ukázkový úkol ve formátu schema 2 – pole, která v aplikaci píše Claude, jdou rovnou do hlavičky.
function demoTask({ nazev, note = '', souvislosti = '', zdroj = 'claude', ...fm }) {
  const head = { schema: 2, nazev, stav: 'otevreno', termin: '', muj_den: '', ohen: false, zakazka: '', ...fm, vytvoreno: '2026-11-20T09:00', hotovo: '', zdroj };
  const lines = Object.entries(head).map(([k, v]) => (v === '' ? `${k}:` : `${k}: ${v}`));
  return `---\n${lines.join('\n')}\n---\n${note ? note + '\n\n' : ''}## Souvislosti\n${souvislosti ? souvislosti + '\n' : ''}\n## Průběh\n- 2026-11-20 09:00 – založeno (demo)\n`;
}

function seed() {
  const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return localDate(d); };
  const today = day(0);
  const list = [
    { nazev: 'Odevzdat DPS fasády', zakazka: 2612, termin: today, ohen: true, odhad: '2 h', dalsi_krok: 'Projít výkresy D.1.2 proti tabulce změn   # NÁVRH',
      souvislosti: 'Navazuje na kontrolu detailů oplechování. Před odevzdáním projít katalogové listy.' },
    { nazev: 'Opravit situaci pro DPZ', zakazka: 2612, termin: day(2), odhad: 'půlden', ceka_na: 'Adam – půdorysy obou schodišť', ceka_od: day(-9) },
    { nazev: 'Nakreslit detail soklu', zakazka: 2612, termin: day(9), odhad: '2 h', dalsi_krok: 'Vyjmout řez z modelu a doplnit kóty' },
    { nazev: 'Poslat fakturu za studii', zakazka: 2609, termin: day(-2), odhad: '15 min' },
    { nazev: 'Zavolat investorovi kvůli statice', zakazka: 2609, termin: day(3), odhad: '30 min' },
    { nazev: 'Zkontrolovat zálohy', zakazka: 'PENÍZE', odhad: '30 min' },
    { nazev: 'Připravit cvičení na rozpočet', zakazka: 'TUL', odhad: '2 h', muj_den: today, navrh: today },
    { nazev: 'Koupit mléko', note: 'mléko, rohlíky, máslo', odhad: '15 min', muj_den: today },
    { nazev: 'Přečíst kapitolu o Zettelkastenu', odhad: '1 h', zdroj: 'app' },
  ];
  const files = {};
  list.forEach((t, i) => {
    const id = 'd' + (i + 1);
    files[id] = { id, name: `20261120-09${String(i).padStart(2, '0')} demo-${i + 1}.md`, parent: UKOLY, text: demoTask(t), v: 1 };
  });
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
    canAutoLogin: () => false,
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
