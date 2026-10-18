import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { OAUTH, buildAuthorizeUrl, oauthFromTokenResponse, parsePastedCode, profileSummary } from '../src/anthropic.mjs';
import { accountPart, createClaudeFiles } from '../src/claude-files.mjs';
import { loadConfig } from '../src/config.mjs';
import { createStore } from '../src/store.mjs';
import { extraUsageOn, loadPct, meters } from '../src/usage.mjs';
import { sessionIdle } from '../src/warmup.mjs';
import { axisStep, chartBins, compact, modelInfo, plan } from '../public/lib.js';
import { profile, readJson, tempDir, writeJson } from './helpers.mjs';

test('meters: classic fields plus limits[] without duplicates', () => {
  const ms = meters({
    five_hour: { utilization: 40, resets_at: 'x' },
    seven_day: { utilization: 10, resets_at: 'y' },
    limits: [
      { kind: 'session', group: 'session', percent: 40, is_active: true }, // same as five_hour
      { kind: 'weekly_scoped', group: 'weekly', percent: 70, scope: { model: { display_name: 'Opus' } }, is_active: true },
      { kind: 'weekly_scoped', group: 'weekly', percent: 0, scope: { model: { display_name: 'Fable' } }, is_active: false },
    ],
  });
  assert.deepEqual(ms.map((m) => [m.label, m.cat, m.active]), [
    ['Session (5 hours)', 'session', true],
    ['Weekly, all models', 'weekly', true],
    ['Weekly, Opus', 'scoped', true],
    ['Weekly, Fable', 'scoped', false],
  ]);
  assert.equal(loadPct(ms, { session: true, weekly: true, scoped: true }), 70);
  assert.equal(loadPct(ms, { session: true, weekly: true, scoped: false }), 40);
  assert.equal(loadPct([], { session: true }), null);
  assert.equal(extraUsageOn({ extra_usage: { is_enabled: true } }), true);
});

test('sessionIdle: no window, no reset time, or a reset time in the past', () => {
  const now = Date.UTC(2026, 9, 18, 12);
  assert.equal(sessionIdle({ five_hour: null }, now), true);
  assert.equal(sessionIdle({}, now), true);
  assert.equal(sessionIdle({ five_hour: { utilization: 0, resets_at: null } }, now), true);
  assert.equal(sessionIdle({ five_hour: { utilization: 40, resets_at: new Date(now - 1000).toISOString() } }, now), true);
  assert.equal(sessionIdle({ five_hour: { utilization: 0, resets_at: new Date(now + 3600_000).toISOString() } }, now), false);
});

