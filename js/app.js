import { openStore } from './store.js';
import { createGraphBackend } from './graph.js';
import { createDemoBackend } from './demo.js';
import { Sync, makeTask } from './sync.js';
import { applyPatch, newTaskText, fileName, compareTasks, isOpen, inMyDay, localDate, localDateTime, groupOf, groupTasks, dueLabel, parseZakazky } from './format.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let tasks = [];
let view = localStorage.getItem('ukoly-view') || 'den';
let openId = null;
let backend, db, sync;
let names = {};

// ---------- drobné radosti ----------
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const DONE_LINES = [
  'Hotovo. Jedna věc z hlavy ven.',
  'Odškrtnuto. Mozek děkuje.',
  'Hotovo. Na tohle už myslet nemusíš.',
  'Splněno. Disciplína = svoboda.',
  'Vyřízeno. Dalších pět minut slávy.',
  'Hotovo. Razítko sedí.',
];
const PLACEHOLDERS = ['Přidat úkol', 'Co nesmíš zapomenout?', 'Co tě napadlo?', 'Přidat úkol'];
const isDone = (t) => t.fm.stav === 'hotovo';
const doneOn = (t) => String(t.fm.hotovo || '').slice(0, 10);
const doneToday = (today = localDate()) => tasks.filter((t) => isDone(t) && doneOn(t) === today);
const doneSince = (days) => {
  const d = new Date(); d.setDate(d.getDate() - days + 1);
  const from = localDate(d);
  return tasks.filter((t) => isDone(t) && doneOn(t) >= from);
};
let doneOpen = localStorage.getItem('ukoly-done-open') === '1';

// ---------- vykreslení ----------
const DNY = ['neděle', 'pondělí', 'úterý', 'středa', 'čtvrtek', 'pátek', 'sobota'];
const MES = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];

function rowHtml(t, title, cap, today) {
  const due = dueLabel(t.fm.termin, today);
  return `<li class="row${t.fm.ohen ? ' fire' : ''}${t.note ? ' has-note' : ''}" data-id="${esc(t.id)}">
    <button class="check" aria-label="Hotovo"></button>
    <span class="body">${cap ? `<span class="cap">${cap}</span>` : ''}<span class="title">${esc(title)}</span></span>
    ${t.fm.ohen ? '<span class="flame" aria-label="Oheň">🔥</span>' : ''}
    ${due ? `<span class="due${due.today ? ' is-today' : ''}${due.overdue ? ' is-over' : ''}">${due.text}</span>` : ''}
  </li>`;
}

function capOf(g, t, today) {
  const navrh = t && t.fm.navrh === today ? '<i>návrh Clauda</i>' : '';
  if (g.key === 'ostatni') return navrh.replace('<i>', '<i class="solo">');
  return `${g.num ? `<b>${esc(g.num)}</b>` : ''}${esc(g.label)}${navrh}`;
}

let renderQueued = false;
let holdUntil = 0;     // během animace razítka nepřekreslovat
let lastHtml = '';
function render() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const wait = holdUntil - Date.now();
    if (wait > 0) { setTimeout(render, wait); return; }
    renderNow();
  });
}

