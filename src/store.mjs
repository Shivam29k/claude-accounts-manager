// Everything the app remembers, in one JSON file (mode 600: it holds OAuth tokens).

import { now, readJson, writeJsonAtomic } from './util.mjs';

export const DEFAULT_SETTINGS = {
  autoSwitch: true,
  threshold: 90, // switch away when the active account reaches this % on a watched limit
  watch: { session: true, weekly: true, scoped: true },
  strategy: 'lowest', // "lowest": account with the most room; "priority": next account in list order
  pollActiveSec: 120,
  pollIdleSec: 600,
  cooldownSec: 180, // minimum time between two automatic switches
  warmup: 'off', // auto-start idle 5-hour windows: "off", "all" accounts, or "some" (accounts with warmup: true)
};

const MAX_EVENTS = 200;
const PENDING_TTL = 30 * 60_000;

function findAt(t, ts) {
  let lo = 0, hi = t.length - 1, hit = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t[mid].ts <= ts) {
      hit = t[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit?.id || 'other';
}

export function createStore(file) {
  const state = {
    version: 1,
    settings: {},
    accounts: [],
    activeId: null, // account whose login Claude Code is using
    liveUnknown: null, // set when Claude Code uses a login that isn't saved here
    events: [],
    lastAutoSwitchAt: 0,
    timeline: [], // [{ ts, id }]: which account was live from when, for token attribution
    pending: {}, // sign-in links in flight: state -> { verifier, label, at }
    localName: '', // this machine's name in the UI ("" = host name)
    machines: [], // other machines, each running the agent (see machines in manager.mjs)
    pairCodes: [], // one-time codes for adding a machine: [{ hash, at }]
    ...(readJson(file) || {}),
  };
  state.settings = { ...DEFAULT_SETTINGS, ...state.settings, watch: { ...DEFAULT_SETTINGS.watch, ...(state.settings.watch || {}) } };

  const store = {
    state,

    save() {
      const last = state.timeline[state.timeline.length - 1];
      if (!last || last.id !== state.activeId) state.timeline.push({ ts: now(), id: state.activeId });
      writeJsonAtomic(file, state);
    },

    log(type, msg, data) {
      state.events.unshift({ ts: now(), type, msg, ...(data && { data }) });
      state.events.length = Math.min(state.events.length, MAX_EVENTS);
      console.log(`${type}: ${msg}`);
    },

    byId: (id) => state.accounts.find((a) => a.id === id),
    nameOf: (a) => (a ? a.label || a.email || a.id : '?'),

    // Account that was live on this machine at time ts ("other" before tracking began or while none was).
    accountAt: (ts) => findAt(state.timeline, ts),
    // The same for another machine.
    accountAtOn: (machineId, ts) => findAt(state.machines.find((m) => m.id === machineId)?.timeline || [], ts),

    // Each account keeps one chart colour for life: the lowest index not used by another.
    assignColor(acc) {
      if (Number.isInteger(acc.colorIdx)) return;
      const used = new Set(state.accounts.map((a) => a.colorIdx));
      let i = 0;
      while (used.has(i)) i++;
      acc.colorIdx = i;
    },

    prunePending() {
      const keep = Object.entries(state.pending)
        .filter(([, v]) => now() - v.at < PENDING_TTL)
        .sort((a, b) => b[1].at - a[1].at)
        .slice(0, 8);
      state.pending = Object.fromEntries(keep);
    },
  };

  for (const a of state.accounts) store.assignColor(a);
  return store;
}
