import assert from 'node:assert/strict';
import { parseTask, applyPatch, appendLog, odhadMin, newTaskText } from '../js/format.js';

const v2 = `---
schema: 2
nazev: Paseka – zpracovat skutečné provedení stavby
stav: otevreno
muj_den: 2026-11-24
ohen: false
zakazka: 2620
hotovo_kdyz: PD stávajícího domu odevzdaná úřadu      # NÁVRH
dalsi_krok: Zkontrolovat zaměření od Ivy               # NÁVRH
ceka_na: geometrický plán dělení pozemku
odhad: půlden                                           # NÁVRH
vytvoreno: 2026-11-24T17:11
hotovo:
zdroj: claude
---
Převzato z To Do.

## Souvislosti
- [[2620 Paseka]] přes [[Iva Rausch]].

## Odkazy
- [Notion – 2620](https://www.notion.so/40623979f455816891cce35b3f40106d)
- OneDrive: https://onswerk2026-my.sharepoint.com/x
- rozbité: nic

## Průběh
- 2026-11-24 17:11 – založeno

---
## Původní diktát
Paseka skutečné provedení.
`;
const p = parseTask(v2);
assert.equal(p.note, 'Převzato z To Do.');
assert.equal(p.souvislosti, '- [[2620 Paseka]] přes [[Iva Rausch]].');
assert.deepEqual(p.fm._navrh, ['hotovo_kdyz', 'dalsi_krok', 'odhad']);
assert.equal(p.fm.ceka_na, 'geometrický plán dělení pozemku');
assert.equal(p.odkazy.length, 2);
assert.equal(p.odkazy[0].label, 'Notion – 2620');
assert.deepEqual(p.prubeh, ['2026-11-24 17:11 – založeno']);

// zápis z aplikace: poznámka + řádek do Průběhu, nic dalšího se nehne
const d = new Date(2026, 10, 25, 9, 5);
const t2 = applyPatch(v2, { fields: { ohen: true }, note: 'Nová poznámka', log: 'oheň zapnut (aplikace)' });
const p2 = parseTask(t2.replace(/2026-11-2\d \d\d:\d\d – oheň/, '2026-11-25 09:05 – oheň'));
assert.equal(p2.note, 'Nová poznámka');
assert.equal(p2.fm.ohen, true);
assert.equal(p2.souvislosti, p.souvislosti);
assert.equal(p2.odkazy.length, 2);
assert.equal(p2.prubeh.length, 2);
assert.match(p2.prubeh[1], /oheň zapnut \(aplikace\)$/);
assert.match(t2, /hotovo_kdyz: PD stávajícího domu odevzdaná úřadu +# NÁVRH/);
assert.ok(t2.includes('## Původní diktát\nPaseka skutečné provedení.'));

// Průběh se založí před Původním diktátem
const old = '---\nnazev: X\nstav: otevreno\n---\nText\n\n## Souvislosti\nA\n\n---\n## Původní diktát\nx\n';
const t3 = applyPatch(old, { fields: { stav: 'hotovo' }, log: 'hotovo (aplikace)' });
assert.ok(t3.indexOf('## Průběh') < t3.indexOf('## Původní diktát'));
assert.equal(parseTask(t3).souvislosti, 'A');
assert.equal(parseTask(t3).prubeh.length, 1);
assert.equal(parseTask(t3).note, 'Text');

// starý soubor bez sekcí
const t4 = appendLog('Jen text\n', 'x', d);
assert.equal(t4, 'Jen text\n\n## Průběh\n- 2026-11-25 09:05 – x\n');

// odhad
assert.equal(odhadMin('15 min'), 15); assert.equal(odhadMin('1 h'), 60); assert.equal(odhadMin('1,5 h'), 90);
assert.equal(odhadMin('půlden'), 240); assert.equal(odhadMin('den'), 480); assert.equal(odhadMin(''), 0);

// nový úkol z aplikace má schema 2 a Průběh
const n = parseTask(newTaskText({ nazev: 'Test' }, d));
assert.equal(n.fm.schema, '2'); assert.equal(n.prubeh.length, 1);

// poznámka s nadpisem nevyrobí sekci
assert.equal(parseTask(applyPatch(v2, { note: '## Odkazy\n- [x](https://x.cz)' })).odkazy.length, 2);
console.log('format v2: testy prošly');
