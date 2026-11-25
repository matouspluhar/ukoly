// Formát úkolu (schema 2) podle MYSLENI/00_SYSTEM.md a čisté funkce nad ním.
// Jeden úkol = jeden .md soubor s YAML hlavičkou. Aplikace mění jen pole APP_FIELDS,
// poznámku a sekci Průběh; ostatní pole (zakazka, dalsi_krok, ceka_na, odhad…) a sekci
// „## Souvislosti“ píše Claude a aplikace je jen čte. Bez DOM – testuje se v Node.

export const APP_FIELDS = ['nazev', 'stav', 'termin', 'muj_den', 'ohen', 'hotovo'];
const FIELD_ORDER = ['schema', 'nazev', 'stav', 'termin', 'muj_den', 'navrh', 'ohen', 'zakazka', 'hotovo_kdyz', 'dalsi_krok',
  'ceka_na', 'odhad', 'castka', 'smer', 'vytvoreno', 'hotovo', 'zdroj'];
const HEAD_RE = /^##[ \t]+\S.*$/m;      // první nadpis sekce = konec poznámky
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

// Tělo: poznámka · ## Souvislosti · ## Odkazy · ## Průběh · --- · ## Původní diktát
export function splitBody(body) {
  const idx = body.search(HEAD_RE);
  const head = idx < 0 ? body : body.slice(0, idx);
  const rest = idx < 0 ? '' : body.slice(idx);
  const note = head.replace(/(\n\s*---\s*)+$/, '').trim();
  const sections = {};
  for (const m of rest.matchAll(/^##[ \t]+(.+?)[ \t]*\n([\s\S]*?)(?=^##[ \t]|(?![\s\S]))/gm)) {
    sections[m[1].trim()] = m[2].replace(/\n\s*---\s*$/, '').trim();
  }
  return { note, souvislosti: sections['Souvislosti'] || '', sections, rest };
}

// „- [Složka zakázky](https://…)“ nebo „- Notion: https://…“
export function parseLinks(section) {
  const out = [];
  for (const line of String(section || '').split('\n')) {
    let m = line.match(/^\s*[-*]\s*\[([^\]]+)\]\((\S+?)\)/);
    if (m) { out.push({ label: m[1], url: m[2] }); continue; }
    m = line.match(/^\s*[-*]\s*([^:]+?):\s*(https?:\/\/\S+)/);
    if (m) out.push({ label: m[1], url: m[2] });
  }
  return out.filter((l) => /^https?:\/\//.test(l.url));
}

// „15 min“, „1 h“, „1,5 h“, „půlden“, „den“ → minuty
export function odhadMin(v) {
  const s = String(v || '').toLowerCase().replace(',', '.').trim();
  if (!s) return 0;
  if (/^p[uů]lden/.test(s)) return 240;
  if (/^den/.test(s)) return 480;
  const m = s.match(/^([\d.]+)\s*(min|h|hod)/);
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * (m[2] === 'min' ? 1 : 60));
}

// minuty → „15 min“, „1,5 h“, „½ dne“, „den“
export function odhadLabel(min) {
  if (!min) return '';
  if (min < 60) return `${min} min`;
  if (min === 240) return '½ dne';
  if (min === 480) return 'den';
  return `${String(+(min / 60).toFixed(1)).replace('.', ',')} h`;
}

