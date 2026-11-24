// Formát úkolu podle MYSLENI/00_SYSTEM.md v0.4.
// Jeden úkol = jeden .md soubor s YAML hlavičkou. Aplikace mění jen
// stav, hotovo, termin, muj_den, ohen, nazev a poznámku. Sekci
// „## Souvislosti“ a pole zakazka nikdy nepřepisuje.

export const APP_FIELDS = ['nazev', 'stav', 'termin', 'muj_den', 'ohen', 'hotovo'];
const FIELD_ORDER = ['nazev', 'stav', 'termin', 'muj_den', 'ohen', 'zakazka', 'vytvoreno', 'hotovo', 'zdroj'];
const SOUV_RE = /^##[ \t]+Souvislosti[ \t]*$/m;
const FM_RE = /^(﻿?)---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/;

const pad = (n) => String(n).padStart(2, '0');
export const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const localDateTime = (d = new Date()) => `${localDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

// Rozdělí text za dvojtečkou na hodnotu a komentář (# …), včetně uvozovek.
function splitValueComment(raw) {
  const s = raw;
  const lead = s.match(/^\s*/)[0];
  const rest = s.slice(lead.length);
  if (rest.startsWith('"') || rest.startsWith("'")) {
    const q = rest[0];
    let i = 1;
    while (i < rest.length) {
      if (q === '"' && rest[i] === '\\') { i += 2; continue; }
      if (rest[i] === q) {
        if (q === "'" && rest[i + 1] === "'") { i += 2; continue; }
        break;
      }
      i++;
    }
    const quoted = rest.slice(0, i + 1);
    const after = rest.slice(i + 1);
    const cm = after.match(/^(\s+#.*)$/);
    return { value: quoted, comment: cm ? cm[1] : '' };
  }
  const cm = rest.match(/^(.*?)(\s+#.*)?$/);
  const value = rest.startsWith('#') ? '' : cm[1];
  const comment = rest.startsWith('#') ? ' ' + rest : (cm[2] || '');
  return { value: value.trim(), comment };
}

function unquote(v) {
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    try { return JSON.parse(v); } catch { return v.slice(1, -1); }
  }
  if (v.length >= 2 && v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function needsQuote(s) {
  return s === '' ? false
    : /^[\s'"!&*%@`|>{}\[\],?#-]/.test(s) || /: |:$| #|\s$/.test(s)
      || /^(true|false|null|~|yes|no|on|off|-?\d+(\.\d+)?)$/i.test(s);
}

export function formatValue(key, v) {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  const s = String(v).replace(/[\r\n]+/g, ' ');
  if (key !== 'nazev') return s;
  return needsQuote(s) ? JSON.stringify(s) : s;
}

function normalize(text) {
  return String(text ?? '').replace(/\r\n?/g, '\n');
}

export function splitBody(body) {
  const idx = body.search(SOUV_RE);
  if (idx < 0) return { note: body.trim(), souvislosti: '', rest: '' };
  const rest = body.slice(idx);
  const souv = rest.replace(SOUV_RE, '').trim();
  return { note: body.slice(0, idx).trim(), souvislosti: souv, rest };
}

export function parseTask(text) {
  const t = normalize(text);
  const m = t.match(FM_RE);
  if (!m) {
    const b = splitBody(t);
    return { fm: {}, note: b.note, souvislosti: b.souvislosti, valid: false };
  }
  const fm = {};
  for (const line of m[2].split('\n')) {
    const mm = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (!mm) continue;
    fm[mm[1]] = unquote(splitValueComment(mm[2]).value);
  }
  fm.ohen = String(fm.ohen).toLowerCase() === 'true';
  if (!fm.stav) fm.stav = 'otevreno';
  const b = splitBody(m[3]);
  return { fm, note: b.note, souvislosti: b.souvislosti, valid: true };
}

// patch = { fields: {klíč: hodnota}, note?: string }
// Přepíše jen povolená pole; zbytek souboru zůstane beze změny.
export function applyPatch(text, patch) {
  const t = normalize(text);
  let m = t.match(FM_RE);
  let bom = '', lines, body;
  if (m) { bom = m[1]; lines = m[2].split('\n'); body = m[3]; }
  else { lines = []; body = t; }

  for (const [key, val] of Object.entries(patch.fields || {})) {
    if (!APP_FIELDS.includes(key)) continue;
    const fv = formatValue(key, val);
    const idx = lines.findIndex((l) => l.startsWith(key + ':'));
    if (idx >= 0) {
      const { comment } = splitValueComment(lines[idx].slice(key.length + 1));
      lines[idx] = (fv === '' ? `${key}:` : `${key}: ${fv}`) + comment;
    } else {
      // Pole chybí: vložit podle pořadí formátu, jinak na konec.
      const order = FIELD_ORDER.indexOf(key);
      let insertAt = lines.length;
      for (let i = 0; i < lines.length; i++) {
        const k = (lines[i].match(/^([A-Za-z_][\w-]*):/) || [])[1];
        if (k && FIELD_ORDER.indexOf(k) > order) { insertAt = i; break; }
      }
      lines.splice(insertAt, 0, fv === '' ? `${key}:` : `${key}: ${fv}`);
    }
  }

  if (typeof patch.note === 'string') {
    const { rest } = splitBody(body);
    const note = patch.note.replace(/\r\n?/g, '\n').trim();
    // Poznámka nesmí sama vytvořit nadpis Souvislosti.
    const safeNote = note.replace(SOUV_RE, (h) => h.replace('##', '\\##'));
    body = (safeNote ? safeNote + '\n' : '') + (rest ? (safeNote ? '\n' : '') + rest : '');
  }
  return `${bom}---\n${lines.join('\n')}\n---\n${body}`;
}

