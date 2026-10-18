// The account manager: keeps saved logins fresh, reads their usage, and swaps the one Claude
// Code uses, by hand or automatically when the active account nears its limit. It does that for
// this machine directly, and for other machines through their agents (see "other machines").

import crypto from 'node:crypto';
import os from 'node:os';
import { accountPart } from './claude-files.mjs';
import { accountKey, buildAuthorizeUrl, oauthAccountFromProfile, oauthFromTokenResponse, parsePastedCode, profileSummary } from './anthropic.mjs';
import { extraUsageOn, loadPct, meters } from './usage.mjs';
import { AppError, b64url, createLock, now } from './util.mjs';
import { sessionIdle } from './warmup.mjs';

const MIN = 60_000;

const LOCAL = 'local'; // this machine's id in machine lists
const ONLINE_MS = 90_000; // agents check in at least every ~30 seconds
const PAIR_TTL = 15 * MIN;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
// The token fingerprint agents and the hub compare to see whether a machine has the right login.
export const tokenHash = (t) => (t ? sha(t).slice(0, 16) : null);

// warmup: optional { run(accessToken) } that sends one message as that account (see warmup.mjs).
// remoteTokens: optional (machineId, slots) => void, receives token counts reported by agents.
export function createManager({ store, files, anthropic, warmup = null, checkHealth = () => [], remoteTokens = () => {} }) {
  const { state } = store;
  const lock = createLock();
  const name = store.nameOf;
  let health = { warnings: [], at: 0 };

  const accLoad = (acc) => loadPct(meters(acc.usage?.data), state.settings.watch);
  // Each account can have its own switch-away limit; otherwise the global threshold applies.
  const limitOf = (acc) => (Number.isFinite(acc?.threshold) ? acc.threshold : state.settings.threshold);

  const machineOf = (id) => state.machines.find((m) => m.id === id);
  const machineName = (id) => (id === LOCAL ? state.localName || os.hostname() : machineOf(id)?.name || 'removed machine');
  const online = (m) => now() - (m.lastSeen || 0) < ONLINE_MS;
  const activeOn = (mid) => (mid === LOCAL ? state.activeId : machineOf(mid)?.activeId ?? null);
  const usedRemotely = (acc) => state.machines.some((m) => m.activeId === acc.id);
  // In use right now: live here, or on another machine that's checking in.
  const inUse = (acc) => acc.id === state.activeId || state.machines.some((m) => m.activeId === acc.id && online(m));
  // "on MacBook" in messages, once there is more than one machine.
  const onMachine = (mid) => (state.machines.length ? ` on ${machineName(mid)}` : '');

  function applyProfile(acc, profile) {
    Object.assign(acc, profileSummary(profile));
    acc.oauthAccount = oauthAccountFromProfile(profile);
    acc.profileAt = now();
  }

  function pointClaudeJsonAt(acc) {
    if (files.setOauthAccount(acc?.oauthAccount)) console.log(`.claude.json now points at ${name(acc)}`);
  }

  // ---------- following Claude Code's live login ----------

  // Which saved account the live credentials belong to; also picks up token refreshes Claude
  // Code did itself, so the stored copy always has the newest refresh token.
  let identified = { token: null, key: null, profile: null, at: 0 };
  async function syncLive() {
    const live = files.readLive();
    const o = live?.oauth;
    if (!o?.accessToken) {
      if (state.activeId !== null) store.log('live', 'Claude Code was signed out on this machine');
      state.activeId = null;
      state.liveUnknown = null;
      return;
    }
    let acc = state.accounts.find((a) => a.creds?.claudeAiOauth?.refreshToken === o.refreshToken || a.creds?.claudeAiOauth?.accessToken === o.accessToken);
    if (!acc) {
      // Unknown tokens: Claude Code refreshed them, or someone ran `claude /login`. Ask who it is.
      if (identified.token !== o.accessToken || (!identified.key && now() - identified.at > MIN)) {
        identified = { token: o.accessToken, key: null, profile: null, at: now() };
        try {
          identified.profile = await anthropic.fetchProfile(o.accessToken);
          identified.key = accountKey(identified.profile);
        } catch (e) {
          console.error('could not identify the live login:', e.message);
        }
      }
      if (!identified.key) return; // can't tell yet; keep the previous view
      acc = state.accounts.find((a) => a.key === identified.key);
      if (!acc) {
        const p = identified.profile;
        state.liveUnknown = { email: p.account.email, orgName: p.organization?.name || '', key: identified.key };
        if (state.activeId !== null) store.log('live', `Claude Code was signed in to ${p.account.email}, which isn't saved here`);
        state.activeId = null;
        return;
      }
    }
    const part = accountPart(live.raw);
    if (JSON.stringify(part) !== JSON.stringify(acc.creds)) {
      acc.creds = part;
      acc.authError = null;
    }
    if (state.activeId !== acc.id) {
      if (state.activeId) store.log('live', `Claude Code was signed in to ${name(acc)} outside the app`, { kind: 'external', id: acc.id, name: name(acc) });
      state.activeId = acc.id;
    }
    state.liveUnknown = null;
    pointClaudeJsonAt(acc);
  }

  // ---------- tokens ----------

  // How long before expiry to refresh. Claude Code refreshes this machine's live account itself,
  // so normally we refresh that one only once it has expired (nothing is using it then) and write
  // the result back. Other machines get access tokens only and can't refresh, so an account they
  // use is renewed well ahead of time, and if it is also live here, still before Claude Code's own
  // refresh window (its last 5 minutes).
  function refreshMargin(acc) {
    const remote = usedRemotely(acc);
    if (acc.id === state.activeId) return remote ? 10 * MIN : -MIN;
    return remote ? 30 * MIN : 5 * MIN;
  }

  // A usable access token, refreshed first if needed.
  async function validToken(acc) {
    const o = acc.creds?.claudeAiOauth;
    if (!o?.refreshToken) throw Object.assign(new Error('no refresh token'), { fatal: true });
    const margin = refreshMargin(acc);
    if (o.expiresAt && o.expiresAt > now() + margin) return o.accessToken;
    return refreshAccount(acc);
  }

  // One refresh per account at a time: refresh tokens rotate, so a second concurrent refresh
  // with the same token would be rejected and look like a sign-out.
  const refreshing = new Map();
  function refreshAccount(acc) {
    if (!refreshing.has(acc.id)) refreshing.set(acc.id, doRefresh(acc).finally(() => refreshing.delete(acc.id)));
    return refreshing.get(acc.id);
  }

  async function doRefresh(acc) {
    const o = acc.creds.claudeAiOauth;
    let t;
    try {
      t = await anthropic.refresh({ refreshToken: o.refreshToken, scopes: o.scopes });
    } catch (e) {
      if (e.oauthError === 'invalid_grant') {
        acc.authError = 'Signed out by Claude. Sign in again.';
        store.log('auth', `Claude signed out ${name(acc)}`, { kind: 'signedout', id: acc.id, name: name(acc) });
        e.fatal = true;
      }
      throw e;
    }
    acc.creds = { ...acc.creds, claudeAiOauth: oauthFromTokenResponse(t, o) };
    acc.authError = null;
    if (acc.id === state.activeId) {
      // Only write back if Claude Code hasn't replaced the file in the meantime.
      if (files.readLive()?.oauth?.refreshToken === o.refreshToken) files.writeAccount(acc.creds);
    }
    store.save();
    return acc.creds.claudeAiOauth.accessToken;
  }

  // ---------- usage ----------

  async function pollUsage(acc, { quiet = false } = {}) {
    if (acc.authError) return;
    try {
      let token = await validToken(acc);
      let r = await anthropic.fetchUsage(token);
      if (r.status === 401 && acc.id !== state.activeId) {
        token = await refreshAccount(acc);
        r = await anthropic.fetchUsage(token);
      }
      if (r.status === 200 && r.body) {
        acc.usage = { data: r.body, fetchedAt: now() };
        acc.usageError = null;
      } else if (r.status === 429) {
        acc.usageError = 'Usage API rate-limited; retrying later';
        acc.nextUsageAt = now() + Math.max(r.retryAfter * 1000, 5 * MIN);
        return;
      } else {
        acc.usageError = `Usage API answered ${r.status}`;
      }
      if (!acc.profileAt || now() - acc.profileAt > 12 * 60 * MIN) {
        try {
          applyProfile(acc, await anthropic.fetchProfile(token));
        } catch {}
      }
    } catch (e) {
      if (!e.fatal) acc.usageError = e.message;
      if (!quiet) console.error(`usage check for ${name(acc)} failed:`, e.message);
    } finally {
      // Accounts in use are checked more often, and every minute once they near their limit.
      const live = inUse(acc);
      const pct = accLoad(acc);
      const near = live && pct !== null && pct >= limitOf(acc) - 15;
      const every = near ? 60 : live ? state.settings.pollActiveSec : state.settings.pollIdleSec;
      acc.nextUsageAt = Math.max(acc.nextUsageAt || 0, now() + every * 1000);
      store.save();
    }
  }

  // ---------- switching ----------

  function switchTo(id, reason = 'manual', meta = {}) {
    return lock(async () => {
      await syncLive();
      const target = store.byId(id);
      if (!target) throw new AppError('Unknown account');
      if (target.id === state.activeId) return { ok: true, already: true };
      if (target.authError) throw new AppError(`${name(target)} needs to sign in again first`);
      // Give the target plenty of token life. It isn't in use, so this can't race Claude Code.
      const o = target.creds.claudeAiOauth;
      if (!o.expiresAt || o.expiresAt < now() + 15 * MIN) await refreshAccount(target);
      // Claude Code may have just refreshed the outgoing account: capture that before overwriting.
      await syncLive();
      const from = store.byId(state.activeId);
      files.backup('before-switch');
      files.writeAccount(target.creds);
      state.activeId = target.id;
      state.liveUnknown = null;
      pointClaudeJsonAt(target);
      logSwitch(LOCAL, from, target, reason, meta);
      target.nextUsageAt = 0;
      store.save();
      return { ok: true };
    });
  }

  function logSwitch(mid, from, target, reason, meta) {
    store.log('switch', `Switched${onMachine(mid)} ${from ? `from ${name(from)} ` : ''}to ${name(target)}${reason === 'manual' ? '' : `. ${reason}`}`, {
      from: from?.id ?? null,
      fromName: from ? name(from) : null,
      to: target.id,
      toName: name(target),
      machine: mid,
      machineName: machineName(mid),
      ...meta,
    });
  }

  function setMachineAccount(m, id) {
    m.activeId = id;
    (m.timeline ||= []).push({ ts: now(), id });
  }

  // Switch another machine: its agent picks up the new login at its next check-in (within seconds).
  function switchMachine(mid, id, reason = 'manual', meta = {}) {
    if (!mid || mid === LOCAL) return switchTo(id, reason, meta);
    return lock(async () => {
      const m = machineOf(mid);
      if (!m) throw new AppError('Unknown machine');
      const target = store.byId(id);
      if (!target) throw new AppError('Unknown account');
      if (target.id === m.activeId) return { ok: true, already: true };
      if (target.authError) throw new AppError(`${name(target)} needs to sign in again first`);
      const from = store.byId(m.activeId);
      setMachineAccount(m, target.id);
      await validToken(target).catch(() => {}); // fresh token ready for the agent
      logSwitch(mid, from, target, reason, meta);
      target.nextUsageAt = 0;
      store.save();
      return { ok: true };
    });
  }

  // Each machine leaves its account at that account's limit. Machines on the same account share
  // its limits, so when there is a choice, accounts no other machine is using come first.
  const lastStuck = new Map();
  async function maybeAutoSwitch() {
    if (!state.settings.autoSwitch) return;
    for (const mid of [LOCAL, ...state.machines.map((m) => m.id)]) await autoSwitchMachine(mid);
  }

  async function autoSwitchMachine(mid) {
    const s = state.settings;
    const active = store.byId(activeOn(mid));
    if (!active) return;
    const pct = accLoad(active);
    const limit = limitOf(active);
    if (pct === null || pct < limit) {
      lastStuck.delete(mid);
      return;
    }
    const m = mid === LOCAL ? state : machineOf(mid);
    if (now() - (m.lastAutoSwitchAt || 0) < s.cooldownSec * 1000) return;
    const pool = state.accounts.filter((a) => a.id !== active.id && !a.excluded && !a.authError);
    for (const a of pool) if (!a.usage || now() - a.usage.fetchedAt > 5 * MIN) await pollUsage(a, { quiet: true });
    // A candidate must be under its own limit; "most room" means the most headroom below it.
    const candidates = pool.map((a) => ({ a, pct: accLoad(a), room: limitOf(a) - accLoad(a) })).filter((x) => x.pct !== null && x.room > 0);
    if (!candidates.length) {
      const key = `${active.id}:${pct}`;
      if (key !== lastStuck.get(mid)) {
        store.log('auto', `${name(active)} is at ${pct}%${onMachine(mid)} and every other account is past its limit`, { kind: 'stuck', id: active.id, name: name(active), pct, machine: mid, machineName: machineName(mid) });
      }
      lastStuck.set(mid, key);
      return;
    }
    const taken = new Set([state.activeId, ...state.machines.filter(online).map((x) => x.activeId)]);
    const free = candidates.filter((x) => !taken.has(x.a.id));
    const choices = free.length ? free : candidates;
    let pick;
    if (s.strategy === 'priority') {
      const order = state.accounts;
      const start = order.indexOf(active);
      for (let i = 1; i <= order.length && !pick; i++) pick = choices.find((x) => x.a === order[(start + i) % order.length]);
    } else {
      pick = choices.sort((x, y) => y.room - x.room)[0];
    }
    m.lastAutoSwitchAt = now();
    await switchMachine(mid, pick.a.id, `Automatic: ${name(active)} reached ${pct}%, past its ${limit}% limit`, { auto: true, pct, limit });
  }

  // ---------- auto-start 5-hour windows ----------

  const WARMUP_GAP = 15 * MIN; // never message the same account more often than this
  const warmupWanted = (a) => state.settings.warmup === 'all' || (state.settings.warmup === 'some' && !!a.warmup);

  async function maybeWarmup() {
    if (!warmup || state.settings.warmup === 'off') return;
    for (const a of state.accounts) {
      if (!warmupWanted(a) || a.authError || !a.usage) continue;
      if (now() - a.usage.fetchedAt > 15 * MIN) continue; // only act on recent numbers
      if (!sessionIdle(a.usage.data) || now() - (a.lastWarmupAt || 0) < WARMUP_GAP) continue;
      a.lastWarmupAt = now();
      let token;
      try {
        token = await validToken(a);
      } catch {
        continue;
      }
      const r = await warmup.run(token);
      if (r.ok) {
        a.warmupError = null;
        a.nextUsageAt = now() + 20_000; // confirm the window started
        store.log('warmup', `Started the 5-hour window of ${name(a)}`, { kind: 'warmup', id: a.id, name: name(a) });
      } else {
        if (a.warmupError !== r.error) store.log('warmup', `Couldn't start the 5-hour window of ${name(a)}: ${r.error}`, { kind: 'warmupFailed', id: a.id, name: name(a), error: r.error });
        a.warmupError = r.error;
      }
      store.save();
    }
  }

  // ---------- adding accounts ----------

  // Claude's token endpoint rate-limits code exchanges, and attempts made while limited seem to
  // extend the block. After a 429 we stop trying for 5, 10, 20, then 30 minutes.
  const signinBlock = { until: 0, strikes: 0 };
  const blockedMessage = () =>
    `Claude is rate-limiting sign-ins from this machine. Try again in ${Math.ceil((signinBlock.until - now()) / MIN)} min with a fresh link; retrying sooner can extend the block.`;

  function startLogin({ email = '', label = '' } = {}) {
    store.prunePending();
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    const st = b64url(crypto.randomBytes(32));
    // Saved (mode 600) so a restart between opening the link and pasting the code doesn't lose it.
    state.pending[st] = { verifier, label: String(label).slice(0, 60), at: now() };
    store.save();
    return { url: buildAuthorizeUrl({ challenge, state: st, email }) };
  }

  async function upsertAccount(accountKeys, profile, label, via = null) {
    let acc = state.accounts.find((a) => a.key === accountKey(profile));
    const isNew = !acc;
    if (isNew) {
      acc = { id: crypto.randomBytes(6).toString('hex'), label: '', excluded: false, addedAt: now() };
      state.accounts.push(acc);
      store.assignColor(acc);
    }
    applyProfile(acc, profile);
    if (label) acc.label = label;
    acc.creds = accountKeys;
    acc.authError = null;
    acc.nextUsageAt = 0;
    store.log('account', isNew ? `Added ${name(acc)}${acc.orgName ? ` from ${acc.orgName}` : ''}${via ? `, signed in on ${machineName(via)}` : ''}` : `Signed in again to ${name(acc)}`, {
      kind: isNew ? 'added' : 'relogin',
      id: acc.id,
      name: name(acc),
      ...(via && { machine: via, machineName: machineName(via) }),
    });
    return acc;
  }

  async function finishLogin({ code: pasted }) {
    let { code, state: st } = parsePastedCode(pasted);
    store.prunePending();
    if (!st) st = Object.entries(state.pending).sort((a, b) => b[1].at - a[1].at)[0]?.[0]; // bare code: newest link
    const pend = st && state.pending[st];
    if (!code || !pend) throw new AppError('That code came from an older sign-in link. Use the new link and paste its code.', { staleLink: true });
    if (now() < signinBlock.until) throw new AppError(blockedMessage(), { blockedUntil: signinBlock.until });
    let t;
    try {
      t = await anthropic.exchangeCode({ code, verifier: pend.verifier, state: st });
    } catch (e) {
      if (e.status === 429) {
        signinBlock.strikes++;
        signinBlock.until = now() + Math.min(30, 5 * 2 ** (signinBlock.strikes - 1)) * MIN;
        store.log('signin', 'Claude rate-limited a sign-in', { kind: 'limited', until: signinBlock.until });
        throw new AppError(blockedMessage(), { blockedUntil: signinBlock.until });
      }
      store.log('signin', e.message, { kind: 'failed' });
      throw new AppError(e.message);
    }
    signinBlock.strikes = 0;
    delete state.pending[st];
    store.save();
    const profile = await anthropic.fetchProfile(t.access_token);
    const keys = { claudeAiOauth: oauthFromTokenResponse(t, {}, profile) };
    return lock(async () => {
      const acc = await upsertAccount(keys, profile, pend.label);
      if (acc.id === state.activeId) files.writeAccount(acc.creds); // re-signed into the live account
      store.save();
      pollUsage(acc).catch(() => {});
      return { ok: true, id: acc.id };
    });
  }

  // Save the login Claude Code is using right now (e.g. after `claude /login`).
  function importLive(label) {
    return lock(async () => {
      const live = files.readLive();
      if (!live?.oauth?.accessToken) throw new AppError('Claude Code is not signed in on this machine');
      const profile = await anthropic.fetchProfile(live.oauth.accessToken);
      const acc = await upsertAccount(accountPart(live.raw), profile, label);
      state.activeId = acc.id;
      state.liveUnknown = null;
      pointClaudeJsonAt(acc);
      store.save();
      pollUsage(acc).catch(() => {});
      return { ok: true, id: acc.id };
    });
  }

  // ---------- other machines ----------
  // Each other machine runs the agent (agent/agent.mjs). It checks in with POST /agent/sync, gets
  // the access token of the account it should use, and writes it where Claude Code reads it there.
  // Refresh tokens never leave this hub: machines get access tokens only, so their Claude Code
  // can't refresh (and rotate) a login behind the hub's back. The hub renews them ahead of expiry.

  const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, max);

  // A one-time code for adding a machine, valid for 15 minutes.
  function createPairCode() {
    const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const raw = [...crypto.randomBytes(8)].map((b) => abc[b % abc.length]).join('');
    const code = `${raw.slice(0, 4)}-${raw.slice(4)}`;
    state.pairCodes = state.pairCodes.filter((c) => now() - c.at < PAIR_TTL).concat({ hash: sha(raw), at: now() }).slice(-5);
    store.save();
    return { code, expiresAt: now() + PAIR_TTL };
  }

  let pairFails = { n: 0, since: 0 };
  function pairMachine({ code, name: wanted, os: osName, hostname }) {
    return lock(async () => {
      if (now() - pairFails.since > 10 * MIN) pairFails = { n: 0, since: now() };
      if (pairFails.n >= 20) throw new AppError('Too many wrong codes. Wait a few minutes.');
      const raw = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const hit = state.pairCodes.find((c) => c.hash === sha(raw) && now() - c.at < PAIR_TTL);
      if (!hit) {
        pairFails.n++;
        throw new AppError('That code is wrong or expired. Get a new one from "Add machine".');
      }
      state.pairCodes = state.pairCodes.filter((c) => c !== hit);
      const token = b64url(crypto.randomBytes(32));
      const m = {
        id: crypto.randomBytes(6).toString('hex'),
        name: clean(wanted, 40) || clean(hostname, 40) || 'Machine',
        os: clean(osName, 20),
        hostname: clean(hostname, 100),
        tokenHash: sha(token),
        pairedAt: now(),
        lastSeen: 0,
        activeId: null,
        timeline: [],
        tokenSeq: 0,
      };
      state.machines.push(m);
      store.log('machine', `Added machine ${m.name}`, { kind: 'machineAdded', machine: m.id, machineName: m.name });
      store.save();
      return { machineId: m.id, name: m.name, token };
    });
  }

  const machineByToken = (token) => (token ? state.machines.find((m) => m.tokenHash === sha(token)) : null);

  // What a machine should be signed in with: the account's access token and profile, never its
  // refresh token. creds is null when the machine has no account or the account is signed out.
  function machineLogin(m) {
    const acc = store.byId(m.activeId);
    const o = acc?.creds?.claudeAiOauth;
    if (!acc || acc.authError || !o?.accessToken) return { account: acc ? { id: acc.id, name: name(acc), email: acc.email } : null, creds: null, hash: null };
    const { refreshToken, refreshTokenExpiresAt, ...rest } = o;
    return {
      account: { id: acc.id, name: name(acc), email: acc.email },
      creds: { claudeAiOauth: rest },
      oauthAccount: acc.oauthAccount || null,
      hash: tokenHash(o.accessToken),
    };
  }

  // A login on that machine the hub didn't put there (an existing login when the agent starts, or
  // `claude /login` run there): the machine now uses that account, saved here if it's new.
  const foreignSeen = new Map(); // machine id -> { token, at }
  async function adoptForeign(m, creds) {
    const o = creds?.claudeAiOauth;
    if (!o?.accessToken) return;
    const seen = foreignSeen.get(m.id);
    if (seen?.token === o.accessToken && now() - seen.at < MIN) return; // asked recently
    foreignSeen.set(m.id, { token: o.accessToken, at: now() });
    let profile;
    try {
      profile = await anthropic.fetchProfile(o.accessToken);
    } catch (e) {
      console.error(`could not identify the login on ${m.name}:`, e.message);
      return;
    }
    await lock(async () => {
      let acc = state.accounts.find((a) => a.key === accountKey(profile));
      if (!acc) {
        if (!o.refreshToken) return; // can't be kept alive here; leave it alone
        acc = await upsertAccount({ claudeAiOauth: o }, profile, '', m.id);
        pollUsage(acc).catch(() => {});
      } else if (acc.authError && o.refreshToken) {
        acc.creds = { claudeAiOauth: o }; // the hub's copy was signed out; this one works
        acc.authError = null;
        acc.nextUsageAt = 0;
        store.log('account', `Signed in again to ${name(acc)} on ${m.name}`, { kind: 'relogin', id: acc.id, name: name(acc), machine: m.id, machineName: m.name });
      }
      if (m.activeId !== acc.id) {
        if (m.activeId) store.log('live', `${m.name} was signed in to ${name(acc)} outside the app`, { kind: 'external', id: acc.id, name: name(acc), machine: m.id, machineName: m.name });
        setMachineAccount(m, acc.id);
      }
      foreignSeen.delete(m.id);
      store.save();
    });
  }

  function validSlots(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const item of list.slice(0, 2000)) {
      if (!Array.isArray(item) || !Number.isFinite(item[0]) || !item[1] || typeof item[1] !== 'object') continue;
      const row = {};
      for (const [k, v] of Object.entries(item[1]).slice(0, 20)) if (Number.isFinite(v) && v > 0 && v < 1e11) row[clean(k, 100)] = Math.round(v);
      out.push([item[0], row]);
    }
    return out;
  }

  // One check-in from a machine's agent. Returns the login it should have.
  async function agentSync(m, b = {}) {
    m.lastSeen = now();
    if (b.os) m.os = clean(b.os, 20);
    if (b.hostname) m.hostname = clean(b.hostname, 100);
    m.agentVersion = clean(b.agentVersion, 20);
    m.claudeVersion = clean(b.claudeVersion, 40);
    m.warnings = Array.isArray(b.warnings) ? b.warnings.slice(0, 10).map((w) => clean(w, 300)) : [];
    m.signedIn = b.live !== 'none';
    if (b.foreign) await adoptForeign(m, b.foreign);
    const t = b.tokens;
    if (t && Number.isInteger(t.seq) && t.seq > (m.tokenSeq || 0)) {
      remoteTokens(m.id, validSlots(t.slots));
      m.tokenSeq = t.seq;
    }
    const acc = store.byId(m.activeId);
    if (acc && !acc.authError) await validToken(acc).catch(() => {});
    store.save();
    return { ...machineLogin(m), machine: { id: m.id, name: m.name }, ackSeq: m.tokenSeq || 0 };
  }

  const renameMachine = ({ id, name: newName }) =>
    lock(async () => {
      if (id === LOCAL) state.localName = clean(newName, 40);
      else {
        const m = machineOf(id);
        if (!m) throw new AppError('Unknown machine');
        m.name = clean(newName, 40) || m.hostname || m.name;
      }
      store.save();
      return { ok: true };
    });

  // Forget a machine: its agent is locked out. Its current login keeps working there until it expires.
  const removeMachine = (id) =>
    lock(async () => {
      const m = machineOf(id);
      if (!m) throw new AppError('Unknown machine');
      state.machines = state.machines.filter((x) => x !== m);
      store.log('machine', `Removed machine ${m.name}`, { kind: 'machineRemoved', machine: m.id, machineName: m.name });
      store.save();
      return { ok: true };
    });

  // ---------- small edits ----------

  const updateAccount = ({ id, label, excluded, warmup: wantWarmup, threshold }) =>
    lock(async () => {
      const a = store.byId(id);
      if (!a) throw new AppError('Unknown account');
      if (typeof label === 'string') a.label = label.trim().slice(0, 60);
      if (typeof excluded === 'boolean') a.excluded = excluded;
      if (threshold === null) delete a.threshold; // back to the global threshold
      else if (Number.isFinite(threshold)) a.threshold = Math.min(100, Math.max(10, Math.round(threshold)));
      if (threshold !== undefined) setTimeout(tick, 100);
      if (typeof wantWarmup === 'boolean') {
        a.warmup = wantWarmup;
        // Turning it on for one account while the feature is off means "just the chosen ones".
        if (wantWarmup && state.settings.warmup === 'off') state.settings.warmup = 'some';
        setTimeout(tick, 100);
      }
      store.save();
      return { ok: true };
    });

  const reorder = (ids) =>
    lock(async () => {
      if (!Array.isArray(ids)) throw new AppError('ids must be a list');
      const pos = new Map(ids.map((id, i) => [id, i]));
      state.accounts.sort((x, y) => (pos.get(x.id) ?? 1e9) - (pos.get(y.id) ?? 1e9));
      store.save();
      return { ok: true };
    });

  // Forget an account. Claude Code's current login is not touched.
  const removeAccount = (id) =>
    lock(async () => {
      const a = store.byId(id);
      if (!a) throw new AppError('Unknown account');
      state.accounts = state.accounts.filter((x) => x !== a);
      if (state.activeId === a.id) state.activeId = null;
      for (const m of state.machines) if (m.activeId === a.id) setMachineAccount(m, null);
      store.log('account', `Removed ${name(a)}`, { kind: 'removed', id: a.id, name: name(a) });
      store.save();
      return { ok: true };
    });

  async function refreshUsage(id) {
    const list = id ? [store.byId(id)].filter(Boolean) : state.accounts;
    for (const a of list) {
      a.nextUsageAt = 0;
      await pollUsage(a);
    }
    await maybeAutoSwitch();
    return { ok: true };
  }

  const updateSettings = (b) =>
    lock(async () => {
      const s = state.settings;
      if (typeof b.autoSwitch === 'boolean') s.autoSwitch = b.autoSwitch;
      if (Number.isFinite(b.threshold)) s.threshold = Math.min(100, Math.max(10, Math.round(b.threshold)));
      if (b.strategy === 'lowest' || b.strategy === 'priority') s.strategy = b.strategy;
      if (b.watch && typeof b.watch === 'object') for (const k of ['session', 'weekly', 'scoped']) if (typeof b.watch[k] === 'boolean') s.watch[k] = b.watch[k];
      if (Number.isFinite(b.pollActiveSec)) s.pollActiveSec = Math.min(1800, Math.max(60, Math.round(b.pollActiveSec)));
      if (Number.isFinite(b.pollIdleSec)) s.pollIdleSec = Math.min(7200, Math.max(120, Math.round(b.pollIdleSec)));
      if (['off', 'all', 'some'].includes(b.warmup)) s.warmup = b.warmup;
      store.save();
      setTimeout(tick, 100);
      return { ok: true };
    });

  // ---------- background loop ----------

  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      await lock(syncLive);
      const active = store.byId(state.activeId);
      if (active && now() >= (active.nextUsageAt || 0)) await pollUsage(active);
      for (const a of state.accounts) if (a !== active && !a.authError && now() >= (a.nextUsageAt || 0)) await pollUsage(a);
      // Keep idle logins alive even if usage checks fail: refresh when the refresh token has a week left.
      for (const a of state.accounts) {
        const o = a.creds?.claudeAiOauth;
        if (a.id !== state.activeId && !a.authError && o?.refreshTokenExpiresAt && o.refreshTokenExpiresAt - now() < 7 * 24 * 60 * MIN) await refreshAccount(a).catch(() => {});
      }
      // Other machines can't refresh their logins, so keep every account they use ahead of expiry.
      for (const a of state.accounts) if (usedRemotely(a) && !a.authError) await validToken(a).catch(() => {});
      await maybeAutoSwitch();
      await maybeWarmup();
      if (now() - health.at > MIN) health = { warnings: checkHealth(), at: now() };
      store.save();
    } catch (e) {
      console.error('background check failed:', e);
    } finally {
      ticking = false;
    }
  }

  async function start() {
    await lock(syncLive).catch((e) => console.error(e));
    // First run: save whatever Claude Code is signed in with.
    if (!state.accounts.length && state.liveUnknown) await importLive().catch((e) => console.error('could not save the current login:', e.message));
    health = { warnings: checkHealth(), at: now() };
    store.save();
  }

  // What the browser sees. Never includes tokens.
  function publicState() {
    return {
      now: now(),
      settings: state.settings,
      activeId: state.activeId,
      liveUnknown: state.liveUnknown,
      signinBlockedUntil: signinBlock.until > now() ? signinBlock.until : 0,
      health: health.warnings,
      events: state.events.slice(0, 60),
      // This machine first, then the ones running the agent. activeId: the account each one uses.
      machines: [
        { id: LOCAL, name: machineName(LOCAL), os: process.platform, local: true, activeId: state.activeId, online: true, signedIn: !!state.activeId || !!state.liveUnknown },
        ...state.machines.map((m) => ({
          id: m.id,
          name: m.name,
          os: m.os,
          hostname: m.hostname,
          local: false,
          activeId: m.activeId,
          online: online(m),
          lastSeen: m.lastSeen || null,
          pairedAt: m.pairedAt,
          signedIn: m.signedIn ?? null,
          agentVersion: m.agentVersion || null,
          claudeVersion: m.claudeVersion || null,
          warnings: m.warnings || [],
        })),
      ],
      accounts: state.accounts.map((a) => {
        const ms = meters(a.usage?.data);
        return {
          id: a.id,
          colorIdx: a.colorIdx,
          label: a.label,
          email: a.email,
          displayName: a.displayName,
          orgName: a.orgName,
          orgType: a.orgType,
          plan: a.plan,
          rateLimitTier: a.rateLimitTier,
          subscriptionStatus: a.subscriptionStatus,
          excluded: !!a.excluded,
          authError: a.authError || null,
          usageError: a.usageError || null,
          usageAt: a.usage?.fetchedAt || null,
          meters: ms,
          loadPct: loadPct(ms, state.settings.watch),
          threshold: Number.isFinite(a.threshold) ? a.threshold : null, // custom limit, if any
          limit: limitOf(a), // the limit that applies
          extraUsage: extraUsageOn(a.usage?.data),
          sessionIdle: a.usage ? sessionIdle(a.usage.data) : null,
          warmup: !!a.warmup,
          warmupOn: warmupWanted(a),
          lastWarmupAt: a.lastWarmupAt || null,
          warmupError: a.warmupError || null,
          refreshExpiresAt: a.creds?.claudeAiOauth?.refreshTokenExpiresAt || null,
        };
      }),
    };
  }

  return {
    start,
    tick,
    publicState,
    switchTo,
    switchMachine,
    maybeAutoSwitch,
    createPairCode,
    pairMachine,
    machineByToken,
    machineLogin,
    agentSync,
    renameMachine,
    removeMachine,
    startLogin,
    finishLogin,
    importLive,
    updateAccount,
    reorder,
    removeAccount,
    refreshUsage,
    updateSettings,
    idle: () => lock.idle(),
  };
}