test('authorize URL carries PKCE, state and the Claude Code client', () => {
  const u = new URL(buildAuthorizeUrl({ challenge: 'c', state: 's', email: 'a@b.c' }));
  assert.equal(u.origin + u.pathname, OAUTH.authorizeUrl);
  assert.equal(u.searchParams.get('client_id'), OAUTH.clientId);
  assert.equal(u.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(u.searchParams.get('state'), 's');
  assert.equal(u.searchParams.get('login_hint'), 'a@b.c');
  assert.equal(u.searchParams.get('redirect_uri'), OAUTH.redirectUri);
});

test('pasted codes: code#state, bare code, full URL, stray whitespace', () => {
  assert.deepEqual(parsePastedCode('abc#xyz'), { code: 'abc', state: 'xyz' });
  assert.deepEqual(parsePastedCode('  abc \n'), { code: 'abc', state: '' });
  assert.deepEqual(parsePastedCode('https://platform.claude.com/oauth/code/callback?code=abc&state=xyz'), { code: 'abc', state: 'xyz' });
});

test('token response becomes Claude Code’s claudeAiOauth shape', () => {
  const at = 1_000_000;
  const o = oauthFromTokenResponse({ access_token: 'a', refresh_token: 'r', expires_in: 60, scope: 'x y' }, {}, profile(1), at);
  assert.deepEqual(o, { accessToken: 'a', refreshToken: 'r', expiresAt: at + 60_000, scopes: ['x', 'y'], subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' });
  // A refresh answer without a new refresh token keeps the old one.
  assert.equal(oauthFromTokenResponse({ access_token: 'b' }, o).refreshToken, 'r');
  assert.equal(profileSummary(profile(3)).key, 'acct-3:org-3');
});

test('switching rewrites only the account part of .credentials.json', () => {
  const dir = tempDir();
  const files = createClaudeFiles({ claudeDir: dir, claudeJson: path.join(dir, 'claude.json'), backupDir: path.join(dir, 'b') });
  writeJson(files.credsFile, { claudeAiOauth: { accessToken: 'old' }, trustedDeviceToken: 'old-device', mcpOAuth: { srv: 'keep' } });
  assert.deepEqual(accountPart(readJson(files.credsFile)), { claudeAiOauth: { accessToken: 'old' }, trustedDeviceToken: 'old-device' });
  files.writeAccount({ claudeAiOauth: { accessToken: 'new' } });
  assert.deepEqual(readJson(files.credsFile), { mcpOAuth: { srv: 'keep' }, claudeAiOauth: { accessToken: 'new' } });
  assert.equal(fs.statSync(files.credsFile).mode & 0o777, 0o600);

  writeJson(path.join(dir, 'claude.json'), { projects: { a: 1 }, oauthAccount: { accountUuid: 'x', organizationUuid: 'y' } });
  assert.equal(files.setOauthAccount({ accountUuid: 'x', organizationUuid: 'y' }), false);
  assert.equal(files.setOauthAccount({ accountUuid: 'z', organizationUuid: 'y' }), true);
  assert.deepEqual(readJson(path.join(dir, 'claude.json')), { projects: { a: 1 }, oauthAccount: { accountUuid: 'z', organizationUuid: 'y' } });
});

test('store: timeline lookup, stable colours, settings defaults', () => {
  const file = path.join(tempDir(), 'state.json');
  writeJson(file, { settings: { threshold: 80 }, accounts: [{ id: 'a', colorIdx: 1 }, { id: 'b' }], timeline: [{ ts: 100, id: 'a' }, { ts: 200, id: null }, { ts: 300, id: 'b' }] });
  const store = createStore(file);
  assert.equal(store.state.settings.threshold, 80);
  assert.equal(store.state.settings.autoSwitch, true);
  assert.equal(store.byId('b').colorIdx, 0); // lowest colour not taken
  assert.equal(store.accountAt(50), 'other');
  assert.equal(store.accountAt(150), 'a');
  assert.equal(store.accountAt(250), 'other');
  assert.equal(store.accountAt(1e9), 'b');
});

test('config honours CLAUDE_CONFIG_DIR and CAM_* overrides', () => {
  const c = loadConfig({ CLAUDE_CONFIG_DIR: '/x/claude', CAM_PORT: '9000', CAM_ALLOWED_LOGINS: 'A@b.c, d@e.f', PATH: '' });
  assert.equal(c.claudeDir, '/x/claude');
  assert.equal(c.claudeJson, '/x/claude/.claude.json');
  assert.equal(c.port, 9000);
  assert.deepEqual(c.allowedLogins, ['a@b.c', 'd@e.f']);
});

test('page helpers: model names, plans, numbers, chart buckets', () => {
  assert.deepEqual(modelInfo('claude-opus-5-5'), { fam: 'opus', ver: '5.5' });
  assert.deepEqual(modelInfo('claude-haiku-4-5-20251001'), { fam: 'haiku', ver: '4.5' });
  assert.deepEqual(modelInfo('claude-opus-5'), { fam: 'opus', ver: '5' });
  assert.deepEqual(modelInfo('claude-3-5-sonnet-20241022'), { fam: 'sonnet', ver: '3.5' });
  assert.deepEqual(modelInfo('<synthetic>'), { fam: 'other', ver: null });
  assert.equal(plan({ plan: 'team', rateLimitTier: 'default_claude_max_5x' }), 'Team 5x');
  assert.equal(plan({ plan: 'pro', rateLimitTier: 'default_claude_pro' }), 'Pro');
  assert.equal(compact(950), '950');
  assert.equal(compact(1234), '1.2K');
  assert.equal(compact(98_200_000), '98M');
  assert.deepEqual(axisStep(23_000_000), { step: 10_000_000, top: 30_000_000 });
  const now = new Date(2026, 9, 18, 12, 30).getTime();
  assert.equal(chartBins('24h', null, now).out.length, 24);
  assert.equal(chartBins('7d', null, now).out.length, 7);
  assert.equal(chartBins('30d', null, now).out.length, 30);
  assert.equal(chartBins('all', new Date(2026, 6, 1).getTime(), now).out.length, 16); // > 60 days -> weekly
});
