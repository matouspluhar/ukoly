// Úkoly – uživatelské rozhraní. Data a pravidla formátu jsou ve format.js,
// fronta a synchronizace v sync.js, přístup k OneDrivu v graph.js (demo v demo.js).
import { openStore } from './store.js';
import { createGraphBackend } from './graph.js';
import { createDemoBackend } from './demo.js';
import { Sync, makeTask } from './sync.js';
import {
  applyPatch, newTaskText, fileName, compareTasks, isOpen, inMyDay, localDate, localDateTime,
  groupOf, groupTasks, dueLabel, parseZakazky, parseTask, odhadMin, odhadLabel,
} from './format.js';

export const APP_VERSION = '3.3';   // při změně uprav i VERSION v sw.js (hlídá test/release.test.mjs)

const DEMO = new URLSearchParams(location.search).has('demo');
const WIDE = matchMedia('(min-width: 1240px)');   // detail jako pravý panel – shodně se styles.css
const DONE_DAYS = 7;                               // hotové ve „Všech“ (OneDrive se čte za 14 dní)
const UNDO_MS = 5000;

const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* soukromý režim */ } },
};

// ---------- stav ----------
let tasks = [];
let names = {};                           // čísla a kódy → názvy ze ZAKAZKY.md
let view = store.get('ukoly-view', 'den'); // 'den' | 'vse' | 'g:<klíč skupiny>'
let openId = null;                        // úkol otevřený v detailu
let doneOpen = store.get('ukoly-done-open') === '1';
let backend, db, sync;

