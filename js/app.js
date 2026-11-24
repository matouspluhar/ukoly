import { openStore } from './store.js';
import { createGraphBackend } from './graph.js';
import { createDemoBackend } from './demo.js';
import { Sync, makeTask } from './sync.js';
import { applyPatch, newTaskText, fileName, compareTasks, isOpen, inMyDay, localDate, localDateTime } from './format.js';

const DEMO = new URLSearchParams(location.search).has('demo');
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let tasks = [];
let view = localStorage.getItem('ukoly-view') || 'den';
let openId = null;
let backend, db, sync;

// ---------- vykreslení ----------
function render() {
  const today = localDate();
  const open = tasks.filter(isOpen);
  const list = (view === 'den' ? open.filter((t) => inMyDay(t, today)) : open).sort(compareTasks);
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  $('#count-den').textContent = open.filter((t) => inMyDay(t, today)).length || '';
  $('#count-vse').textContent = open.length || '';
  $('#list').innerHTML = list.length
    ? list.map((t) => `
      <li class="row${t.fm.ohen ? ' fire' : ''}" data-id="${esc(t.id)}">
        <button class="check" aria-label="Hotovo"></button>
        <span class="name">${esc(t.fm.nazev || t.name.replace(/\.md$/, ''))}</span>
        ${t.fm.ohen ? '<span class="flame" aria-label="Oheň">🔥</span>' : ''}
        ${t.fm.zakazka ? `<span class="job">${esc(t.fm.zakazka)}</span>` : ''}
      </li>`).join('')
    : `<li class="empty">${view === 'den' ? 'Můj den je prázdný.' : 'Žádné otevřené úkoly.'}</li>`;
  if (openId) renderDetail();
}

function setStatus(s) {
  const el = $('#status');
  const p = s.pending ? ` · čeká ${s.pending}` : '';
  const map = {
    sync: 'Synchronizuji…',
    ok: `Synchronizováno ${s.at ? s.at.toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit' }) : ''}${p}`,
    offline: `Offline${p}`,
    auth: `Přihlášení vypršelo${p} – klikni sem`,
    error: `Chyba: ${s.msg || ''}${p}`,
  };
  el.textContent = map[s.state] || '';
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
  showToast(`Hotovo: ${before.fm.nazev}`, async () => {
    if (await sync.cancel(seq)) await setLocal(before);
  });
}

function showToast(msg, undo) {
  const el = $('#toast');
  el.innerHTML = `<span>${esc(msg)}</span>${undo ? '<button>VRÁTIT</button>' : ''}`;
  el.hidden = false;
  if (undo) el.querySelector('button').onclick = () => { el.hidden = true; undo(); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5000);
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
  $('#d-myday').textContent = t.fm.muj_den === today ? 'ODEBRAT Z MÉHO DNE' : 'PŘIDAT DO MÉHO DNE';
  $('#d-myday').classList.toggle('on', t.fm.muj_den === today);
  $('#d-fire').classList.toggle('on', !!t.fm.ohen);
  $('#d-job').textContent = t.fm.zakazka ? `Zakázka ${t.fm.zakazka}` : '';
  $('#d-souv').textContent = t.souvislosti || '—';
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
    view = b.dataset.view; localStorage.setItem('ukoly-view', view); render();
  });
  $('#add').onsubmit = (e) => { e.preventDefault(); const i = $('#add-input'); addTask(i.value); i.value = ''; };
  $('#list').onclick = (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (e.target.closest('.check')) { row.classList.add('done'); setTimeout(() => complete(row.dataset.id), 180); }
    else openDetail(row.dataset.id);
  };
  $('#refresh').onclick = () => sync.kick();
  $('#status').onclick = () => { if ($('#status').dataset.state === 'auth') backend.reauth(); else sync.kick(); };
  $('#d-back').onclick = () => closeDetail(true);
  $('#d-done').onclick = async () => { const id = openId; await closeDetail(true); complete(id); };
  $('#d-name').onblur = saveDetailText;
  $('#d-note').onblur = saveDetailText;
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

  window.addEventListener('online', () => sync.kick());
  window.addEventListener('offline', () => setStatus({ state: 'offline' }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { render(); sync.kick(); } });
  setInterval(() => { if (document.visibilityState === 'visible') sync.kick(); }, 60000);
  scheduleMidnight();
}

// Můj den se o půlnoci vyprázdní – stačí překreslit, data se nemění.
function scheduleMidnight() {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 5);
  setTimeout(() => { render(); scheduleMidnight(); }, next - now);
}

async function main() {
  if ('serviceWorker' in navigator && !DEMO) navigator.serviceWorker.register('./sw.js').catch(console.warn);
  if (DEMO) document.body.classList.add('demo');
  backend = DEMO ? createDemoBackend() : createGraphBackend();
  db = await openStore(DEMO ? 'ukoly-demo' : 'ukoly');
  sync = new Sync(backend, db, { onTasks: (t) => { tasks = t; render(); }, onStatus: setStatus });
  bind();

  tasks = await db.all('tasks');
  render();

  let signed = false;
  try { signed = await backend.init(); } catch (e) { console.error(e); }
  $('#who').textContent = backend.userName();
  if (!signed) { $('#signin').hidden = false; return; }
  $('#signin').hidden = true;
  sync.kick();
}

main();