function renderNow() {
  const now = new Date();
  const today = localDate(now);
  const open = tasks.filter(isOpen);
  const den = open.filter((t) => inMyDay(t, today));
  document.body.classList.toggle('wide', view === 'vse');
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#count-den').textContent = den.length || '';
  $('#count-vse').textContent = open.length || '';
  $('#today').textContent = `${DNY[now.getDay()]} ${now.getDate()}. ${MES[now.getMonth()]}`;

  let html;
  const doneList = view === 'den' ? doneToday(today) : doneSince(7);
  const done = doneToday(today).length;
  const total = den.length + done;
  $('#progress').hidden = view !== 'den' || total === 0;
  $('#progress').innerHTML = `<span class="bar"><span style="width:${total ? Math.round(100 * done / total) : 0}%"></span></span><span class="lbl">${done} z ${total}</span>`;
  $('#progress').classList.toggle('full', total > 0 && den.length === 0);
  const fires = open.filter((t) => t.fm.ohen).length;

  if (view === 'den') {
    html = den.length
      ? `<ul class="rows">${den.sort(compareTasks).map((t) => { const g = groupOf(t, names); return rowHtml(t, g.title, capOf(g, t, today), today); }).join('')}</ul>`
      : done
        ? '<p class="empty win"><span class="stamp big">Den<br>dobyt</span><em>„Nic není psáno.“ — Lawrence z Arábie</em></p>'
        : '<p class="empty"><b>Prázdný den.</b>Buď klid před bouří, nebo plán ještě spí.<br>Přidej úkol nahoře nebo ho vyber ve Všech.</p>';
  } else {
    html = (fires > 3 ? `<p class="alarm">🔥 ${fires}× oheň. To už není oheň, to je požár.</p>` : '') + (open.length
      ? groupTasks(open, names).map((g) => `
        <section class="group${g.key === 'ostatni' ? ' other' : ''}">
          <div class="g-head">${g.num ? `<span class="g-num">${esc(g.num)}</span>` : ''}<span class="g-label">${esc(g.label)}</span><span class="g-count">${g.items.length}</span></div>
          <ul class="rows">${g.items.map(({ t, title }) => rowHtml(t, title, '', today)).join('')}</ul>
        </section>`).join('')
      : '<p class="empty"><b>Žádné otevřené úkoly.</b>Podezřelé. Ale budiž.</p>');
  }
  if (doneList.length) {
    const rows = doneList.sort((a, b) => String(b.fm.hotovo).localeCompare(String(a.fm.hotovo))).map((t) => {
      const g = groupOf(t, names);
      const when = view === 'den' ? '' : dueLabel(doneOn(t), today);
      return `<li class="row is-done" data-id="${esc(t.id)}">
        <button class="check" aria-label="Vrátit mezi otevřené"></button>
        <span class="body">${view === 'vse' && g.key !== 'ostatni' ? `<span class="cap">${capOf(g)}</span>` : ''}<span class="title">${esc(g.title)}</span></span>
        ${when ? `<span class="due">${when.text}</span>` : ''}
      </li>`;
    }).join('');
    html += `<details class="done-list"${doneOpen ? ' open' : ''}>
      <summary><span>Hotovo${view === 'den' ? ' dnes' : ' za týden'}</span><span class="g-count">${doneList.length}</span></summary>
      <ul class="rows">${rows}</ul></details>`;
  }
  if (html !== lastHtml) { $('#list').innerHTML = html; lastHtml = html; }
  const det = $('#list .done-list');
  if (det) det.ontoggle = () => { doneOpen = det.open; try { localStorage.setItem('ukoly-done-open', doneOpen ? '1' : '0'); } catch { /* nic */ } };
  if (openId) renderDetail();
}

async function loadNames() {
  const cached = await db.getMeta('zakazky', '');
  names = parseZakazky(cached);
  try {
    const text = await backend.zakazky();
    await db.setMeta('zakazky', text);
    names = parseZakazky(text);
    render();
  } catch (e) { /* offline – zůstanou uložené názvy */ }
}

function setStatus(s) {
  const el = $('#status');
  const p = s.pending ? ` · čeká ${s.pending}` : '';
  const map = {
    sync: el.textContent || 'Synchronizuji…',
    ok: `Synchronizováno ${s.at ? s.at.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : ''}${p}`,
    offline: `Offline – píšu si to bokem${p}`,
    auth: `Přihlášení vypršelo${p} – klikni sem`,
    retry: `Server nestíhá – zkusím znovu${p}`,
    error: `Pozor: ${s.msg || 'chyba'}${p} – klikni sem`,
  };
  el.textContent = map[s.state] || '';
  $('#refresh').classList.toggle('spin', s.state === 'sync');
  el.dataset.state = s.state;
}

// ---------- akce ----------
async function setLocal(t) {
  await db.put('tasks', t);
  tasks = tasks.filter((x) => x.id !== t.id).concat(t);
  render();
}

async function addTask(title) {
  const nazev = title.trim();
  if (!nazev) return;
  const now = new Date();
  const tempId = 'tmp-' + now.getTime() + '-' + Math.random().toString(36).slice(2, 6);
  const text = newTaskText({ nazev, muj_den: view === 'den' ? localDate() : '' }, now);
  const filename = fileName(nazev, now);
  await setLocal(makeTask(tempId, filename, text, null));
  await sync.enqueue({ type: 'create', tempId, filename, text });
}

