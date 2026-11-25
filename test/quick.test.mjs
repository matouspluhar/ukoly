import assert from 'node:assert/strict';
import { parseQuickAdd, waitingSince, daysBetween, newTaskText, parseTask } from '../js/format.js';
const names = { '2612': 'ZŠ', HSN: 'Hlavně se neposrat', 'PENÍZE': 'Peníze' };
const T = '2026-11-25'; // středa
let q = parseQuickAdd('2612 nakreslit sokl pá 2h !', T, names);
assert.deepEqual(q, { nazev: 'nakreslit sokl', zakazka: '2612', termin: '2026-11-27', odhad: '2 h', ohen: true });
q = parseQuickAdd('hsn zavolat Petrovi zítra 30 min', T, names);
assert.equal(q.zakazka, 'HSN'); assert.equal(q.termin, '2026-11-26'); assert.equal(q.odhad, '30 min'); assert.equal(q.nazev, 'zavolat Petrovi');
q = parseQuickAdd('Koupit mléko', T, names);
assert.deepEqual(q, { nazev: 'Koupit mléko', zakazka: '', termin: '', odhad: '', ohen: false });
q = parseQuickAdd('Odevzdat DPS 3. 12. půlden', T, names);
assert.equal(q.termin, '2026-12-03'); assert.equal(q.odhad, 'půlden'); assert.equal(q.nazev, 'Odevzdat DPS');
q = parseQuickAdd('Poslat fakturu 5.1.', T, names); assert.equal(q.termin, '2027-01-05');
q = parseQuickAdd('Opravit st', T, names); assert.equal(q.termin, '2026-11-25', 'dnešní den v týdnu = dnes');
q = parseQuickAdd('2612', T, names); assert.equal(q.nazev, '2612', 'samotné číslo zůstane názvem');
q = parseQuickAdd('Zkontrolovat 2 h výkresy 1,5h', T, names); assert.equal(q.odhad, '2 h'); assert.equal(q.nazev, 'Zkontrolovat výkresy 1,5h');
const nt = parseTask(newTaskText({ nazev: 'X', zakazka: '2612', odhad: '2 h', termin: '2026-11-27', ohen: true }));
assert.equal(nt.fm.zakazka, '2612'); assert.equal(nt.fm.odhad, '2 h'); assert.equal(nt.fm.termin, '2026-11-27'); assert.equal(nt.fm.ohen, true);
// čekání
const w = (fm, prubeh = []) => ({ fm: { ceka_na: 'Adam', ...fm }, prubeh });
assert.equal(waitingSince(w({ ceka_od: '2026-11-16' })), '2026-11-16');
assert.equal(waitingSince(w({ vytvoreno: '2026-11-10T08:00' }, ['2026-11-12 10:00 – založeno', '2026-11-18 09:00 – čeká na Adama (Claude)'])), '2026-11-18');
assert.equal(waitingSince(w({ vytvoreno: '2026-11-10T08:00' })), '2026-11-10');
assert.equal(waitingSince({ fm: {} }), '');
assert.equal(daysBetween('2026-11-16', '2026-11-25'), 9);
q = parseQuickAdd('Zavolat po obědě Petrovi', T, names); assert.equal(q.termin, ''); assert.equal(q.nazev, 'Zavolat po obědě Petrovi');
q = parseQuickAdd('Napsat dnes shrnutí', T, names); assert.equal(q.termin, '');
console.log('rychlé přidání a čekání OK');
