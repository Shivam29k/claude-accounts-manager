import { ago, axisStep, chartBins, clock, compact, esc, modelInfo, nameOf, plan, untilText } from './lib.js';

const $ = (s) => document.querySelector(s);

// Chart colours (validated for contrast and colour-blind separation on the dark surface).
const PAL = ['#C15F3C', '#3F7FC4', '#6F8F3A', '#8A6FD8', '#B08A1E'];
const OTHER = '#5F5E5A';
// Model view groups by family; each family keeps one colour.
const FAMILY = { opus: ['Opus', PAL[0]], sonnet: ['Sonnet', PAL[1]], haiku: ['Haiku', PAL[2]], fable: ['Fable', PAL[3]] };

const ICON_GRIP = '<svg viewBox="0 0 12 12" fill="currentColor"><circle cx="4" cy="2.5" r="1.1"/><circle cx="8" cy="2.5" r="1.1"/><circle cx="4" cy="6" r="1.1"/><circle cx="8" cy="6" r="1.1"/><circle cx="4" cy="9.5" r="1.1"/><circle cx="8" cy="9.5" r="1.1"/></svg>';
const ICON_CLOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/></svg>';
const ICON_DOTS = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';

let S = null; // /api/state
let T = null; // /api/tokens
let range = localStorage.getItem('cam.range') || '7d';
let view = localStorage.getItem('cam.view') || 'accounts';
let editing = false, renaming = false, drag = null, swallowClick = false, relogin = null, logAll = false;

async function call(path, body) {
  const init = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CAM': '1' }, body: JSON.stringify(body) };
  const r = await fetch(path, init);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `Server answered ${r.status}`), { data: j });
  return j;
}

function toast(msg, ms = 2600) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const t = document.createElement('div');
  t.className = 'toast';
  t.setAttribute('role', 'status');
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

// An account's switch-away limit: its own, or the global threshold.
const limitOf = (a) => a.threshold ?? S.settings.threshold;
const level = (pct, limit) => (pct >= limit ? 'over' : pct >= limit - 10 ? 'near' : '');

// Table columns: 5-hour, weekly, then per-model limits, from whatever the accounts report.
function columns() {
  const cols = new Map();
  for (const a of S.accounts) {
    for (const m of a.meters) {
      if (cols.has(m.id)) continue;
      const label = m.cat === 'session' ? '5-hour' : m.cat === 'weekly' ? 'Weekly' : m.label.replace(/^Weekly, /, '');
      cols.set(m.id, { id: m.id, cat: m.cat, label });
    }
  }
  const rank = (c) => (c.cat === 'session' ? 0 : c.cat === 'weekly' ? 1 : 2);
  return [...cols.values()].sort((x, y) => rank(x) - rank(y) || x.label.localeCompare(y.label)).slice(0, 4);
}

const tightest = (a) => a.meters.filter((m) => S.settings.watch[m.cat] && m.active).sort((x, y) => y.pct - x.pct)[0] || null;

// ---------- page ----------

function render() {
  const s = S.settings;
  const active = S.accounts.find((a) => a.id === S.activeId);
  const t = active && tightest(active);
  $('#status').innerHTML = active
    ? `Using <b>${esc(nameOf(active))}</b>${t?.resetsAt ? ` · resets ${esc(untilText(t.resetsAt))}` : ''}`
    : S.liveUnknown ? `Using <b>${esc(S.liveUnknown.email)}</b> · not saved` : S.accounts.length ? 'Not signed in' : 'No accounts yet';

  let alerts = '';
  if (S.liveUnknown) alerts += `<div class="alert attn"><span>Claude Code is signed in as <b>${esc(S.liveUnknown.email)}</b>, which isn’t saved.</span><button class="btn primary" data-act="import">Save</button></div>`;
  for (const w of S.health) alerts += `<div class="alert">${esc(w)}</div>`;
  const room = S.accounts.some((a) => a.id !== S.activeId && !a.excluded && !a.authError && a.loadPct != null && a.loadPct < limitOf(a));
  if (s.autoSwitch && active && active.loadPct >= limitOf(active) && !room) alerts += `<div class="alert">Every account is past its limit. Staying on ${esc(nameOf(active))} until a limit resets.</div>`;
  $('#alerts').innerHTML = alerts;

  if (!editing) {
    $('#autoSwitch').checked = s.autoSwitch;
    $('#threshold').value = s.threshold;
    $('#thVal').textContent = `${s.threshold}%`;
    document.querySelectorAll('[data-watch]').forEach((el) => (el.checked = !!s.watch[el.dataset.watch]));
    document.querySelectorAll('[name=strategy]').forEach((el) => (el.checked = el.value === s.strategy));
    document.querySelectorAll('[name=warmup]').forEach((el) => (el.checked = el.value === s.warmup));
  }
  $('#pill').classList.toggle('off', !s.autoSwitch);
  const models = columns().filter((c) => c.cat === 'scoped').map((c) => c.label);
  $('#scopedName').textContent = models.length ? models.join(', ') : 'Per-model';

  if (!drag && !renaming) renderTable();
  $('#checked').textContent = `Checked ${ago(Math.max(0, ...S.accounts.map((a) => a.usageAt || 0)))}`;
  renderLog();
}

