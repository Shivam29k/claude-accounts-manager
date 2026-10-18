// The real manager, token index and HTTP server against temp directories and a fake Anthropic.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createClaudeFiles } from '../src/claude-files.mjs';
import { createHttpServer } from '../src/http.mjs';
import { createManager } from '../src/manager.mjs';
import { createStore } from '../src/store.mjs';
import { createTokenIndex } from '../src/tokens.mjs';
import { fakeAnthropic, oauth, profile, readJson, tempDir, usageAt, writeJson } from './helpers.mjs';

function setup({ warmup = null } = {}) {
  const dir = tempDir();
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const claudeJson = path.join(dir, 'claude.json');
  // Claude Code is signed in to account 1, and has an unrelated MCP token in the same file.
  writeJson(path.join(claudeDir, '.credentials.json'), { claudeAiOauth: oauth(1), mcpOAuth: { server: 'keep-me' } });
  writeJson(claudeJson, { projects: { keep: true }, oauthAccount: { accountUuid: 'acct-1', organizationUuid: 'org-1' } });
  const anthropic = fakeAnthropic();
  anthropic.owners.set('at-1-1', 1);
  const store = createStore(path.join(dir, 'state.json'));
  const files = createClaudeFiles({ claudeDir, claudeJson, backupDir: path.join(dir, 'backups') });
  const manager = createManager({ store, files, anthropic, warmup });
  return { dir, claudeDir, claudeJson, anthropic, store, files, manager, creds: () => readJson(files.credsFile) };
}

async function addAccount(env, n) {
  env.anthropic.nextExchange.account = n;
  const { url } = env.manager.startLogin({});
  const state = new URL(url).searchParams.get('state');
  return env.manager.finishLogin({ code: `code#${state}` });
}

test('first start saves the current login, then accounts can be added and switched', async () => {
  const env = setup();
  await env.manager.start();
  assert.equal(env.store.state.accounts.length, 1);
  const a1 = env.store.state.accounts[0];
  assert.equal(env.store.state.activeId, a1.id);
  assert.equal(a1.email, 'user1@example.com');

  const { id: id2 } = await addAccount(env, 2);
  assert.equal(env.store.state.accounts.length, 2);
  assert.equal(env.store.state.activeId, a1.id, 'adding does not switch');

  await env.manager.switchTo(id2);
  const creds = env.creds();
  assert.match(creds.claudeAiOauth.accessToken, /^at-2-/);
  assert.deepEqual(creds.mcpOAuth, { server: 'keep-me' }, 'machine-wide keys survive a switch');
  const cfg = readJson(env.claudeJson);
  assert.equal(cfg.oauthAccount.accountUuid, 'acct-2');
  assert.deepEqual(cfg.projects, { keep: true });
  assert.equal(env.store.state.activeId, id2);
  assert.ok(fs.readdirSync(path.join(env.dir, 'backups')).length >= 1, 'live file backed up before the switch');
  assert.equal(env.store.state.events[0].data.to, id2);
});

test('auto-switch moves to the account with the most room', async () => {
  const env = setup();
  await env.manager.start();
  const { id: id2 } = await addAccount(env, 2);
  const { id: id3 } = await addAccount(env, 3);
  env.anthropic.usage.set(1, usageAt(96));
  env.anthropic.usage.set(2, usageAt(60));
  env.anthropic.usage.set(3, usageAt(20));
  await env.manager.refreshUsage();
  assert.equal(env.store.state.activeId, id3);
  assert.equal(env.store.state.events[0].data.auto, true);
  assert.notEqual(env.store.state.activeId, id2);
});

