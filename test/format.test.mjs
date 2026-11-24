import assert from 'node:assert/strict';
import { parseTask, applyPatch, newTaskText, fileName, compareTasks, inMyDay } from '../js/format.js';

const template = `---
nazev: Koupit mléko
stav: otevreno            # otevreno | hotovo | zruseno
termin:                   # RRRR-MM-DD, volitelně
muj_den:                  # RRRR-MM-DD = je v Mém dni toho dne
ohen: false               # true jen u extrémů (🔥, červeně)
zakazka: 2612
vytvoreno: 2026-11-24T16:31
hotovo:                   # RRRR-MM-DDTHH:MM
zdroj: claude             # claude | app
---
Poznámka (např. mléko, rohlíky, maso)

## Souvislosti
Souvisí s [[2612]]. Navazuje nákup v pátek.
`;

// 1 čtení šablony
const p = parseTask(template);
assert.equal(p.fm.nazev, 'Koupit mléko');
assert.equal(p.fm.stav, 'otevreno');
assert.equal(p.fm.termin, '');
assert.equal(p.fm.ohen, false);
assert.equal(p.fm.zakazka, '2612');
assert.equal(p.fm.zdroj, 'claude');
assert.equal(p.note, 'Poznámka (např. mléko, rohlíky, maso)');
assert.equal(p.souvislosti, 'Souvisí s [[2612]]. Navazuje nákup v pátek.');

// 2 patch zachová komentáře, zakazku i Souvislosti
const t2 = applyPatch(template, { fields: { stav: 'hotovo', hotovo: '2026-11-24T18:00', ohen: true, termin: '2026-11-30', zakazka: 'X' }, note: 'Jen mléko' });
const p2 = parseTask(t2);
assert.equal(p2.fm.stav, 'hotovo');
assert.equal(p2.fm.hotovo, '2026-11-24T18:00');
assert.equal(p2.fm.ohen, true);
assert.equal(p2.fm.termin, '2026-11-30');
assert.equal(p2.fm.zakazka, '2612', 'zakazka nesmí aplikace měnit');
assert.equal(p2.note, 'Jen mléko');
assert.equal(p2.souvislosti, p.souvislosti);
assert.match(t2, /stav: hotovo +# otevreno \| hotovo \| zruseno/);
assert.match(t2, /zdroj: claude +# claude \| app/);

// 3 prázdná poznámka a vrácení
const t3 = applyPatch(t2, { fields: { stav: 'otevreno', hotovo: '' }, note: '' });
const p3 = parseTask(t3);
assert.equal(p3.fm.stav, 'otevreno');
assert.equal(p3.fm.hotovo, '');
assert.equal(p3.note, '');
assert.equal(p3.souvislosti, p.souvislosti);

// 4 název s dvojtečkou a číslem
const t4 = applyPatch(template, { fields: { nazev: 'Volat: Iva Rausch' } });
assert.match(t4, /nazev: "Volat: Iva Rausch"/);
assert.equal(parseTask(t4).fm.nazev, 'Volat: Iva Rausch');
assert.equal(parseTask(applyPatch(template, { fields: { nazev: '2026' } })).fm.nazev, '2026');

// 5 soubor bez pole muj_den, bez Souvislostí, CRLF, s BOM
const minimal = '﻿---\r\nnazev: Test\r\nstav: otevreno\r\nvytvoreno: 2026-11-20T08:00\r\n---\r\nText\r\n';
const t5 = applyPatch(minimal, { fields: { muj_den: '2026-11-24', ohen: true } });
const p5 = parseTask(t5);
assert.equal(p5.fm.muj_den, '2026-11-24');
assert.equal(p5.fm.ohen, true);
assert.equal(p5.note, 'Text');
assert.ok(t5.startsWith('﻿---\n'));
assert.ok(t5.indexOf('muj_den') < t5.indexOf('vytvoreno'), 'pole se vloží v pořadí formátu');

// 6 nový úkol z aplikace
const d = new Date(2026, 10, 24, 9, 5);
const nt = newTaskText({ nazev: 'Zavolat Pavlovi Výbornému', muj_den: '2026-11-24' }, d);
const pn = parseTask(nt);
assert.equal(pn.fm.zdroj, 'app');
assert.equal(pn.fm.vytvoreno, '2026-11-24T09:05');
assert.equal(pn.fm.muj_den, '2026-11-24');
assert.equal(pn.fm.ohen, false);
assert.equal(fileName('Zavolat Pavlovi Výbornému', d), '20261124-0905 zavolat-pavlovi-vybornemu.md');
assert.equal(fileName('🔥!!', d), '20261124-0905 ukol.md');

// 7 poznámka nesmí vyrobit falešné Souvislosti
const t7 = applyPatch(template, { note: 'a\n## Souvislosti\nb' });
assert.equal(parseTask(t7).souvislosti, p.souvislosti);

// 8 řazení a Můj den
const mk = (fm, name = '') => ({ name, fm: { stav: 'otevreno', ohen: false, termin: '', ...fm } });
const list = [
  mk({ vytvoreno: '2026-11-01T10:00' }, 'a'),
  mk({ termin: '2026-12-01' }, 'b'),
  mk({ ohen: true, vytvoreno: '2026-10-01T10:00' }, 'c'),
  mk({ termin: '2026-11-25' }, 'd'),
  mk({ vytvoreno: '2026-11-20T10:00' }, 'e'),
].sort(compareTasks).map((x) => x.name).join('');
assert.equal(list, 'cdbea');
assert.ok(inMyDay(mk({ termin: '2026-11-24' }), '2026-11-24'));
assert.ok(inMyDay(mk({ muj_den: '2026-11-24' }), '2026-11-24'));
assert.ok(!inMyDay(mk({ muj_den: '2026-11-23' }), '2026-11-24'));

console.log('format: všech 8 testů prošlo');