// "resets in 2h 41m" under each bar; the exact time is in the tooltip.
function resetLine(m, idle) {
  if (idle) return '<div class="mc-reset">not started</div>';
  if (!m?.resetsAt) return '<div class="mc-reset">&nbsp;</div>';
  const when = untilText(m.resetsAt);
  return `<div class="mc-reset">${when === 'now' ? 'resetting now' : `resets ${esc(when)}`}</div>`;
}
const resetClock = (iso) => new Date(iso).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });

function meterCell(a, c) {
  const m = a.meters.find((x) => x.id === c.id);
  if (!m && c.cat === 'session' && a.sessionIdle) {
    return `<div class="mc" title="5-hour window not started"><div class="mc-top"><span class="mc-k">${esc(c.label)}</span><b class="idle">Idle</b></div><div class="bar"></div>${resetLine(null, true)}</div>`;
  }
  if (!m) return `<div class="mc off"><div class="mc-top"><span class="mc-k">${esc(c.label)}</span><b>–</b></div><div class="bar"></div>${resetLine(null)}</div>`;
  const counted = S.settings.watch[m.cat] && m.active;
  const lv = counted ? level(m.pct, limitOf(a)) : '';
  const idle = m.cat === 'session' && a.sessionIdle;
  const title = idle ? '5-hour window not started' : `${c.label}: ${Math.round(m.pct)}% used${m.resetsAt ? `, resets ${resetClock(m.resetsAt)}` : ''}${counted ? '' : ' (not watched)'}`;
  return `<div class="mc ${m.active ? '' : 'off'}" title="${esc(title)}">
    <div class="mc-top"><span class="mc-k">${esc(c.label)}</span>${idle ? '<b class="idle">Idle</b>' : `<b class="num ${lv}">${Math.round(m.pct)}%</b>`}</div>
    <div class="bar"><i class="${lv}" style="width:${Math.min(100, Math.max(0, m.pct))}%"></i>${counted && S.settings.autoSwitch ? `<s style="left:${limitOf(a)}%"></s>` : ''}</div>
    ${resetLine(m, idle)}
  </div>`;
}

function renderTable() {
  const cols = columns();
  $('#accounts').style.setProperty('--cols', `minmax(220px, 2fr) repeat(${cols.length}, minmax(80px, 1fr)) 84px 28px`);
  $('#thead').innerHTML = `<span>Account</span>${cols.map((c) => `<span>${esc(c.label)}</span>`).join('')}<span></span><span></span>`;
  $('#rows').innerHTML =
    S.accounts
      .map((a) => {
        const live = a.id === S.activeId;
        const tags = [
          plan(a) && `<span class="tag">${esc(plan(a))}</span>`,
          a.extraUsage && '<span class="tag warn" title="Past the plan limit this account bills extra usage instead of stopping. Turn it off in claude.ai settings.">Extra usage</span>',
          a.excluded && '<span class="tag skip">Skipped</span>',
          a.threshold != null && `<span class="tag" title="Auto-switch leaves this account at ${a.threshold}% (default ${S.settings.threshold}%)">Limit ${a.threshold}%</span>`,
          a.warmupOn && `<span class="tag ico ${a.warmupError ? 'warn' : ''}" title="${esc(a.warmupError ? `Auto-start failed: ${a.warmupError}` : 'Auto-start: this account’s 5-hour window starts automatically when it isn’t running')}" aria-label="Auto-start">${ICON_CLOCK}</span>`,
        ].filter(Boolean).join('');
        const cells = a.authError ? `<span class="gone" style="grid-column: span ${cols.length}">Signed out</span>` : cols.map((c) => meterCell(a, c)).join('');
        const action = live ? '<span class="live-dot">Active</span>'
          : a.authError ? `<button class="btn primary" data-act="relogin" data-id="${a.id}">Sign in</button>`
          : `<button class="btn" data-act="switch" data-id="${a.id}">Switch</button>`;
        return `<div class="tr row ${live ? 'live' : ''} ${a.excluded ? 'skip' : ''}" data-row="${a.id}">
          <div class="nm"><span class="grip" aria-hidden="true">${ICON_GRIP}</span><div class="nm-text">
            <div class="nm-line"><b data-rename="${a.id}" title="Double-click to rename">${esc(nameOf(a))}</b>${tags}</div>
            <div class="nm-mail" title="${esc(a.email)}${a.orgName ? `, ${esc(a.orgName)}` : ''}">${esc(a.email)}</div>
          </div></div>
          ${cells}
          <div class="act">${action}</div>
          <button class="dots" data-menu="${a.id}" aria-label="More for ${esc(nameOf(a))}" aria-haspopup="menu">${ICON_DOTS}</button>
          <div class="br"></div>
        </div>`;
      })
      .join('') || '<div class="tr row"><span style="color:var(--text-3)">Add a Claude account to start.</span></div>';
}