// ---------- texty ----------
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const DONE_LINES = [
  'Hotovo. Jedna věc z hlavy ven.',
  'Odškrtnuto. Mozek děkuje.',
  'Hotovo. Na tohle už myslet nemusíš.',
  'Splněno. Disciplína = svoboda.',
  'Vyřízeno. Dalších pět minut slávy.',
];
const PLACEHOLDERS = ['Přidat úkol', 'Co nesmíš zapomenout?', 'Co tě napadlo?'];
const DNY = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const MES = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];
const longDate = (d) => `${DNY[d.getDay()]} ${d.getDate()}. ${MES[d.getMonth()]}`;
const shortDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d}. ${m}.`; };

// ---------- odvozená data ----------
const isDone = (t) => t.fm.stav === 'hotovo';
const doneOn = (t) => String(t.fm.hotovo || '').slice(0, 10);
const doneSince = (from) => tasks.filter((t) => isDone(t) && doneOn(t) >= from)
  .sort((a, b) => String(b.fm.hotovo).localeCompare(String(a.fm.hotovo)));
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n + 1); return localDate(d); };
const nameHtml = (g) => `${esc(g.name)}${g.num && g.label ? `<span class="num">${esc(g.num)}</span>` : ''}`;

// ---------- šablony ----------
// Řádek: název (+ oheň), pod ním jedna šedá řádka (zakázka · další krok nebo na co čeká), vpravo odhad a termín.
function rowHtml(t, g, today, showGroup) {
  const due = dueLabel(t.fm.termin, today);
  const wait = t.fm.ceka_na;
  const est = odhadLabel(odhadMin(t.fm.odhad));
  const sub = [
    t.fm.navrh === today ? '<span class="navrh">návrh Clauda</span>' : '',
    showGroup && g.key !== 'ostatni' ? esc(g.name) : '',
    wait ? `čeká na ${esc(wait)}` : esc(t.fm.dalsi_krok || ''),
  ].filter(Boolean).join('<span class="sep">·</span>');
  const cls = ['row', t.fm.ohen && 'fire', t.note && 'has-note', wait && 'waiting', t.id === openId && 'sel'].filter(Boolean).join(' ');
  return `<li class="${cls}" data-id="${esc(t.id)}">
    <button class="check" aria-label="Hotovo"></button>
    <span class="body"><span class="title">${esc(g.title)}${t.fm.ohen ? ' <span class="flame" aria-label="Oheň">🔥</span>' : ''}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span>
    <span class="aside">${est ? `<span class="est">${est}</span>` : ''}<span class="due${due?.today ? ' is-today' : ''}${due?.overdue ? ' is-over' : ''}">${due ? due.text : ''}</span></span>
  </li>`;
}

function doneRowHtml(t, today, showWhen) {
  const g = groupOf(t, names);
  const when = showWhen ? dueLabel(doneOn(t), today) : null;
  return `<li class="row is-done" data-id="${esc(t.id)}">
    <button class="check" aria-label="Vrátit mezi otevřené"></button>
    <span class="body"><span class="title">${esc(g.title)}</span>${showWhen && g.key !== 'ostatni' ? `<span class="sub">${esc(g.name)}</span>` : ''}</span>
    <span class="aside"><span class="due">${when ? when.text : ''}</span></span>
  </li>`;
}

const rowsHtml = (list, today, showGroup) =>
  `<ul class="rows">${list.map((t) => rowHtml(t, groupOf(t, names), today, showGroup)).join('')}</ul>`;

function groupsHtml(groups, today) {
  return groups.map((g) => `
    <section class="group${g.key === 'ostatni' ? ' other' : ''}">
      <div class="g-head"><span class="g-label">${esc(g.name)}</span>${g.num && g.label ? `<span class="g-num">${esc(g.num)}</span>` : ''}<span class="g-count">${g.items.length}</span></div>
      ${rowsHtml(g.items.map(({ t }) => t), today, false)}
    </section>`).join('');
}

function doneHtml(list, today, label, showWhen) {
  if (!list.length) return '';
  return `<details class="done-list"${doneOpen ? ' open' : ''}>
    <summary><span>${label}</span><span class="g-count">${list.length}</span></summary>
    <ul class="rows">${list.map((t) => doneRowHtml(t, today, showWhen)).join('')}</ul></details>`;
}

const sideHtml = (groups) => groups.map((g) => `<button class="sg${view === 'g:' + g.key ? ' active' : ''}${g.items.some(({ t }) => t.fm.ohen) ? ' fire' : ''}" data-view="g:${esc(g.key)}">
  <span class="l">${nameHtml(g)}</span><span class="n">${g.items.length}</span></button>`).join('');

// ---------- vykreslení ----------
let renderQueued = false;
let holdUntil = 0;   // během animace odškrtnutí nepřekreslovat
let lastList = '';
let lastSide = '';

function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const wait = holdUntil - Date.now();
    if (wait > 0) setTimeout(render, wait);
    else renderNow();
  });
}

function renderNow() {
  const now = new Date();
  const today = localDate(now);
  const open = tasks.filter(isOpen);
  const den = open.filter((t) => inMyDay(t, today)).sort(compareTasks);
  const groups = groupTasks(open, names);
  let group = null;
  if (view.startsWith('g:')) {
    group = groups.find((g) => 'g:' + g.key === view);
    if (!group) view = 'vse';   // skupina zmizela (poslední úkol hotový)
  }
  const doneToday = doneSince(today);

  // navigace a záhlaví
  $$('.tab, .sv').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $$('[data-count="den"]').forEach((el) => { el.textContent = den.length || ''; });
  $$('[data-count="vse"]').forEach((el) => { el.textContent = open.length || ''; });
  $$('[data-today]').forEach((el) => { el.textContent = longDate(now); });
  const side = sideHtml(groups);
  if (side !== lastSide) { $('#side-groups').innerHTML = side; lastSide = side; }
  $('#view-title').innerHTML = view === 'den' ? 'Můj den' : view === 'vse' ? 'Všechny' : nameHtml(group);

  // průběh dne
  const total = den.length + doneToday.length;
  const left = den.filter((t) => !t.fm.ceka_na).reduce((a, t) => a + odhadMin(t.fm.odhad), 0);
  $('#progress').hidden = view !== 'den' || total === 0;
  $('#progress').innerHTML = `<span class="bar"><span style="width:${total ? Math.round(100 * doneToday.length / total) : 0}%"></span></span>`
    + `<span class="lbl">${doneToday.length} z ${total} hotovo${left ? ` · zbývá asi ${odhadLabel(left)}` : ''}</span>`;

  // seznam
  let html;
  if (view === 'den') {
    html = den.length ? rowsHtml(den, today, true)
      : doneToday.length ? '<p class="empty"><b>Den je hotový.</b>Všechno z Mého dne je odškrtnuté.<em>„Nic není psáno.“ — Lawrence z Arábie</em></p>'
        : '<p class="empty"><b>Prázdný den.</b>Přidej úkol nahoře nebo ho vyber ve Všech.</p>';
    html += doneHtml(doneToday, today, 'Hotovo dnes', false);
  } else if (group) {
    html = rowsHtml(group.items.map(({ t }) => t), today, false);
  } else {
    const fires = open.filter((t) => t.fm.ohen).length;
    html = (fires > 3 ? `<p class="alarm"><b>${fires}× oheň.</b> Když hoří všechno, nehoří nic – vyber jeden.</p>` : '')
      + (open.length ? groupsHtml(groups, today) : '<p class="empty"><b>Žádné otevřené úkoly.</b>Podezřelé. Ale budiž.</p>')
      + doneHtml(doneSince(daysAgo(DONE_DAYS)), today, 'Hotovo za týden', true);
  }
  if (html !== lastList) { $('#list').innerHTML = html; lastList = html; }
  if (openId) renderDetail();
}

function setView(v) {
  if (view === v) return;
  view = v;
  store.set('ukoly-view', v);
  const l = $('#list'); l.classList.remove('view-in'); void l.offsetWidth; l.classList.add('view-in');
  scrollTo(0, 0);
  render();
}

const STATUS = {
  sync: (s, el) => el.textContent || 'Synchronizuji…',
  ok: (s) => `Synchronizováno ${s.at ? s.at.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : ''}`,
  offline: () => 'Offline – píšu si to bokem',
  auth: () => 'Přihlášení vypršelo – klikni sem',
  retry: () => 'Server nestíhá – zkusím znovu',
  error: (s) => `Pozor: ${s.msg || 'chyba'} – klikni sem`,
};
function setStatus(s) {
  const el = $('#status');
  el.textContent = (STATUS[s.state]?.(s, el) || '') + (s.pending ? ` · čeká ${s.pending}` : '');
  el.dataset.state = s.state;
  $('#refresh').classList.toggle('spin', s.state === 'sync');
}

let toastTimer = null;
function showToast(msg, action = null, ms = UNDO_MS) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${action ? `<button>${esc(action.label)}</button>` : ''}`;
  el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { el.hidden = true; action.run(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

// ---------- změny úkolů (vždy nejdřív místně, pak do fronty) ----------
const find = (id) => tasks.find((x) => x.id === id);

async function setLocal(t) {
  await db.put('tasks', t);
  tasks = tasks.filter((x) => x.id !== t.id).concat(t);
  render();
}
const patched = (t, patch) => makeTask(t.id, t.name, applyPatch(t.text, patch), t.eTag);

async function addTask(title) {
  const nazev = title.trim();
  if (!nazev) return;
  const now = new Date();
  const tempId = `tmp-${now.getTime()}-${Math.random().toString(36).slice(2, 6)}`;
  const text = newTaskText({ nazev, muj_den: view === 'den' ? localDate(now) : '' }, now);
  const filename = fileName(nazev, now);
  await setLocal(makeTask(tempId, filename, text, null));
  await sync.enqueue({ type: 'create', tempId, filename, text });
}

async function updateTask(id, fields, { note, log, confirm } = {}) {
  const t = find(id);
  if (!t) return;
  await setLocal(patched(t, { fields, note, log, confirm }));
  await sync.enqueue({ type: 'update', taskId: id, fields, note, log, confirm });
}

// Potvrzení návrhu Clauda: hodnota zůstane, zmizí jen „# NÁVRH“.
function confirmProposals(keys) {
  const labels = keys.map((k) => PLAN.find(([pk]) => pk === k)?.[1].toLowerCase() || k).join(', ');
  updateTask(openId, {}, { confirm: keys, log: `návrh potvrzen: ${labels} (aplikace)` });
}

async function complete(id) {
  const before = find(id);
  if (!before) return;
  const at = localDateTime();
  await setLocal(patched(before, { fields: { stav: 'hotovo', hotovo: at } }));
  const seq = await sync.enqueue({ type: 'done', taskId: id, at, notBefore: Date.now() + UNDO_MS });
  showToast(pick(DONE_LINES), { label: 'Vrátit', run: async () => { if (await sync.cancel(seq)) await setLocal(before); } });
}

async function reopen(id) {
  const t = find(id);
  if (!t) return;
  await setLocal(patched(t, { fields: { stav: 'otevreno', hotovo: '' } }));
  await sync.enqueue({ type: 'reopen', taskId: id });
  showToast('Vráceno mezi otevřené. Stává se.');
}

// Odškrtnutí: krátká animace v řádku, pak zápis (seznam se mezitím nepřekreslí).
function checkRow(row) {
  if (row.classList.contains('done')) return;
  row.classList.add('done');
  navigator.vibrate?.(12);
  holdUntil = Date.now() + 520;
  setTimeout(() => complete(row.dataset.id), 480);
}

async function loadNames() {
  names = parseZakazky(await db.getMeta('zakazky', ''));
  try {
    const text = await backend.zakazky();
    await db.setMeta('zakazky', text);
    names = parseZakazky(text);
    render();
  } catch { /* offline – zůstanou uložené názvy */ }
}

// ---------- detail ----------
function openDetail(id) {
  if (openId && openId !== id) saveDetailText();
  openId = id;
  $('#detail').hidden = false;
  document.body.classList.add('pane');
  document.body.classList.toggle('noscroll', !WIDE.matches);
  $$('.row.sel').forEach((r) => r.classList.remove('sel'));
  $(`.row[data-id="${CSS.escape(id)}"]`)?.classList.add('sel');
  renderDetail(true);
  $('#detail').scrollTop = 0;
}

async function closeDetail(save = true) {
  if (save) await saveDetailText();
  openId = null;
  $('#detail').hidden = true;
  document.body.classList.remove('pane', 'noscroll');
  $$('.row.sel').forEach((r) => r.classList.remove('sel'));
}

const PLAN = [['hotovo_kdyz', 'Hotovo, když'], ['dalsi_krok', 'Další krok'], ['ceka_na', 'Čeká na'], ['odhad', 'Odhad'], ['castka', 'Částka'], ['smer', 'Kdo komu']];

function renderDetail(first = false) {
  const t = find(openId);
  if (!t || !isOpen(t)) { closeDetail(false); return; }
  const today = localDate();
  if (first) {   // textová pole jen při otevření, ať se nepřepisuje rozepsaný text
    $('#d-name').value = t.fm.nazev || '';
    $('#d-note').value = t.note || '';
    $('#d-due').value = t.fm.termin || '';
    requestAnimationFrame(fitName);
  }
  const g = groupOf(t, names);
  const p = parseTask(t.text);
  $('#d-group').innerHTML = g.key === 'ostatni' ? '' : nameHtml(g);
  setSwitch('#d-myday', t.fm.muj_den === today);
  setSwitch('#d-fire', !!t.fm.ohen);
  const proposed = PLAN.map(([k]) => k).filter((k) => t.fm[k] && (t.fm._navrh || []).includes(k));
  const navrh = (k) => proposed.includes(k) ? `<button class="navrh-ok" data-confirm="${k}" title="Potvrdit návrh">návrh Clauda · potvrdit</button>` : '';
  const plan = PLAN.filter(([k]) => t.fm[k]).map(([k, l]) => `<dt>${l}</dt><dd>${esc(t.fm[k])}${navrh(k)}</dd>`).join('')
    + (proposed.length > 1 ? `<dt></dt><dd><button class="link" data-confirm="${proposed.join(',')}">Potvrdit všechny návrhy</button></dd>` : '');
  $('#d-plan').innerHTML = plan;
  $('#d-plan').hidden = !plan;
  $('#d-links').innerHTML = p.odkazy.map((o) => `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.label)} ↗</a>`).join('');
  $('#d-links').hidden = !p.odkazy.length;
  $('#d-souv').textContent = t.souvislosti || '';
  $('#d-log').innerHTML = p.prubeh.length
    ? `<details><summary>Průběh · ${p.prubeh.length}</summary><ul>${p.prubeh.slice().reverse().map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>` : '';
  $('#d-meta').textContent = [t.fm.zdroj && `zdroj: ${t.fm.zdroj}`, t.fm.vytvoreno && `vytvořeno ${t.fm.vytvoreno.replace('T', ' ')}`].filter(Boolean).join(' · ');
}

function setSwitch(sel, on) { const b = $(sel); b.classList.toggle('on', on); b.setAttribute('aria-checked', on); }
function fitName() { const n = $('#d-name'); n.style.height = 'auto'; n.style.height = n.scrollHeight + 'px'; }

async function saveDetailText() {
  const t = find(openId);
  if (!t) return;
  const nazev = $('#d-name').value.trim();
  const note = $('#d-note').value.trim();
  const fields = nazev && nazev !== t.fm.nazev ? { nazev } : {};
  const noteChanged = note !== (t.note || '');
  if (fields.nazev || noteChanged) await updateTask(t.id, fields, { note: noteChanged ? note : undefined });
}

function setDue(v) {
  updateTask(openId, { termin: v }, { log: v ? `termín → ${shortDate(v)} (aplikace)` : 'termín zrušen (aplikace)' });
}

// ---------- události ----------
function bind() {
  $$('.tab, .sv').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  $('#side-groups').onclick = (e) => { const b = e.target.closest('.sg'); if (b) setView(b.dataset.view); };
  $('#add').onsubmit = (e) => { e.preventDefault(); const i = $('#add-input'); addTask(i.value); i.value = ''; };

  $('#list').onclick = (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const onCheck = !!e.target.closest('.check');
    if (row.classList.contains('is-done')) { if (onCheck) reopen(row.dataset.id); }
    else if (onCheck) checkRow(row);
    else if (openId === row.dataset.id && WIDE.matches) closeDetail();
    else openDetail(row.dataset.id);
  };
  $('#list').addEventListener('toggle', (e) => {
    if (!e.target.matches('.done-list')) return;
    doneOpen = e.target.open;
    store.set('ukoly-done-open', doneOpen ? '1' : '0');
  }, true);

  $('#refresh').onclick = refreshAll;
  $('#status').onclick = async () => {
    if ($('#status').dataset.state === 'auth') return backend.reauth();
    const dead = await db.getMeta('dead', []);
    if (dead.length) {
      await db.setMeta('dead', []);
      showToast(`${dead.length} změn nešlo zapsat – soubor mezitím zmizel nebo se změnil. Obnovuji stav z OneDrivu.`, null, 12000);
    }
    sync.kick();
  };
  $('#login').onclick = () => backend.login();
  $('#logout').onclick = () => { if (confirm('Odhlásit?')) backend.logout(); };

  // detail
  $('#d-back').onclick = () => closeDetail();
  $('#d-done').onclick = async () => { const id = openId; await closeDetail(); complete(id); };
  let typing = null;
  const saveSoon = () => { clearTimeout(typing); typing = setTimeout(saveDetailText, 900); };
  const saveNow = () => { clearTimeout(typing); saveDetailText(); };
  $('#d-name').oninput = () => { fitName(); saveSoon(); };
  $('#d-name').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
  $('#d-name').onblur = saveNow;
  $('#d-note').oninput = saveSoon;
  $('#d-note').onblur = saveNow;
  $('#d-plan').onclick = (e) => { const b = e.target.closest('[data-confirm]'); if (b) confirmProposals(b.dataset.confirm.split(',')); };
  $('#d-due').onchange = () => setDue($('#d-due').value || '');
  $('#d-due-clear').onclick = () => { $('#d-due').value = ''; setDue(''); };
  $('#d-myday').onclick = () => updateTask(openId, { muj_den: find(openId).fm.muj_den === localDate() ? '' : localDate() });
  $('#d-fire').onclick = () => {
    const on = !find(openId).fm.ohen;
    updateTask(openId, { ohen: on }, { log: on ? 'oheň zapnut (aplikace)' : 'oheň vypnut (aplikace)' });
  };
  WIDE.addEventListener('change', () => { if (openId) document.body.classList.toggle('noscroll', !WIDE.matches); });

  // klávesnice: N = nový úkol, Esc = zavřít detail
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openId) closeDetail();
    else if (e.key === 'n' && !openId && !e.ctrlKey && !e.metaKey && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) {
      e.preventDefault(); $('#add-input').focus();
    }
  });

  // synchronizace: návrat do aplikace, síť, minutový tik, půlnoc
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { render(); sync.kick(); }
    else if (openId) saveDetailText();
  });
  addEventListener('online', () => sync.kick());
  addEventListener('offline', () => setStatus({ state: 'offline' }));
  setInterval(() => { if (document.visibilityState === 'visible') sync.kick(); }, 60000);
  scheduleMidnight();
  pullToRefresh();
}