test('per-account limits: leave at your own limit, only go where there is room under theirs', async () => {
  const env = setup();
  await env.manager.start();
  const a1 = env.store.state.accounts[0];
  const { id: id2 } = await addAccount(env, 2);
  const { id: id3 } = await addAccount(env, 3);
  await env.manager.updateAccount({ id: a1.id, threshold: 70 });
  await env.manager.updateAccount({ id: id2, threshold: 50 });
  env.anthropic.usage.set(1, usageAt(75)); // past its own 70% (global is 90%)
  env.anthropic.usage.set(2, usageAt(60)); // least used, but past its own 50%
  env.anthropic.usage.set(3, usageAt(80)); // 10 points of room under the global 90%
  await env.manager.refreshUsage();
  assert.equal(env.store.state.activeId, id3);
  assert.equal(env.store.state.events[0].data.limit, 70);

  const pub = env.manager.publicState().accounts;
  assert.deepEqual(pub.map((a) => [a.threshold, a.limit]), [[70, 70], [50, 50], [null, 90]]);
  await env.manager.updateAccount({ id: id2, threshold: null });
  assert.equal(env.manager.publicState().accounts.find((a) => a.id === id2).limit, 90);
  await env.manager.updateAccount({ id: id2, threshold: 3 });
  assert.equal(env.store.byId(id2).threshold, 10, 'clamped to 10-100');
});

test('auto-switch stays put when every account is past the threshold', async () => {
  const env = setup();
  await env.manager.start();
  const before = env.store.state.activeId;
  await addAccount(env, 2);
  env.anthropic.usage.set(1, usageAt(97));
  env.anthropic.usage.set(2, usageAt(99));
  await env.manager.refreshUsage();
  assert.equal(env.store.state.activeId, before);
  assert.equal(env.store.state.events[0].data.kind, 'stuck');
});

test('picks up tokens Claude Code refreshed on its own', async () => {
  const env = setup();
  await env.manager.start();
  const a1 = env.store.state.accounts[0];
  env.anthropic.owners.set('at-1-9', 1);
  env.files.writeAccount({ claudeAiOauth: { ...oauth(1), accessToken: 'at-1-9', refreshToken: 'rt-1-9' } });
  await env.manager.tick();
  assert.equal(a1.creds.claudeAiOauth.refreshToken, 'rt-1-9');
  assert.equal(env.store.state.activeId, a1.id);
});

test('sign-in: stale links are rejected and a 429 pauses further attempts', async () => {
  const env = setup();
  await env.manager.start();
  await assert.rejects(env.manager.finishLogin({ code: 'code#not-a-link' }), (e) => e.data.staleLink === true);

  env.manager.startLogin({});
  env.anthropic.failExchangeWith(429);
  await assert.rejects(env.manager.finishLogin({ code: 'code' }), (e) => e.data.blockedUntil > Date.now());
  env.manager.startLogin({});
  await assert.rejects(env.manager.finishLogin({ code: 'code' }), /rate-limiting/);
  assert.equal(env.anthropic.calls.exchange, 1, 'no second request while blocked');
  assert.ok(env.manager.publicState().signinBlockedUntil > Date.now());
});

test('auto-start messages only idle accounts that are switched on, at most once per 15 minutes', async () => {
  const sent = [];
  const env = setup({ warmup: { run: async (token) => (sent.push(token), { ok: true }) } });
  await env.manager.start();
  const { id: id2 } = await addAccount(env, 2);
  await addAccount(env, 3);
  env.anthropic.usage.set(1, usageAt(30)); // window running
  env.anthropic.usage.set(2, { five_hour: null }); // idle
  env.anthropic.usage.set(3, { five_hour: { utilization: 0, resets_at: null } }); // idle
  await env.manager.refreshUsage();

  await env.manager.tick(); // feature is off by default
  assert.equal(sent.length, 0);

  await env.manager.updateAccount({ id: id2, warmup: true }); // one account on -> mode "some"
  assert.equal(env.store.state.settings.warmup, 'some');
  await env.manager.tick();
  assert.deepEqual(sent.map((t) => t.split('-')[1]), ['2']);

  await env.manager.updateSettings({ warmup: 'all' });
  await env.manager.tick();
  assert.deepEqual(sent.map((t) => t.split('-')[1]), ['2', '3'], 'account 2 waits out its 15 minutes, account 1 is running');
  const st = env.manager.publicState().accounts.find((a) => a.id === id2);
  assert.equal(st.warmupOn, true);
  assert.equal(env.store.state.events.filter((e) => e.data?.kind === 'warmup').length, 2);
});