function eventLine(e) {
  const d = e.data || {};
  const nm = (id, fallback) => {
    const a = S.accounts.find((x) => x.id === id);
    return a ? nameOf(a) : fallback || 'removed account';
  };
  if (e.type === 'switch' && d.to) return [`${d.from ? `${nm(d.from, d.fromName)} → ` : ''}${nm(d.to, d.toName)}`, d.auto ? `Auto · ${d.pct}%` : ''];
  if (d.kind === 'limited') return ['Sign-in rate-limited', d.until ? `Retry ${clock(new Date(d.until))}` : ''];
  if (d.kind === 'failed') return ['Sign-in failed', e.msg];
  if (d.kind === 'added') return [`Added ${nm(d.id, d.name)}`, ''];
  if (d.kind === 'relogin') return [`Signed in again: ${nm(d.id, d.name)}`, ''];
  if (d.kind === 'removed') return [`Removed ${d.name}`, ''];
  if (d.kind === 'signedout') return [`${nm(d.id, d.name)} signed out`, 'Sign in again'];
  if (d.kind === 'external') return [`Claude Code switched to ${nm(d.id, d.name)}`, 'Outside the app'];
  if (d.kind === 'stuck') return ['Nowhere to switch', `${nm(d.id, d.name)} at ${d.pct}%`];
  if (d.kind === 'warmup') return [`Started 5-hour window: ${nm(d.id, d.name)}`, 'Auto-start'];
  if (d.kind === 'warmupFailed') return [`Couldn’t start 5-hour window: ${nm(d.id, d.name)}`, d.error || ''];
  return [e.msg, ''];
}

function renderLog() {
  const events = logAll ? S.events : S.events.slice(0, 6);
  $('#log').innerHTML =
    events
      .map((e) => {
        const d = new Date(e.ts);
        const today = d.toDateString() === new Date().toDateString();
        const [main, extra] = eventLine(e);
        return `<li><time datetime="${d.toISOString()}">${today ? clock(d) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</time><span>${esc(main)}${extra ? `<em>${esc(extra)}</em>` : ''}</span></li>`;
      })
      .join('') || '<li><span></span><span style="color:var(--text-3)">Nothing yet</span></li>';
  $('#logMore').hidden = logAll || S.events.length <= 6;
}

// ---------- token chart ----------