async function updateTask(id, fields, note) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  const patch = { fields };
  if (typeof note === 'string') patch.note = note;
  await setLocal(makeTask(t.id, t.name, applyPatch(t.text, patch), t.eTag));
  await sync.enqueue({ type: 'update', taskId: id, fields, note: patch.note });
}

let toastTimer = null;
async function complete(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  const at = localDateTime();
  const before = t;
  await setLocal(makeTask(t.id, t.name, applyPatch(t.text, { fields: { stav: 'hotovo', hotovo: at } }), t.eTag));
  const seq = await sync.enqueue({ type: 'done', taskId: id, at, notBefore: Date.now() + 5000 });
  render();
  showToast(pick(DONE_LINES), async () => {
    if (await sync.cancel(seq)) await setLocal(before);
  });
}

async function reopen(id) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  await setLocal(makeTask(t.id, t.name, applyPatch(t.text, { fields: { stav: 'otevreno', hotovo: '' } }), t.eTag));
  await sync.enqueue({ type: 'reopen', taskId: id });
  showToast('Vráceno mezi otevřené. Stává se.');
}

function showToast(msg, undo, label = 'Vrátit') {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? `<button>${esc(label)}</button>` : ''}`;
  el.hidden = false;
  if (undo) el.querySelector('button').onclick = () => { el.hidden = true; undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, label === 'Vrátit' ? 5000 : 12000);
}

// ---------- detail ----------
function openDetail(id) {
  openId = id;
  $('#detail').hidden = false;
  document.body.classList.add('noscroll');
  renderDetail(true);
}

function renderDetail(first = false) {
  const t = tasks.find((x) => x.id === openId);
  if (!t || !isOpen(t)) { closeDetail(false); return; }
  const today = localDate();
  if (first) {
    $('#d-name').value = t.fm.nazev || '';
    $('#d-note').value = t.note || '';
    $('#d-due').value = t.fm.termin || '';
  }
  const g = groupOf(t, names);
  $('#d-group').innerHTML = g.key === 'ostatni' ? '' : `${g.num ? `<b>${esc(g.num)}</b>` : ''}${esc(g.label)}`;
  const md = t.fm.muj_den === today;
  $('#d-myday').classList.toggle('on', md); $('#d-myday').setAttribute('aria-checked', md);
  $('#d-fire').classList.toggle('on', !!t.fm.ohen); $('#d-fire').setAttribute('aria-checked', !!t.fm.ohen);
  $('#d-souv').textContent = t.souvislosti || '';
  $('#d-meta').textContent = [t.fm.zdroj && `zdroj: ${t.fm.zdroj}`, t.fm.vytvoreno && `vytvořeno ${t.fm.vytvoreno.replace('T', ' ')}`].filter(Boolean).join(' · ');
}

async function saveDetailText() {
  const t = tasks.find((x) => x.id === openId);
  if (!t) return;
  const nazev = $('#d-name').value.trim();
  const note = $('#d-note').value.trim();
  const fields = {};
  if (nazev && nazev !== t.fm.nazev) fields.nazev = nazev;
  const noteChanged = note !== (t.note || '');
  if (Object.keys(fields).length || noteChanged) await updateTask(t.id, fields, noteChanged ? note : undefined);
}

async function closeDetail(save = true) {
  if (save) await saveDetailText();
  openId = null;
  $('#detail').hidden = true;
  document.body.classList.remove('noscroll');
}

// ---------- start ----------
function bind() {
  document.querySelectorAll('.tab').forEach((b) => b.onclick = () => {
    if (view === b.dataset.view) return;
    view = b.dataset.view; localStorage.setItem('ukoly-view', view);
    const l = $('#list'); l.classList.remove('switch'); void l.offsetWidth; l.classList.add('switch');
    render();
  });
  $('#add').onsubmit = (e) => { e.preventDefault(); const i = $('#add-input'); addTask(i.value); i.value = ''; };
  $('#list').onclick = (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (row.classList.contains('is-done')) { if (e.target.closest('.check')) reopen(row.dataset.id); return; }
    if (e.target.closest('.check')) {
      if (row.classList.contains('done')) return;
      row.classList.add('done');
      row.insertAdjacentHTML('beforeend', '<span class="stamp">Hotovo</span>');
      navigator.vibrate?.(12);
      holdUntil = Date.now() + 700;
      setTimeout(() => complete(row.dataset.id), 650);
    }
    else openDetail(row.dataset.id);
  };
  $('#refresh').onclick = () => { sync.kick(); loadNames(); };
  $('#status').onclick = async () => {
    const st = $('#status').dataset.state;
    if (st === 'auth') return backend.reauth();
    const dead = await db.getMeta('dead', []);
    if (dead.length) {
      console.table(dead.map((d) => ({ typ: d.op.type, ukol: d.op.taskId || d.op.filename, chyba: d.status, kdy: d.at })));
      await db.setMeta('dead', []);
      showToast(`${dead.length} změn nešlo zapsat – soubor mezitím zmizel nebo se změnil. Obnovuji stav z OneDrivu.`);
    }
    sync.kick();
  };
  $('#d-back').onclick = () => closeDetail(true);
  $('#d-done').onclick = async () => { const id = openId; await closeDetail(true); complete(id); };
  let typing = null;
  const saveSoon = () => { clearTimeout(typing); typing = setTimeout(saveDetailText, 900); };
  $('#d-name').oninput = saveSoon;
  $('#d-note').oninput = saveSoon;
  $('#d-name').onblur = () => { clearTimeout(typing); saveDetailText(); };
  $('#d-note').onblur = () => { clearTimeout(typing); saveDetailText(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && openId) saveDetailText(); });
  $('#d-name').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
  $('#d-due').onchange = () => updateTask(openId, { termin: $('#d-due').value || '' });
  $('#d-due-clear').onclick = () => { $('#d-due').value = ''; updateTask(openId, { termin: '' }); };
  $('#d-myday').onclick = () => {
    const t = tasks.find((x) => x.id === openId);
    updateTask(openId, { muj_den: t.fm.muj_den === localDate() ? '' : localDate() });
  };
  $('#d-fire').onclick = () => {
    const t = tasks.find((x) => x.id === openId);
    updateTask(openId, { ohen: !t.fm.ohen });
  };
  $('#login').onclick = () => backend.login();
  $('#logout').onclick = () => { if (confirm('Odhlásit?')) backend.logout(); };

  pullToRefresh();
  window.addEventListener('online', () => sync.kick());
  window.addEventListener('offline', () => setStatus({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); sync.kick(); } });
  setInterval(() => { if (document.visibilityState === 'visible') sync.kick(); }, 60000);
  scheduleMidnight();
}

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
    if (y0 !== null && dy > 80) { navigator.vibrate?.(8); sync.kick(); loadNames(); }
    icon.style.transform = ''; y0 = null;
  });
}

// Nová verze aplikace: service worker ji stáhne na pozadí, uživatel jen klepne.
function watchUpdates(reg) {
  const offer = () => showToast('Nová verze Úkolů je připravená.', () => location.reload(), 'Načíst');
  if (reg.waiting && navigator.serviceWorker.controller) offer();
  reg.addEventListener('updatefound', () => {
    const w = reg.installing;
    w?.addEventListener('statechange', () => { if (w.state === 'activated' && navigator.serviceWorker.controller) offer(); });
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') reg.update().catch(() => {}); });
}

// Můj den se o půlnoci vyprázdní – stačí překreslit, data se nemění.
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => { render(); scheduleMidnight(); }, next - now);
}

async function main() {
  if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('./sw.js').then(watchUpdates).catch(console.warn);
  navigator.storage?.persist?.().catch(() => {}); // Android nesmaže offline frontu při nedostatku místa
  if (DEMO) document.body.classList.add('demo');
  backend = DEMO ? createDemoBackend() : createGraphBackend();
  db = await openStore(DEMO ? 'ukoly-demo' : 'ukoly');
  sync = new Sync(backend, db, { onTasks: (t) => { tasks = t; render(); }, onStatus: setStatus });
  bind();
  $('#add-input').placeholder = pick(PLACEHOLDERS);

  tasks = await db.all('tasks');
  names = parseZakazky(await db.getMeta('zakazky', ''));
  render();

  let signed = false;
  try { signed = await backend.init(); } catch (e) { console.error(e); }
  $('#who').textContent = backend.userName();
  if (!signed) { $('#signin').hidden = false; return; }
  $('#signin').hidden = true;
  sync.kick();
  loadNames();
}

main();