export function slugify(name) {
  const s = String(name).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/, '');
  return s || 'ukol';
}

export function fileName(name, d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())} ${slugify(name)}.md`;
}

export function newTaskText({ nazev, muj_den = '', termin = '', ohen = false, note = '' }, d = new Date()) {
  const lines = [
    '---',
    `nazev: ${formatValue('nazev', nazev)}`.trimEnd(),
    'stav: otevreno',
    termin ? `termin: ${termin}` : 'termin:',
    muj_den ? `muj_den: ${muj_den}` : 'muj_den:',
    `ohen: ${ohen ? 'true' : 'false'}`,
    'zakazka:',
    `vytvoreno: ${localDateTime(d)}`,
    'hotovo:',
    'zdroj: app',
    '---',
  ];
  return lines.join('\n') + '\n' + (note ? note.trim() + '\n\n' : '') + '## Souvislosti\n';
}

// Řazení: 🔥, pak termín (nejbližší), pak bez termínu podle vytvoření (nejnovější nahoře).
export function compareTasks(a, b) {
  const fa = a.fm, fb = b.fm;
  if (!!fa.ohen !== !!fb.ohen) return fa.ohen ? -1 : 1;
  const ta = fa.termin || '', tb = fb.termin || '';
  if (ta && tb && ta !== tb) return ta < tb ? -1 : 1;
  if (!!ta !== !!tb) return ta ? -1 : 1;
  const va = fa.vytvoreno || a.name || '', vb = fb.vytvoreno || b.name || '';
  return va < vb ? 1 : va > vb ? -1 : 0;
}

export function isOpen(t) { return (t.fm.stav || 'otevreno') === 'otevreno'; }
export function inMyDay(t, today = localDate()) { return t.fm.muj_den === today || t.fm.termin === today; }

// ---------- skupiny podle zakázky ----------
// Soubor MYSLENI/ZAKAZKY.md: řádky „- 2620 Paseka“ nebo „- HSN Hlavně se neposrat“ (kód, mezera, název).
export function parseZakazky(text) {
  const map = {};
  for (const line of normalize(text).split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s*)?\|?\s*(\d{4}|[A-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ]{2,8})\s*[|–—:-]?\s*([^|]+?)\s*\|?\s*$/);
    if (m) map[m[1]] = m[2];
  }
  return map;
}

// „Paseka – zpracovat…“ → { prefix: 'Paseka', rest: 'zpracovat…' }
const PREFIX_RE = /^\s*([^–—\-:]{2,24}?)\s+[–—-]\s+(.+)$/;
export function splitPrefix(nazev) {
  const m = String(nazev || '').match(PREFIX_RE);
  return m ? { prefix: m[1].trim(), rest: m[2].trim() } : { prefix: '', rest: String(nazev || '') };
}

const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Skupina úkolu: zakázka (číslo + název), jinak předpona názvu, jinak Ostatní.
export function groupOf(t, names = {}) {
  const z = String(t.fm.zakazka || '').trim();
  const { prefix, rest } = splitPrefix(t.fm.nazev);
  if (z && !/^\d/.test(z)) {
    // Kód oblasti (HSN, OSOBNÍ): stačí samotný kód jako nadpis.
    const strip = prefix && fold(prefix) === fold(z);
    return { key: 'z:' + z, num: '', label: z, title: strip ? rest : t.fm.nazev };
  }
  if (z) {
    const label = names[z] || prefix || '';
    const strip = prefix && (!names[z] || fold(names[z]).startsWith(fold(prefix)) || fold(prefix).startsWith(fold(names[z])));
    return { key: 'z:' + z, num: z, label, title: strip ? rest : t.fm.nazev };
  }
  if (prefix) return { key: 'p:' + fold(prefix), num: '', label: prefix, title: rest };
  return { key: 'ostatni', num: '', label: 'Ostatní', title: t.fm.nazev || '' };
}

export function groupTasks(list, names = {}) {
  const groups = new Map();
  for (const t of [...list].sort(compareTasks)) {
    const g = groupOf(t, names);
    if (!groups.has(g.key)) groups.set(g.key, { ...g, items: [] });
    groups.get(g.key).items.push({ t, title: g.title });
  }
  // Pořadí skupin podle nejnaléhavějšího úkolu uvnitř, Ostatní na konec.
  return [...groups.values()].sort((a, b) => {
    if (a.key === 'ostatni') return 1;
    if (b.key === 'ostatni') return -1;
    return compareTasks(a.items[0].t, b.items[0].t);
  });
}

const DNY = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
export function dueLabel(termin, today = localDate()) {
  if (!termin) return null;
  const [y, m, d] = termin.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  const [ty, tm, td] = today.split('-').map(Number);
  const diff = Math.round((date - new Date(ty, tm - 1, td)) / 86400000);
  const text = diff === 0 ? 'dnes' : diff === 1 ? 'zítra' : diff > 1 && diff < 7 ? `${DNY[date.getDay()]} ${d}. ${m}.` : `${d}. ${m}.`;
  return { text, overdue: diff < 0, today: diff === 0 };
}