// Series definitions for the current view: how to key a raw id, its name, colour and stack order.
function seriesFor(byModel) {
  if (byModel) {
    const versions = {}, extra = [];
    return {
      key(id) {
        const { fam, ver } = modelInfo(id);
        if (fam === 'other') return 'other';
        if (!FAMILY[fam] && !extra.includes(fam)) {
          if (extra.length) return 'other'; // a second unknown family folds into Other
          extra.push(fam);
        }
        (versions[fam] ||= new Set()).add(ver);
        return fam;
      },
      name: (k) => (k === 'other' ? 'Other' : `${FAMILY[k]?.[0] || k[0].toUpperCase() + k.slice(1)} ${[...versions[k]].sort((x, y) => parseFloat(y) - parseFloat(x)).join(', ')}`),
      color: (k) => (k === 'other' ? OTHER : FAMILY[k]?.[1] || PAL[4]),
      order: (tot) => ['other', 'opus', 'sonnet', 'haiku', 'fable', ...extra].filter((k) => tot[k]),
    };
  }
  // Accounts in table order, each with its own colour. "Other" is usage from before tracking began,
  // from removed accounts, or from accounts past the fifth colour.
  const known = new Map(S.accounts.filter((a) => a.colorIdx < PAL.length).map((a) => [a.id, a]));
  return {
    key: (id) => (known.has(id) ? id : 'other'),
    name: (k) => (k === 'other' ? 'Other' : nameOf(known.get(k))),
    color: (k) => (k === 'other' ? OTHER : PAL[known.get(k).colorIdx]),
    order: (tot) => [...(tot.other ? ['other'] : []), ...S.accounts.filter((a) => known.has(a.id) && tot[a.id]).map((a) => a.id)],
  };
}

