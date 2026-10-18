// Pure helpers shared by the page and the tests.

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const nameOf = (a) => a.label || (a.email || '').split('@')[0];

export const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }).toLowerCase();

export function compact(n) {
  const f = (v, big) => `${+v.toFixed(big ? 0 : 1)}`;
  if (n >= 1e9) return `${f(n / 1e9, n >= 1e10)}B`;
  if (n >= 1e6) return `${f(n / 1e6, n >= 1e7)}M`;
  if (n >= 1e3) return `${f(n / 1e3, n >= 1e4)}K`;
  return String(Math.round(n));
}

export function ago(ts, nowMs = Date.now()) {
  if (!ts) return 'never';
  const s = Math.round((nowMs - ts) / 1000);
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
}

export function untilText(iso, nowMs = Date.now()) {
  if (!iso) return '';
  const ms = new Date(iso) - nowMs;
  if (ms <= 0) return 'now';
  const m = Math.round(ms / 60000), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60);
  return d ? `in ${d}d ${h}h` : h ? `in ${h}h ${m % 60}m` : `in ${m}m`;
}

// "team" + "default_claude_max_5x" -> "Team 5x"
export function plan(a) {
  const base = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise' }[a.plan] || a.plan || '';
  const x = (a.rateLimitTier || '').match(/max_(\d+)x/);
  return [base, x && `${x[1]}x`].filter(Boolean).join(' ');
}

// "claude-opus-5-5" -> { fam: "opus", ver: "5.5" }; also handles dated and older id styles.
export function modelInfo(id) {
  let m = String(id).match(/^claude-([a-z]+)-(\d+(?:-\d{1,2})?)(?:-\d{8})?$/);
  if (m) return { fam: m[1], ver: m[2].replace('-', '.') };
  m = String(id).match(/^claude-(\d+(?:-\d)?)-([a-z]+)/); // claude-3-5-sonnet-20241022
  if (m) return { fam: m[2], ver: m[1].replace('-', '.') };
  return { fam: 'other', ver: null };
}

// Chart buckets in the browser's own time zone. range: "24h" | "7d" | "30d" | "all".
export function chartBins(range, first, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const out = [];
  const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  if (range === '24h') {
    const h = new Date(now);
    h.setMinutes(0, 0, 0);
    for (let i = 23; i >= 0; i--) {
      const s = new Date(+h - i * 3600e3);
      out.push({ s: +s, e: +s + 3600e3, label: s.toLocaleTimeString([], { hour: 'numeric' }).toLowerCase().replace(' ', ''), tip: `${clock(s)} – ${clock(new Date(+s + 3600e3))}` });
    }
    return { out, every: 4, span: 'last 24 hours' };
  }
  let days = range === '7d' ? 7 : range === '30d' ? 30 : null;
  let step = 1;
  const today = dayStart(now);
  if (days === null) {
    const start = first ? dayStart(new Date(first)) : today;
    days = Math.max(1, Math.round((today - start) / 864e5) + 1);
    if (days > 60) step = 7;
  }
  const n = Math.ceil(days / step);
  for (let i = n - 1; i >= 0; i--) {
    const s = new Date(today);
    s.setDate(s.getDate() - i * step);
    const e = new Date(s);
    e.setDate(e.getDate() + step);
    const label = range === '7d' ? s.toLocaleDateString([], { weekday: 'short' }) : s.toLocaleDateString([], { month: 'short', day: 'numeric' });
    out.push({ s: +s, e: +e, label, tip: step === 7 ? `Week of ${label}` : s.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }) });
  }
  const span = range === '7d' ? 'last 7 days' : range === '30d' ? 'last 30 days' : first ? `since ${new Date(first).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : 'all time';
  return { out, every: range === '7d' ? 1 : Math.max(1, Math.ceil(n / 6)), span };
}

// Round axis: three gridlines at clean values that cover max.
export function axisStep(max) {
  const mag = 10 ** Math.floor(Math.log10(max / 3));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((x) => x * 3 >= max);
  return { step, top: step * 3 };
}