function refreshAll() { sync.kick(); loadNames(); }

function pullToRefresh() {
  let y0 = null, dy = 0;
  const icon = $('#refresh');
  addEventListener('touchstart', (e) => { y0 = scrollY <= 0 && !openId ? e.touches[0].clientY : null; dy = 0; }, { passive: true });
  addEventListener('touchmove', (e) => {
    if (y0 === null) return;
    dy = Math.max(0, e.touches[0].clientY - y0);
    icon.style.transform = `rotate(${Math.min(dy, 120) * 3}deg)`;
  }, { passive: true });
  addEventListener('touchend', () => {
    if (y0 !== null && dy > 80) { navigator.vibrate?.(8); refreshAll(); }
    icon.style.transform = ''; y0 = null;
  });
}

// Můj den se o půlnoci vyprázdní – stačí překreslit, data se nemění.
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => { render(); scheduleMidnight(); }, next - now);
}

// Nová verze: service worker ji stáhne na pozadí, uživatel jen klepne na „Načíst“.
function watchUpdates(reg) {
  const offer = () => showToast('Nová verze Úkolů je připravená.', { label: 'Načíst', run: () => location.reload() }, 12000);
  if (reg.waiting && navigator.serviceWorker.controller) offer();
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => { if (w.state === 'activated' && navigator.serviceWorker.controller) offer(); });
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
}