test('public state never contains tokens', async () => {
  const env = setup();
  await env.manager.start();
  await addAccount(env, 2);
  const text = JSON.stringify(env.manager.publicState());
  assert.doesNotMatch(text, /at-\d|rt-\d|verifier/);
});

test('token index: de-duplicates, follows appends, attributes by timeline', async () => {
  const dir = tempDir();
  const projects = path.join(dir, 'projects', 'p');
  fs.mkdirSync(projects, { recursive: true });
  const t0 = Date.UTC(2026, 9, 1, 10, 0);
  const line = (id, ts, model = 'claude-opus-5-5') =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId: `req-${id}`, message: { id: `msg-${id}`, model, usage: { input_tokens: 1, output_tokens: 9, cache_creation_input_tokens: 90, cache_read_input_tokens: 1000 } } });
  const file = path.join(projects, 's.jsonl');
  // Claude writes one line per content block; the second line repeats the same usage.
  fs.writeFileSync(file, `${line(1, t0)}\n${line(1, t0)}\n${line(2, t0 + 3600_000, 'claude-sonnet-5-5')}\n`);
  const tokens = createTokenIndex({ projectsDir: path.join(dir, 'projects'), file: path.join(dir, 'tokens.json'), accountAt: (ts) => (ts < t0 + 1800_000 ? 'acc-a' : 'acc-b') });
  await tokens.scan();
  let s = tokens.series(0);
  assert.deepEqual(s.hours.map(([, row]) => row), [{ 'acc-a': 100 }, { 'acc-b': 100 }]);
  assert.deepEqual(s.models.map(([, row]) => row), [{ 'claude-opus-5-5': 100 }, { 'claude-sonnet-5-5': 100 }]);

  fs.appendFileSync(file, `${line(3, t0 + 3600_000)}\n${line(2, t0 + 3600_000, 'claude-sonnet-5-5')}\n`);
  await tokens.scan();
  s = tokens.series(0);
  assert.deepEqual(s.hours.at(-1)[1], { 'acc-b': 200 });
});

test('http: static whitelist, CSRF header, Tailscale login filter', async (t) => {
  const manager = { publicState: () => ({ ok: 1 }), switchMachine: async (_machine, id) => ({ switched: id }) };
  const tokens = { series: () => ({ hours: [], models: [], ready: true }) };
  const publicDir = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'public');
  const start = (opts) =>
    new Promise((resolve) => {
      const server = createHttpServer({ manager, tokens, publicDir, ...opts }).listen(0, '127.0.0.1', () => resolve(server));
    });
  const open = await start({});
  const closed = await start({ allowedLogins: ['me@example.com'] });
  t.after(() => {
    open.close();
    closed.close();
  });
  const base = (s) => `http://127.0.0.1:${s.address().port}`;

  assert.equal((await fetch(`${base(open)}/`)).status, 200);
  assert.equal((await fetch(`${base(open)}/app.js`)).status, 200);
  assert.equal((await fetch(`${base(open)}/../server.mjs`)).status, 404);
  assert.equal((await fetch(`${base(open)}/src/manager.mjs`)).status, 404);
  assert.equal((await fetch(`${base(open)}/api/switch`, { method: 'POST', body: '{"id":"x"}' })).status, 403);
  const ok = await fetch(`${base(open)}/api/switch`, { method: 'POST', headers: { 'X-CAM': '1' }, body: '{"id":"x"}' });
  assert.deepEqual(await ok.json(), { switched: 'x' });

  assert.equal((await fetch(`${base(closed)}/api/state`)).status, 403);
  assert.equal((await fetch(`${base(closed)}/api/state`, { headers: { 'Tailscale-User-Login': 'Me@Example.com' } })).status, 200);
});

test('profile helper sanity', () => {
  assert.equal(profile(7).account.email, 'user7@example.com');
});
