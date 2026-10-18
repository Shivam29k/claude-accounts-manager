// The account manager: keeps saved logins fresh, reads their usage, and swaps the one Claude
// Code uses, by hand or automatically when the active account nears its limit.

import crypto from 'node:crypto';
import { accountPart } from './claude-files.mjs';
import { accountKey, buildAuthorizeUrl, oauthAccountFromProfile, oauthFromTokenResponse, parsePastedCode, profileSummary } from './anthropic.mjs';
import { extraUsageOn, loadPct, meters } from './usage.mjs';
import { AppError, b64url, createLock, now } from './util.mjs';

const MIN = 60_000;

export function createManager({ store, files, anthropic, checkHealth = () => [] }) {
  const { state } = store;
  const lock = createLock();
  const name = store.nameOf;
  let health = { warnings: [], at: 0 };

  const accLoad = (acc) => loadPct(meters(acc.usage?.data), state.settings.watch);

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

  // A usable access token. Claude Code refreshes the live account itself, so we only refresh
  // that one once it has already expired (nothing is using it then) and write the result back.
  async function validToken(acc) {
    const o = acc.creds?.claudeAiOauth;
    if (!o?.refreshToken) throw Object.assign(new Error('no refresh token'), { fatal: true });
    const margin = acc.id === state.activeId ? -MIN : 5 * MIN;
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
      // The live account is checked more often, and every minute once it nears the threshold.
      const live = acc.id === state.activeId;
      const pct = accLoad(acc);
      const near = live && pct !== null && pct >= state.settings.threshold - 15;
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
      store.log('switch', `Switched ${from ? `from ${name(from)} ` : ''}to ${name(target)}${reason === 'manual' ? '' : `. ${reason}`}`, {
        from: from?.id ?? null,
        fromName: from ? name(from) : null,
        to: target.id,
        toName: name(target),
        ...meta,
      });
      target.nextUsageAt = 0;
      store.save();
      return { ok: true };
    });
  }

  let lastStuck = '';
  async function maybeAutoSwitch() {
    const s = state.settings;
    const active = store.byId(state.activeId);
    if (!s.autoSwitch || !active) return;
    const pct = accLoad(active);
    if (pct === null || pct < s.threshold) {
      lastStuck = '';
      return;
    }
    if (now() - (state.lastAutoSwitchAt || 0) < s.cooldownSec * 1000) return;
    const pool = state.accounts.filter((a) => a.id !== active.id && !a.excluded && !a.authError);
    for (const a of pool) if (!a.usage || now() - a.usage.fetchedAt > 5 * MIN) await pollUsage(a, { quiet: true });
    const candidates = pool.map((a) => ({ a, pct: accLoad(a) })).filter((x) => x.pct !== null && x.pct < s.threshold);
    if (!candidates.length) {
      const key = `${active.id}:${pct}`;
      if (key !== lastStuck) store.log('auto', `${name(active)} is at ${pct}% and no other account is under ${s.threshold}%`, { kind: 'stuck', id: active.id, name: name(active), pct });
      lastStuck = key;
      return;
    }
    let pick;
    if (s.strategy === 'priority') {
      const order = state.accounts;
      const start = order.indexOf(active);
      for (let i = 1; i <= order.length && !pick; i++) pick = candidates.find((x) => x.a === order[(start + i) % order.length]);
    } else {
      pick = candidates.sort((x, y) => x.pct - y.pct)[0];
    }
    state.lastAutoSwitchAt = now();
    await switchTo(pick.a.id, `Automatic: ${name(active)} reached ${pct}%, past the ${s.threshold}% switch point`, { auto: true, pct });
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

  async function upsertAccount(accountKeys, profile, label) {
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
    store.log('account', isNew ? `Added ${name(acc)}${acc.orgName ? ` from ${acc.orgName}` : ''}` : `Signed in again to ${name(acc)}`, {
      kind: isNew ? 'added' : 'relogin',
      id: acc.id,
      name: name(acc),
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

  // ---------- small edits ----------

  const updateAccount = ({ id, label, excluded }) =>
    lock(async () => {
      const a = store.byId(id);
      if (!a) throw new AppError('Unknown account');
      if (typeof label === 'string') a.label = label.trim().slice(0, 60);
      if (typeof excluded === 'boolean') a.excluded = excluded;
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
      await maybeAutoSwitch();
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
          extraUsage: extraUsageOn(a.usage?.data),
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
    maybeAutoSwitch,
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