function renderChart() {
  if (!S || !T) return;
  const { out: bins, every, span } = chartBins(range, T.first);
  const byModel = view === 'models';
  const ser = seriesFor(byModel);
  for (const b of bins) b.v = {};
  let j = 0;
  for (const [t, row] of (byModel ? T.models : T.hours) || []) {
    while (j < bins.length && t >= bins[j].e) j++;
    if (j >= bins.length) break;
    if (t < bins[j].s) continue;
    for (const [id, n] of Object.entries(row)) {
      const k = ser.key(id);
      bins[j].v[k] = (bins[j].v[k] || 0) + n;
    }
  }
  const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
  const totals = {};
  for (const b of bins) for (const [k, n] of Object.entries(b.v)) totals[k] = (totals[k] || 0) + n;
  const series = ser.order(totals);
  $('#tokTotal').textContent = T.ready ? compact(sum(totals)) : '–';
  $('#tokSpan').textContent = span;
  document.querySelectorAll('#ranges button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.range === range)));
  document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === view)));

  const plot = $('#plot');
  const max = Math.max(0, ...bins.map((b) => sum(b.v)));
  if (!T.ready || !max) {
    plot.innerHTML = `<div class="empty-plot">${T.ready ? 'No Claude Code usage in this range' : 'Reading Claude Code transcripts…'}</div>`;
    $('#xl').innerHTML = $('#legend').innerHTML = $('#tokTable').innerHTML = '';
    return;
  }
  const { step, top } = axisStep(max);
  let grid = '';
  for (let i = 1; i <= 3; i++) grid += `<div class="grid" style="bottom:${(i / 3) * 100}%"><span>${compact(step * i)}</span></div>`;
  grid += '<div class="grid" style="bottom:0"><span>0</span></div>';
  plot.innerHTML = `${grid}<div class="bins">${bins
    .map((b, i) => {
      const segs = series.filter((k) => b.v[k]).map((k) => `<i style="flex:${b.v[k]} 1 0;background:${ser.color(k)}"></i>`).join('');
      return `<div class="bin" data-i="${i}" tabindex="0" aria-label="${esc(`${b.tip}: ${compact(sum(b.v))} tokens`)}"><div class="stack" style="height:${(sum(b.v) / top) * 100}%">${segs}</div></div>`;
    })
    .join('')}</div>`;
  $('#xl').innerHTML = bins.map((b, i) => `<span>${(bins.length - 1 - i) % every === 0 ? esc(b.label) : ''}</span>`).join('');
  $('#legend').innerHTML = series.slice().reverse().map((k) => `<span><i style="background:${ser.color(k)}"></i>${esc(ser.name(k))} <b>${compact(totals[k])}</b></span>`).join('');
  $('#tokTable').innerHTML =
    `<caption>Tokens per period</caption><tr><th>Period</th>${series.map((k) => `<th>${esc(ser.name(k))}</th>`).join('')}</tr>` +
    bins.map((b) => `<tr><td>${esc(b.tip)}</td>${series.map((k) => `<td>${b.v[k] || 0}</td>`).join('')}</tr>`).join('');

  // Hover / focus tooltip: every series in that bar, value first.
  const tip = $('#tip');
  const show = (bin, x, y) => {
    const b = bins[+bin.dataset.i];
    const rows = series.slice().reverse().filter((k) => b.v[k]);
    plot.classList.add('hovering');
    plot.querySelectorAll('.bin.on').forEach((n) => n.classList.remove('on'));
    bin.classList.add('on');
    tip.replaceChildren();
    const head = document.createElement('div');
    head.className = 't';
    head.textContent = `${b.tip} · ${compact(sum(b.v))}`;
    tip.append(head);
    for (const k of rows) {
      const r = document.createElement('div');
      r.className = 'r';
      const key = document.createElement('i');
      key.style.background = ser.color(k);
      const v = document.createElement('b');
      v.textContent = compact(b.v[k]);
      const n = document.createElement('span');
      n.textContent = ser.name(k);
      r.append(key, v, n);
      tip.append(r);
    }
    if (!rows.length) {
      const r = document.createElement('div');
      r.className = 'r';
      r.textContent = 'No usage';
      tip.append(r);
    }
    tip.hidden = false;
    tip.style.left = `${Math.min(innerWidth - tip.offsetWidth - 8, Math.max(8, x + 14))}px`;
    tip.style.top = `${Math.max(8, y - tip.offsetHeight - 12)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    plot.classList.remove('hovering');
    plot.querySelectorAll('.bin.on').forEach((n) => n.classList.remove('on'));
  };
  plot.onpointermove = (e) => {
    const bin = e.target.closest('.bin');
    if (bin) show(bin, e.clientX, e.clientY);
    else hide();
  };
  plot.onpointerleave = hide;
  plot.onfocusin = (e) => {
    const bin = e.target.closest('.bin');
    if (!bin) return;
    const r = bin.getBoundingClientRect();
    show(bin, r.left + r.width / 2, r.top + 40);
  };
  plot.onfocusout = hide;
}

async function loadTokens() {
  try {
    T = await call(`/api/tokens?range=${range}`);
    renderChart();
  } catch {}
}
$('#views').onclick = (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  view = b.dataset.view;
  localStorage.setItem('cam.view', view);
  renderChart();
};
$('#ranges').onclick = (e) => {
  const b = e.target.closest('[data-range]');
  if (!b) return;
  range = b.dataset.range;
  localStorage.setItem('cam.range', range);
  loadTokens();
};

async function load() {
  if (drag || renaming) return;
  try {
    S = await call('/api/state');
    render();
    renderChart();
  } catch (e) {
    $('#status').textContent = `Can’t reach the server: ${e.message}`;
  }
}

// ---------- row menu ----------

const menu = $('#menu');
let menuOpen = null, menuTimer = 0;
function openMenu(btn) {
  const a = S.accounts.find((x) => x.id === btn.dataset.menu);
  if (!a) return;
  const items = [
    !a.authError && ['refresh', 'Refresh usage'],
    ['exclude', a.excluded ? 'Include in auto-switch' : 'Skip in auto-switch'],
    ['limit', a.threshold != null ? `Custom limit: ${a.threshold}%` : 'Custom limit…'],
    S.settings.warmup === 'all' ? ['', 'Auto-start 5h: on for all accounts', 'disabled'] : ['warmup', a.warmup ? 'Stop auto-starting 5h window' : 'Auto-start 5h window'],
    ['relogin', 'Sign in again'],
    ['remove', 'Remove', 'danger'],
  ].filter(Boolean);
  menu.innerHTML = items
    .map(([act, label, cls]) => (cls === 'disabled' ? `<button role="menuitem" disabled>${label}</button>` : `<button role="menuitem" class="${cls || ''}" data-act="${act}" data-id="${a.id}">${label}</button>`))
    .join('');
  clearTimeout(menuTimer);
  menu.classList.add('shut');
  menu.hidden = false;
  menuOpen = btn.dataset.menu;
  const r = btn.getBoundingClientRect();
  const up = r.bottom + menu.offsetHeight + 8 > innerHeight;
  menu.classList.toggle('up', up);
  menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  menu.style.top = `${up ? r.top - menu.offsetHeight - 4 : r.bottom + 4}px`;
  void menu.offsetWidth; // start from the "shut" state, then animate in
  menu.classList.remove('shut');
  menu.querySelector('button').focus({ preventScroll: true });
}
// "Custom limit…" turns the open menu into a small slider for that account's switch-away limit.
function openLimitEditor(a) {
  const cur = a.threshold ?? S.settings.threshold;
  menu.innerHTML = `<div class="lim">
    <div class="lim-h">Switch away from <b>${esc(nameOf(a))}</b> at</div>
    <div class="lim-r"><input type="range" id="limRange" min="10" max="100" step="1" value="${cur}" aria-label="Limit for ${esc(nameOf(a))}"><output id="limOut" class="num">${cur}%</output></div>
    <div class="lim-b">
      <button class="btn" data-act="limit-default" data-id="${a.id}"${a.threshold == null ? ' disabled' : ''}>Use default (${S.settings.threshold}%)</button>
      <button class="btn primary" data-act="limit-save" data-id="${a.id}">Save</button>
    </div>
  </div>`;
  const range = $('#limRange');
  range.oninput = () => ($('#limOut').textContent = `${range.value}%`);
  range.onkeydown = (e) => e.key === 'Enter' && menu.querySelector('[data-act="limit-save"]').click();
  // Keep the menu on screen at its new size.
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(8, Math.min(innerWidth - menu.offsetWidth - 8, r.right - menu.offsetWidth))}px`;
  if (r.top + menu.offsetHeight + 8 > innerHeight) menu.style.top = `${Math.max(8, innerHeight - menu.offsetHeight - 8)}px`;
  range.focus();
}