// ---------- start ----------
async function main() {
  if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('./sw.js').then(watchUpdates).catch(console.warn);
  navigator.storage?.persist?.().catch(() => {}); // Android nesmaže offline frontu při nedostatku místa
  document.body.classList.toggle('demo', DEMO);
  backend = DEMO ? createDemoBackend() : createGraphBackend();
  db = await openStore(DEMO ? 'ukoly-demo' : 'ukoly');
  sync = new Sync(backend, db, { onTasks: (t) => { tasks = t; render(); }, onStatus: setStatus });
  bind();
  $('#ver').textContent = 'v' + APP_VERSION;
  $('#add-input').placeholder = pick(PLACEHOLDERS);

  // okamžitě z místní paměti, pak přihlášení a synchronizace
  tasks = await db.all('tasks');
  names = parseZakazky(await db.getMeta('zakazky', ''));
  render();

  let signed = false;
  try { signed = await backend.init(); } catch (e) { console.error(e); }
  $('#who').textContent = backend.userName();
  if (!signed) {
    $('#signin').hidden = false;
    // Prohlížeč zahodil přihlášení (MSAL v4 po zavření okna bez „Zůstat přihlášeni“):
    // známý účet přihlásíme znovu sami, jednou za relaci, bez výběru účtu.
    if (backend.canAutoLogin()) {
      $('#signin-msg').textContent = 'Přihlašuji…';
      $('#login').hidden = true;
      backend.login();
    }
    return;
  }
  $('#signin').hidden = true;
  refreshAll();
}

main();
