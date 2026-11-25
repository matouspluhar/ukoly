import { openStore } from './store.js';
import { createGraphBackend } from './graph.js';
import { createDemoBackend } from './demo.js';
import { Sync, makeTask } from './sync.js';
import { applyPatch, newTaskText, fileName, compareTasks, isOpen, inMyDay, localDate, localDateTime, groupOf, groupTasks, dueLabel, parseZakazky, parseTask, odhadMin } from './format.js';

export const APP_VERSION = '3.0';
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
const WIDE = matchMedia('(min-width: 1240px)');

const odhadLabel = (min) => !min ? '' : min < 60 ? `${min} min` : min === 240 ? '½ dne' : min === 480 ? 'den' : `${String(+(min / 60).toFixed(1)).replace('.', ',')} h`;
// Kód oblasti (PENÍZE, OSOBNÍ) jako běžné slovo; zkratky (HSN, TUL) a názvy ze ZAKAZKY.md beze změny.
const labelOf = (g) => g.key.startsWith('z:') && !g.num
  ? (names[g.label] || (g.label.length > 3 ? g.label[0] + g.label.slice(1).toLowerCase() : g.label))
  : (g.label || g.num);
const projName = (g) => g.key === 'ostatni' ? '' : labelOf(g);

// Řádek: název, pod ním jedna šedá řádka (zakázka · další krok / na co čeká), vpravo termín a odhad.
function rowHtml(t, title, g, today, showProj) {
  const due = dueLabel(t.fm.termin, today);
  const wait = t.fm.ceka_na;
  const krok = t.fm.dalsi_krok;
  const od = odhadLabel(odhadMin(t.fm.odhad));
  const parts = [];
  if (showProj && g && projName(g)) parts.push(`<span class="proj">${esc(projName(g))}</span>`);
  if (wait) parts.push(`čeká na ${esc(wait)}`);
  else if (krok) parts.push(`${esc(krok)}`);
  if (t.fm.navrh === today) parts.push('<span class="navrh">návrh Clauda</span>');
  const sub = parts.join('<span class="sep">·</span>');
  return `<li class="row${t.fm.ohen ? ' fire' : ''}${t.note ? ' has-note' : ''}${wait ? ' waiting' : ''}${t.id === openId ? ' sel' : ''}" data-id="${esc(t.id)}">
    <button class="check" aria-label="Hotovo"></button>
    <span class="body"><span class="title">${esc(title)}${t.fm.ohen ? ' <span class="flame" aria-label="Oheň">🔥</span>' : ''}</span>${sub ? `<span class="sub">${sub}</span>` : ''}</span>
    <span class="aside">${od ? `<span class="est">${od}</span>` : ''}<span class="due${due?.today ? ' is-today' : ''}${due?.overdue ? ' is-over' : ''}">${due ? due.text : ''}</span></span>
  </li>`;
}

let renderQueued = false;
let holdUntil = 0;     // během animace odškrtnutí nepřekreslovat
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

function sideHtml(groups) {
  return groups.map((g) => `<button class="sg${view === 'g:' + g.key ? ' active' : ''}${g.items.some(({ t }) => t.fm.ohen) ? ' fire' : ''}" data-view="g:${esc(g.key)}">
    <span class="l">${esc(labelOf(g))}${g.num && g.label ? ` <span class="num">${esc(g.num)}</span>` : ''}</span><span class="n">${g.items.length}</span></button>`).join('');
}