function closeMenu() {
  if (!menuOpen) return;
  menuOpen = null;
  menu.classList.add('shut');
  menuTimer = setTimeout(() => (menu.hidden = true), 180);
}
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeMenu());
addEventListener('scroll', closeMenu, { passive: true });

// ---------- actions ----------

document.addEventListener(
  'click',
  async (ev) => {
    if (swallowClick) {
      swallowClick = false;
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }
    const m = ev.target.closest('[data-menu]');
    if (m) return menuOpen === m.dataset.menu ? closeMenu() : openMenu(m);
    const el = ev.target.closest('[data-act]');
    if (ev.target.closest('#menu') && !el) return; // clicks inside the limit editor
    const { act, id } = el?.dataset || {};
    const a = S.accounts.find((x) => x.id === id);
    if (act === 'limit') return openLimitEditor(a);
    closeMenu();
    if (!el) return;
    try {
      if (act === 'add') return openSheet();
      if (act === 'relogin') return openSheet(a);
      if (act === 'switch') {
        el.disabled = true;
        el.textContent = '…';
        await call('/api/switch', { id });
        toast(`Switched to ${nameOf(a)}`);
      } else if (act === 'refresh') {
        await call('/api/refresh', { id });
        toast('Usage refreshed');
      } else if (act === 'exclude') {
        await call('/api/account', { id, excluded: !a.excluded });
      } else if (act === 'limit-save' || act === 'limit-default') {
        const value = act === 'limit-default' ? null : Number($('#limRange').value);
        await call('/api/account', { id, threshold: value });
        toast(value == null ? `${nameOf(a)} uses the default limit (${S.settings.threshold}%)` : `${nameOf(a)}: auto-switch leaves at ${value}%`);
      } else if (act === 'warmup') {
        await call('/api/account', { id, warmup: !a.warmup });
        toast(a.warmup ? `Stopped auto-starting ${nameOf(a)}` : `${nameOf(a)}’s 5-hour window will start automatically`);
      } else if (act === 'remove') {
        if (!confirm(`Remove ${nameOf(a)}? Claude Code keeps its current login.`)) return;
        await call('/api/account/remove', { id });
        toast(`Removed ${nameOf(a)}`);
      } else if (act === 'import') {
        await call('/api/import-live', {});
        toast('Saved');
      }
    } catch (e) {
      toast(e.message, 6000);
    }
    load();
  },
  true,
);

$('#refreshAll').onclick = async (e) => {
  const b = e.currentTarget;
  b.classList.add('spin');
  b.disabled = true;
  try {
    await call('/api/refresh', {});
  } catch (x) {
    toast(x.message);
  }
  b.classList.remove('spin');
  b.disabled = false;
  load();
  loadTokens();
};
$('#logMore').onclick = () => {
  logAll = true;
  renderLog();
};

// ---------- auto-switch options ----------

