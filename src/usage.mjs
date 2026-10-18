// Turns the answer of GET /api/oauth/usage (what Claude Code's /usage shows) into meters.

const METER_LABELS = {
  five_hour: 'Session (5 hours)',
  seven_day: 'Weekly, all models',
  seven_day_opus: 'Weekly, Opus',
  seven_day_sonnet: 'Weekly, Sonnet',
};

// Each meter: { id, label, pct, resetsAt, cat, active }. cat is what auto-switch can watch:
// "session" (5-hour), "weekly" (all models) or "scoped" (per-model weekly limits).
export function meters(u) {
  if (!u) return [];
  const out = [];
  for (const k of Object.keys(METER_LABELS)) {
    const v = u[k];
    if (v && typeof v.utilization === 'number') {
      out.push({
        id: k,
        label: METER_LABELS[k],
        pct: v.utilization,
        resetsAt: v.resets_at,
        cat: k === 'five_hour' ? 'session' : k === 'seven_day' ? 'weekly' : 'scoped',
        active: true,
      });
    }
  }
  // Newer answers also list limits[]; add the ones not already covered above.
  for (const l of Array.isArray(u.limits) ? u.limits : []) {
    if (typeof l.percent !== 'number') continue;
    const model = l.scope?.model?.display_name;
    const surface = l.scope?.surface?.display_name || (typeof l.scope?.surface === 'string' ? l.scope.surface : '');
    if (l.group === 'session' && !model && u.five_hour) continue;
    if (l.group === 'weekly' && !model && !surface && u.seven_day) continue;
    const group = l.group === 'weekly' ? 'Weekly' : l.group === 'session' ? 'Session' : String(l.group || l.kind || 'Limit');
    const label = [group, model, surface].filter(Boolean).join(', ');
    if (out.some((m) => m.label === label)) continue;
    out.push({
      id: `limit:${l.kind}:${model || ''}:${surface || ''}`,
      label,
      pct: l.percent,
      resetsAt: l.resets_at,
      cat: l.group === 'session' && !model ? 'session' : l.group === 'weekly' && !model && !surface ? 'weekly' : 'scoped',
      active: l.is_active !== false,
    });
  }
  return out;
}

// The number auto-switch compares with the threshold: the fullest watched, active meter.
export function loadPct(ms, watch) {
  const watched = ms.filter((m) => watch[m.cat] && m.active);
  return watched.length ? Math.max(...watched.map((m) => m.pct)) : null;
}

// Extra usage bills past the plan limit instead of stopping there.
export const extraUsageOn = (u) => !!(u?.extra_usage?.is_enabled || u?.spend?.enabled);