function renderNow() {
  const now = new Date();
  const today = localDate(now);
  const open = tasks.filter(isOpen);
  const den = open.filter((t) => inMyDay(t, today));
  const groups = groupTasks(open, names);
  if (view.startsWith('g:') && !groups.some((g) => 'g:' + g.key === view)) view = 'vse';
  const group = view.startsWith('g:') ? groups.find((g) => 'g:' + g.key === view) : null;

  document.querySelectorAll('.tab, .sv').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const setN = (id, n) => { $(id).textContent = n || ''; };
  setN('#count-den', den.length); setN('#count-vse', open.length);
  setN('#count-den-side', den.length); setN('#count-vse-side', open.length);
  const dateText = `${DNY[now.getDay()]} ${now.getDate()}. ${MES[now.getMonth()]}`;
  $('#today').textContent = dateText;
  $('#today-side').textContent = dateText;
  $('#side-groups').innerHTML = sideHtml(groups);
  $('#view-title').innerHTML = view === 'den' ? 'Můj den' : view === 'vse' ? 'Všechny'
    : `${esc(labelOf(group))}${group.num && group.label ? `<span class="num">${esc(group.num)}</span>` : ''}`;

  const doneList = view === 'den' ? doneToday(today) : view === 'vse' ? doneSince(7) : [];
  const done = doneToday(today).length;
  const total = den.length + done;
  $('#progress').hidden = view !== 'den' || total === 0;
  const zbyva = den.filter((t) => !t.fm.ceka_na).reduce((a, t) => a + odhadMin(t.fm.odhad), 0);
  $('#progress').innerHTML = `<span class="bar"><span style="width:${total ? Math.round(100 * done / total) : 0}%"></span></span><span class="lbl">${done} z ${total} hotovo${zbyva ? ` · zbývá asi ${odhadLabel(zbyva)}` : ''}</span>`;
  const fires = open.filter((t) => t.fm.ohen).length;

  let html;
  if (view === 'den') {
    html = den.length
      ? `<ul class="rows">${den.sort(compareTasks).map((t) => { const g = groupOf(t, names); return rowHtml(t, g.title, g, today, true); }).join('')}</ul>`
      : done
        ? '<p class="empty"><b>Den je hotový.</b>Všechno z Mého dne je odškrtnuté.<em>„Nic není psáno.“ — Lawrence z Arábie</em></p>'
        : '<p class="empty"><b>Prázdný den.</b>Přidej úkol nahoře nebo ho vyber ve Všech.</p>';
  } else if (group) {
    html = `<ul class="rows">${group.items.map(({ t, title }) => rowHtml(t, title, group, today, false)).join('')}</ul>`;
  } else {
    html = (fires > 3 ? `<p class="alarm"><b>${fires}× oheň.</b> Když hoří všechno, nehoří nic – vyber jeden.</p>` : '') + (open.length
      ? groups.map((g) => `
        <section class="group${g.key === 'ostatni' ? ' other' : ''}">
          <div class="g-head"><span class="g-label">${esc(labelOf(g))}</span>${g.num && g.label ? `<span class="g-num">${esc(g.num)}</span>` : ''}<span class="g-count">${g.items.length}</span></div>
          <ul class="rows">${g.items.map(({ t, title }) => rowHtml(t, title, g, today, false)).join('')}</ul>
        </section>`).join('')
      : '<p class="empty"><b>Žádné otevřené úkoly.</b>Podezřelé. Ale budiž.</p>');
  }
  if (doneList.length) {
    const rows = doneList.sort((a, b) => String(b.fm.hotovo).localeCompare(String(a.fm.hotovo))).map((t) => {
      const g = groupOf(t, names);
      const when = view === 'den' ? '' : dueLabel(doneOn(t), today);
      return `<li class="row is-done" data-id="${esc(t.id)}">
        <button class="check" aria-label="Vrátit mezi otevřené"></button>
        <span class="body"><span class="title">${esc(g.title)}</span>${view === 'vse' && projName(g) ? `<span class="sub">${esc(projName(g))}</span>` : ''}</span>
        <span class="aside">${when ? `<span class="due">${when.text}</span>` : ''}</span>
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

function setView(v) {
  if (view === v) return;
  view = v; try { localStorage.setItem('ukoly-view', view); } catch { /* nic */ }
  const l = $('#list'); l.classList.remove('view-in'); void l.offsetWidth; l.classList.add('view-in');
  scrollTo(0, 0);
  render();
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

async function updateTask(id, fields, note, log) {
  const t = tasks.find((x) => x.id === id);
  if (!t) return;
  const patch = { fields, log };
  if (typeof note === 'string') patch.note = note;
  await setLocal(makeTask(t.id, t.name, applyPatch(t.text, patch), t.eTag));
  await sync.enqueue({ type: 'update', taskId: id, fields, note: patch.note, log });
}
const dm = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${d}. ${m}.`; };

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
  if (openId && openId !== id) saveDetailText();
  openId = id;
  $('#detail').hidden = false;
  document.body.classList.add('noscroll', 'pane');
  document.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel'));
  document.querySelector(`.row[data-id="${CSS.escape(id)}"]`)?.classList.add('sel');
  renderDetail(true);
  if (!WIDE.matches) $('#detail').scrollTop = 0;
}

function renderDetail(first = false) {
  const t = tasks.find((x) => x.id === openId);
  if (!t || !isOpen(t)) { closeDetail(false); return; }
  const today = localDate();
  if (first) {
    $('#d-name').value = t.fm.nazev || '';
    requestAnimationFrame(fitName);
    $('#d-note').value = t.note || '';
    $('#d-due').value = t.fm.termin || '';
  }
  const g = groupOf(t, names);
  $('#d-group').innerHTML = g.key === 'ostatni' ? '' : `${esc(labelOf(g))}${g.num && g.label ? `<span class="g-num">${esc(g.num)}</span>` : ''}`;
  const md = t.fm.muj_den === today;
  $('#d-myday').classList.toggle('on', md); $('#d-myday').setAttribute('aria-checked', md);
  $('#d-fire').classList.toggle('on', !!t.fm.ohen); $('#d-fire').setAttribute('aria-checked', !!t.fm.ohen);
  $('#d-souv').textContent = t.souvislosti || '';
  const p = parseTask(t.text);
  const nv = (k) => (t.fm._navrh || []).includes(k) ? '<i>návrh Clauda</i>' : '';
  const plan = [['hotovo_kdyz', 'Hotovo, když'], ['dalsi_krok', 'Další krok'], ['ceka_na', 'Čeká na'], ['odhad', 'Odhad'], ['castka', 'Částka'], ['smer', 'Kdo komu']]
    .filter(([k]) => t.fm[k]).map(([k, l]) => `<dt>${l}</dt><dd>${esc(t.fm[k])}${nv(k)}</dd>`).join('');
  $('#d-plan').innerHTML = plan;
  $('#d-plan').hidden = !plan;
  $('#d-links').innerHTML = p.odkazy.map((o) => `<a href="${esc(o.url)}" target="_blank" rel="noopener">${esc(o.label)} ↗</a>`).join('');
  $('#d-links').hidden = !p.odkazy.length;
  $('#d-log').innerHTML = p.prubeh.length ? `<details><summary>Průběh · ${p.prubeh.length}</summary><ul>${p.prubeh.slice().reverse().map((l) => `<li>${esc(l)}</li>`).join('')}</ul></details>` : '';
  $('#d-meta').textContent = [t.fm.zdroj && `zdroj: ${t.fm.zdroj}`, t.fm.vytvoreno && `vytvořeno ${t.fm.vytvoreno.replace('T', ' ')}`].filter(Boolean).join(' · ');
}

function fitName() { const n = $('#d-name'); n.style.height = 'auto'; n.style.height = n.scrollHeight + 'px'; }

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
  document.body.classList.remove('noscroll', 'pane');
  document.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel'));
}

// ---------- start ----------
function bind() {
  document.querySelectorAll('.tab, .sv').forEach((b) => b.onclick = () => setView(b.dataset.view));
  $('#side-groups').onclick = (e) => { const b = e.target.closest('.sg'); if (b) setView(b.dataset.view); };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openId) { closeDetail(true); return; }
    if (e.key === 'n' && !openId && !/INPUT|TEXTAREA/.test(document.activeElement?.tagName || '')) { e.preventDefault(); $('#add-input').focus(); }
  });
  $('#add').onsubmit = (e) => { e.preventDefault(); const i = $('#add-input'); addTask(i.value); i.value = ''; };
  $('#list').onclick = (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    if (row.classList.contains('is-done')) { if (e.target.closest('.check')) reopen(row.dataset.id); return; }
    if (e.target.closest('.check')) {
      if (row.classList.contains('done')) return;
      row.classList.add('done');
      navigator.vibrate?.(12);
      holdUntil = Date.now() + 520;
      setTimeout(() => complete(row.dataset.id), 480);
    }
    else if (openId === row.dataset.id && WIDE.matches) closeDetail(true);
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
  $('#d-name').oninput = () => { fitName(); saveSoon(); };
  $('#d-note').oninput = saveSoon;
  $('#d-name').onblur = () => { clearTimeout(typing); saveDetailText(); };
  $('#d-note').onblur = () => { clearTimeout(typing); saveDetailText(); };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden' && openId) saveDetailText(); });
  $('#d-name').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } };
  $('#d-due').onchange = () => {
    const v = $('#d-due').value || '';
    updateTask(openId, { termin: v }, undefined, v ? `termín → ${dm(v)} (aplikace)` : 'termín zrušen (aplikace)');
  };
  $('#d-due-clear').onclick = () => { $('#d-due').value = ''; updateTask(openId, { termin: '' }, undefined, 'termín zrušen (aplikace)'); };
  $('#d-myday').onclick = () => {
    const t = tasks.find((x) => x.id === openId);
    updateTask(openId, { muj_den: t.fm.muj_den === localDate() ? '' : localDate() });
  };
  $('#d-fire').onclick = () => {
    const t = tasks.find((x) => x.id === openId);
    updateTask(openId, { ohen: !t.fm.ohen }, undefined, t.fm.ohen ? 'oheň vypnut (aplikace)' : 'oheň zapnut (aplikace)');
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
  $('#ver').textContent = 'v' + APP_VERSION;
  $('#add-input').placeholder = pick(PLACEHOLDERS);

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
    if (backend.canAutoLogin?.()) {
      $('#signin-msg').textContent = 'Přihlašuji…';
      $('#login').hidden = true;
      backend.login();
    }
    return;
  }
  $('#signin').hidden = true;
  sync.kick();
  loadNames();
}

main();