const optsWrap = $('#optsWrap');
function setOpts(open, animate = true) {
  if (!animate) optsWrap.style.transition = 'none';
  optsWrap.classList.toggle('closed', !open);
  optsWrap.inert = !open;
  $('#optsBtn').setAttribute('aria-expanded', String(open));
  if (!animate) {
    void optsWrap.offsetHeight;
    optsWrap.style.transition = '';
  }
}
setOpts(localStorage.getItem('cam.opts') !== '0', false);
$('#optsBtn').onclick = () => {
  const open = optsWrap.classList.contains('closed');
  setOpts(open);
  localStorage.setItem('cam.opts', open ? '1' : '0');
};

async function saveSettings(patch) {
  try {
    await call('/api/settings', patch);
  } catch (e) {
    toast(e.message);
  }
  editing = false;
  load();
}
$('#autoSwitch').onchange = (e) => saveSettings({ autoSwitch: e.target.checked });
$('#threshold').oninput = (e) => {
  editing = true;
  $('#thVal').textContent = `${e.target.value}%`;
  S.settings = { ...S.settings, threshold: Number(e.target.value) };
  renderTable();
};
$('#threshold').onchange = (e) => saveSettings({ threshold: Number(e.target.value) });
document.querySelectorAll('[data-watch]').forEach((el) => (el.onchange = () => saveSettings({ watch: { [el.dataset.watch]: el.checked } })));
document.querySelectorAll('[name=strategy]').forEach((el) => (el.onchange = () => saveSettings({ strategy: el.value })));
document.querySelectorAll('[name=warmup]').forEach((el) => (el.onchange = () => saveSettings({ warmup: el.value })));

// ---------- rename: double-click, or double-tap on phones ----------

let lastTap = 0;
function startRename(h) {
  const a = S.accounts.find((x) => x.id === h.dataset.rename);
  if (!a) return;
  renaming = true;
  const input = document.createElement('input');
  input.value = a.label || '';
  input.placeholder = nameOf(a);
  input.setAttribute('aria-label', 'Account name');
  h.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (saveIt) => {
    if (done) return;
    done = true;
    renaming = false;
    if (saveIt && input.value.trim() !== (a.label || '')) {
      try {
        await call('/api/account', { id: a.id, label: input.value.trim() });
      } catch (e) {
        toast(e.message);
      }
    }
    load();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') finish(true);
    if (e.key === 'Escape') finish(false);
  });
  input.addEventListener('blur', () => finish(true));
}
document.addEventListener('dblclick', (e) => {
  const h = e.target.closest('[data-rename]');
  if (h) startRename(h);
});
document.addEventListener('pointerup', (e) => {
  const h = e.target.closest('[data-rename]');
  if (e.pointerType !== 'touch' || !h) return;
  const t = Date.now();
  if (t - lastTap < 350) {
    e.preventDefault();
    startRename(h);
    lastTap = 0;
  } else lastTap = t;
});

// ---------- drag rows to reorder: anywhere with a mouse, by the grip on touch screens ----------

const rowsBox = $('#rows');
rowsBox.addEventListener('pointerdown', (e) => {
  if (e.button > 0 || renaming) return;
  const row = e.target.closest('.row[data-row]');
  if (!row) return;
  const touch = e.pointerType !== 'mouse';
  if (touch ? !e.target.closest('.grip') : e.target.closest('button, input, a, [data-rename]')) return;
  drag = { row, pid: e.pointerId, y0: e.clientY, on: false, order: S.accounts.map((a) => a.id).join() };
});
addEventListener(
  'pointermove',
  (e) => {
    if (!drag || e.pointerId !== drag.pid) return;
    if (!drag.on) {
      if (Math.abs(e.clientY - drag.y0) < 5) return;
      drag.on = true;
      drag.row.classList.add('dragging');
      try {
        drag.row.setPointerCapture(e.pointerId);
      } catch {}
    }
    e.preventDefault();
    const others = [...rowsBox.querySelectorAll('.row[data-row]')].filter((r) => r !== drag.row);
    const before = others.find((r) => {
      const b = r.getBoundingClientRect();
      return e.clientY < b.top + b.height / 2;
    }) || null;
    if (drag.row.nextElementSibling !== before) rowsBox.insertBefore(drag.row, before);
    drag.row.style.transform = '';
    const b = drag.row.getBoundingClientRect();
    drag.row.style.transform = `translateY(${e.clientY - (b.top + b.height / 2)}px)`;
  },
  { passive: false },
);
async function endDrag(e) {
  if (!drag || (e && e.pointerId !== drag.pid)) return;
  const d = drag;
  drag = null;
  if (!d.on) return;
  d.row.classList.remove('dragging');
  d.row.style.transform = '';
  swallowClick = true;
  setTimeout(() => (swallowClick = false), 400);
  const ids = [...rowsBox.querySelectorAll('.row[data-row]')].map((r) => r.dataset.row);
  if (ids.join() !== d.order) {
    try {
      await call('/api/order', { ids });
    } catch (x) {
      toast(x.message);
    }
  }
  load();
}
addEventListener('pointerup', endDrag);
addEventListener('pointercancel', endDrag);