export function parseTask(text) {
  const t = normalize(text);
  const m = t.match(FM_RE);
  if (!m) {
    const b = splitBody(t);
    return { fm: { _navrh: [] }, note: b.note, souvislosti: b.souvislosti, valid: false, odkazy: [], prubeh: [] };
  }
  const fm = {};
  const navrhy = [];
  for (const line of m[2].split('\n')) {
    const mm = line.match(/^([A-Za-z_][\w-]*):(.*)$/);
    if (!mm) continue;
    const { value, comment } = splitValueComment(mm[2]);
    fm[mm[1]] = unquote(value);
    if (/N[ÁA]VRH/i.test(comment) && value) navrhy.push(mm[1]);
  }
  fm._navrh = navrhy;
  fm.ohen = String(fm.ohen).toLowerCase() === 'true';
  if (!fm.stav) fm.stav = 'otevreno';
  const b = splitBody(m[3]);
  return {
    fm, note: b.note, souvislosti: b.souvislosti, valid: true,
    odkazy: parseLinks(b.sections['Odkazy']),
    prubeh: (b.sections['Průběh'] || '').split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '').trim()).filter(Boolean),
  };
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
    const note = patch.note.replace(/\r\n?/g, '\n').trim().replace(/^(##)/gm, '\\$1');
    body = (note ? note + '\n' : '') + (rest ? (note ? '\n' : '') + rest : '');
  }
  if (patch.log) body = appendLog(body, patch.log);
  return `${bom}---\n${lines.join('\n')}\n---\n${body}`;
}

// Přidá řádek do sekce ## Průběh (založí ji před ---/Původním diktátem nebo na konci).
export function appendLog(body, line, d = new Date()) {
  const entry = `- ${localDate(d)} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} – ${line}`;
  const h = body.match(/^##[ \t]+Průběh[ \t]*$/m);
  if (h) {
    const start = h.index + h[0].length;
    const after = body.slice(start);
    const next = after.search(/^(##[ \t]|---\s*$)/m);
    const end = next < 0 ? body.length : start + next;
    const block = body.slice(start, end).replace(/\s+$/, '');
    return body.slice(0, start) + block + '\n' + entry + '\n' + (next < 0 ? '' : '\n' + body.slice(end));
  }
  const dik = body.search(/^---\s*\n##[ \t]+Původní diktát/m);
  if (dik >= 0) return body.slice(0, dik).replace(/\s+$/, '') + '\n\n## Průběh\n' + entry + '\n\n' + body.slice(dik);
  return body.replace(/\s+$/, '') + (body.trim() ? '\n\n' : '') + '## Průběh\n' + entry + '\n';
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
    'schema: 2',
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
  return appendLog(lines.join('\n') + '\n' + (note ? note.trim() + '\n\n' : '') + '## Souvislosti\n', 'založeno v aplikaci', d);
}

// Řazení: 🔥, pak termín (nejbližší), pak bez termínu podle vytvoření (nejnovější nahoře).
export function compareTasks(a, b) {
  const fa = a.fm, fb = b.fm;
  if (!!fa.ohen !== !!fb.ohen) return fa.ohen ? -1 : 1;
  if (!!fa.ceka_na !== !!fb.ceka_na) return fa.ceka_na ? 1 : -1; // čekající dolů
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

// Skupina úkolu: zakázka (číslo + název), kód oblasti, předpona názvu, jinak Ostatní.
// key = identita skupiny, num = číslo zakázky, label = název z dat, name = co se zobrazí.
const areaName = (code, names) => names[code] || (code.length > 3 ? code[0] + code.slice(1).toLowerCase() : code);
export function groupOf(t, names = {}) {
  const z = String(t.fm.zakazka || '').trim();
  const { prefix, rest } = splitPrefix(t.fm.nazev);
  if (z && !/^\d/.test(z)) {
    // Kód oblasti (HSN, PENÍZE): zkratky zůstanou, slova se píšou běžně („Peníze“).
    const strip = prefix && fold(prefix) === fold(z);
    return { key: 'z:' + z, num: '', label: z, name: areaName(z, names), title: strip ? rest : t.fm.nazev };
  }
  if (z) {
    const label = names[z] || prefix || '';
    const strip = prefix && (!names[z] || fold(names[z]).startsWith(fold(prefix)) || fold(prefix).startsWith(fold(names[z])));
    return { key: 'z:' + z, num: z, label, name: label || z, title: strip ? rest : t.fm.nazev };
  }
  if (prefix) return { key: 'p:' + fold(prefix), num: '', label: prefix, name: prefix, title: rest };
  return { key: 'ostatni', num: '', label: 'Ostatní', name: 'Ostatní', title: t.fm.nazev || '' };
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