// ---------- sign-in sheet ----------
// The link is prepared as the sheet opens, so one tap opens claude.ai. "Copy link" is for opening
// it somewhere else (a private window, another browser or device). Either way, the code box appears.

const sheet = $('#sheet');
let signinUrl = '';

async function prepareLink() {
  const link = $('#addLink');
  signinUrl = '';
  link.setAttribute('aria-disabled', 'true');
  link.textContent = 'Preparing…';
  link.removeAttribute('href');
  $('#copyLink').disabled = true;
  try {
    const r = await call('/api/login/start', { email: relogin?.email || '' });
    signinUrl = r.url;
    link.href = r.url;
    link.setAttribute('aria-disabled', 'false');
    link.textContent = 'Sign in with Claude';
    $('#copyLink').disabled = false;
  } catch (e) {
    sheetErr(e.message);
  }
}

function openSheet(acc) {
  relogin = acc || null;
  $('#sheetTitle').textContent = acc ? `Sign in to ${nameOf(acc)}` : 'Add account';
  $('#addCode').value = '';
  $('#addErr').hidden = true;
  showCodeStep(false);
  sheet.showModal();
  updateWait();
  prepareLink();
}

function showCodeStep(on) {
  $('#codeStep').hidden = !on;
  sheet.classList.toggle('got-link', on);
  $('#linkHint').classList.toggle('after', on);
  if (on) {
    $('#addLink').textContent = 'Open sign-in again';
    $('#addErr').hidden = true;
    $('#addCode').focus();
    updateWait();
  }
}

function sheetErr(m) {
  $('#addErr').textContent = m;
  $('#addErr').hidden = false;
}

function updateWait() {
  const until = S?.signinBlockedUntil || 0;
  const left = until - Date.now();
  const box = $('#addWait');
  if (left <= 0) {
    box.hidden = true;
    $('#addFinish').disabled = false;
    return;
  }
  const m = Math.floor(left / 60000), s = Math.floor((left % 60000) / 1000);
  box.textContent = `Claude is rate-limiting sign-ins from this machine. Try again in ${m}:${String(s).padStart(2, '0')} with a fresh link: codes expire within minutes.`;
  box.hidden = false;
  $('#addFinish').disabled = true;
}
setInterval(() => sheet.open && updateWait(), 1000);

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers, or a page served over plain http on a non-localhost address.
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    ta.style.cssText = 'position:fixed;opacity:0';
    sheet.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

$('#sheetClose').onclick = () => sheet.close();
$('#addLink').onclick = () => setTimeout(() => showCodeStep(true), 300);
$('#copyLink').onclick = async () => {
  if (!signinUrl) return;
  if (await copyText(signinUrl)) {
    toast('Sign-in link copied');
    showCodeStep(true);
  } else sheetErr('Could not copy. Long-press “Sign in with Claude” and copy the link instead.');
};
$('#addCode').addEventListener('keydown', (e) => e.key === 'Enter' && $('#addFinish').click());
$('#addFinish').onclick = async (e) => {
  const code = $('#addCode').value.trim();
  if (!code) return sheetErr('Paste the code first.');
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Adding…';
  try {
    await call('/api/login/finish', { code });
    sheet.close();
    toast(relogin ? 'Signed in' : 'Account added');
    load();
  } catch (x) {
    sheetErr(x.message);
    if (x.data?.blockedUntil && S) S.signinBlockedUntil = x.data.blockedUntil;
    if (x.data?.staleLink) {
      $('#addCode').value = '';
      showCodeStep(false);
      prepareLink();
    }
  }
  btn.textContent = 'Add account';
  btn.disabled = false;
  updateWait();
};

// ---------- start ----------

load().then(loadTokens);
setInterval(() => !document.hidden && !sheet.open && !editing && load(), 15000);
setInterval(() => !document.hidden && loadTokens(), 60000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  load();
  loadTokens();
});
