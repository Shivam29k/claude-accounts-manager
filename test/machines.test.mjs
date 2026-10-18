// Other machines: pairing, agent check-ins, switching and auto-switch across machines, and the
// agent itself against a real hub HTTP server (fake Anthropic, temp directories).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createTokenCounter, credentialStore, keychainService, syncOnce, tokenHash, writeLogin } from '../agent/agent.mjs';
import { createClaudeFiles } from '../src/claude-files.mjs';
import { createHttpServer } from '../src/http.mjs';
import { createManager } from '../src/manager.mjs';
import { createStore } from '../src/store.mjs';
import { createTokenIndex } from '../src/tokens.mjs';
import { fakeAnthropic, oauth, readJson, tempDir, usageAt, writeJson } from './helpers.mjs';

function setup() {
  const dir = tempDir();
  const claudeDir = path.join(dir, 'claude');
  fs.mkdirSync(claudeDir);
  const claudeJson = path.join(dir, 'claude.json');
  writeJson(path.join(claudeDir, '.credentials.json'), { claudeAiOauth: oauth(1) });
  writeJson(claudeJson, { oauthAccount: { accountUuid: 'acct-1', organizationUuid: 'org-1' } });
  const anthropic = fakeAnthropic();
  anthropic.owners.set('at-1-1', 1);
  const store = createStore(path.join(dir, 'state.json'));
  const files = createClaudeFiles({ claudeDir, claudeJson, backupDir: path.join(dir, 'backups') });
  const tokens = createTokenIndex({ projectsDir: path.join(dir, 'projects'), file: path.join(dir, 'tokens.json'), accountAt: store.accountAt });
  const manager = createManager({
    store,
    files,
    anthropic,
    remoteTokens: (mid, slots) => tokens.addRemote(mid, slots, (ts) => store.accountAtOn(mid, ts)),
  });
  return { dir, anthropic, store, manager, tokens };
}

async function addAccount(env, n) {
  env.anthropic.nextExchange.account = n;
  const { url } = env.manager.startLogin({});
  return env.manager.finishLogin({ code: `code#${new URL(url).searchParams.get('state')}` });
}

async function pair(env, name = 'Laptop') {
  const { code } = env.manager.createPairCode();
  return env.manager.pairMachine({ code: code.toLowerCase(), name, os: 'darwin', hostname: 'laptop.local' });
}

test('pairing codes work once and only until they expire', async () => {
  const env = setup();
  await env.manager.start();
  const { code } = env.manager.createPairCode();
  const m = await env.manager.pairMachine({ code, name: 'Mac' });
  assert.equal(m.name, 'Mac');
  assert.ok(m.token.length > 30);
  assert.equal(env.manager.machineByToken(m.token).id, m.machineId);
  assert.equal(env.manager.machineByToken('nope'), undefined);
  await assert.rejects(env.manager.pairMachine({ code }), /wrong or expired/);
  const stored = JSON.stringify(env.store.state);
  assert.ok(!stored.includes(m.token), 'only a hash of the machine token is kept');

  const { code: old } = env.manager.createPairCode();
  env.store.state.pairCodes.at(-1).at -= 16 * 60_000;
  await assert.rejects(env.manager.pairMachine({ code: old }), /wrong or expired/);
});

test('a machine’s existing login is adopted, then it gets access tokens only', async () => {
  const env = setup();
  await env.manager.start();
  const p = await pair(env);
  const m = env.manager.machineByToken(p.token);

  // The laptop is signed in to account 5, which the hub doesn't know yet.
  env.anthropic.owners.set('at-5-1', 5);
  const out = await env.manager.agentSync(m, { live: 'foreign', foreign: { claudeAiOauth: oauth(5) }, have: tokenHash('at-5-1') });
  const acc5 = env.store.state.accounts.find((a) => a.email === 'user5@example.com');
  assert.ok(acc5, 'the new account was saved on the hub');
  assert.equal(acc5.creds.claudeAiOauth.refreshToken, 'rt-5-1', 'the hub keeps the refresh token');
  assert.equal(m.activeId, acc5.id);
  assert.equal(out.creds.claudeAiOauth.accessToken, 'at-5-1');
  assert.equal(out.creds.claudeAiOauth.refreshToken, undefined, 'machines never get refresh tokens');
  assert.equal(out.creds.claudeAiOauth.refreshTokenExpiresAt, undefined);
  assert.equal(out.hash, tokenHash('at-5-1'));
  assert.match(env.store.state.events.find((e) => e.data?.kind === 'added').msg, /signed in on Laptop/);

  // A login for an account the hub already has: the machine moves to it, the hub keeps its own copy.
  const before = env.store.state.accounts[0].creds.claudeAiOauth.refreshToken;
  env.anthropic.owners.set('at-1-77', 1);
  await env.manager.agentSync(m, { live: 'foreign', foreign: { claudeAiOauth: { ...oauth(1), accessToken: 'at-1-77', refreshToken: 'rt-1-77' } } });
  assert.equal(m.activeId, env.store.state.accounts[0].id);
  assert.equal(env.store.state.accounts[0].creds.claudeAiOauth.refreshToken, before);
  assert.equal(env.store.state.accounts.length, 2);

  const pub = env.manager.publicState();
  assert.deepEqual(pub.machines.map((x) => [x.local, x.name, x.online]), [[true, pub.machines[0].name, true], [false, 'Laptop', true]]);
  assert.doesNotMatch(JSON.stringify(pub), /at-\d|rt-\d|tokenHash/);
});

test('switching another machine, and the hub renews its token ahead of expiry', async () => {
  const env = setup();
  await env.manager.start();
  const { id: id2 } = await addAccount(env, 2);
  const p = await pair(env);
  const m = env.manager.machineByToken(p.token);
  await env.manager.switchMachine(m.id, id2);
  assert.equal(m.activeId, id2);
  assert.notEqual(env.store.state.activeId, id2, 'this machine is unchanged');
  assert.equal(env.store.state.events[0].data.machine, m.id);
  assert.match(env.store.state.events[0].msg, /Switched on Laptop/);

  // Close to expiry: the next check-in refreshes on the hub and hands out the new token.
  const acc2 = env.store.byId(id2);
  acc2.creds.claudeAiOauth.expiresAt = Date.now() + 20 * 60_000; // inside the 30-minute margin
  const out = await env.manager.agentSync(m, {});
  assert.notEqual(out.creds.claudeAiOauth.accessToken, 'at-2-101');
  assert.equal(out.creds.claudeAiOauth.accessToken, acc2.creds.claudeAiOauth.accessToken);
  assert.ok(acc2.creds.claudeAiOauth.expiresAt > Date.now() + 30 * 60_000);

  await env.manager.removeMachine(m.id);
  assert.equal(env.manager.machineByToken(p.token), undefined);
});

test('auto-switch moves each machine, preferring accounts no other machine is on', async () => {
  const env = setup();
  await env.manager.start();
  const a1 = env.store.state.accounts[0];
  const { id: id2 } = await addAccount(env, 2);
  const { id: id3 } = await addAccount(env, 3);
  const p = await pair(env);
  const m = env.manager.machineByToken(p.token);
  await env.manager.switchMachine(m.id, a1.id); // both machines on account 1
  await env.manager.agentSync(m, {}); // online
  env.anthropic.usage.set(1, usageAt(95));
  env.anthropic.usage.set(2, usageAt(10)); // most room
  env.anthropic.usage.set(3, usageAt(40));
  await env.manager.refreshUsage();
  // This machine goes first and takes account 2; the laptop then avoids it for account 3.
  assert.equal(env.store.state.activeId, id2);
  assert.equal(m.activeId, id3);
  assert.equal(env.store.state.events.filter((e) => e.type === 'switch' && e.data.auto).length, 2);
});

test('token counts from a machine are attributed to the account it used then', async () => {
  const env = setup();
  await env.manager.start();
  const a1 = env.store.state.accounts[0];
  const p = await pair(env);
  const m = env.manager.machineByToken(p.token);
  const t0 = Date.now() - 2 * 3600_000;
  m.timeline = [{ ts: t0 - 1, id: a1.id }];
  const slot = Math.floor(t0 / 1800_000) * 1800_000 + 1800_000;
  await env.manager.agentSync(m, { tokens: { seq: 1, slots: [[slot, { 'claude-opus-5-5': 300, 'claude-haiku-5-5': 100 }], [slot - 86400_000 * 30, { 'claude-opus-5-5': 50 }]] } });
  await env.manager.agentSync(m, { tokens: { seq: 1, slots: [[slot, { 'claude-opus-5-5': 999 }]] } }); // a resend is ignored
  const s = env.tokens.series(0);
  assert.deepEqual(s.hours.map(([, row]) => row), [{ other: 50 }, { [a1.id]: 400 }]);
  assert.deepEqual(s.machines.map(([, row]) => row), [{ [m.id]: 50 }, { [m.id]: 400 }]);
  assert.deepEqual(s.models.at(-1)[1], { 'claude-opus-5-5': 300, 'claude-haiku-5-5': 100 });
});

test('agent: pairs over HTTP, writes the login without a refresh token, follows a switch', async (t) => {
  const env = setup();
  await env.manager.start();
  const { id: id2 } = await addAccount(env, 2);
  const server = await new Promise((resolve) => {
    const s = createHttpServer({ manager: env.manager, tokens: env.tokens, publicDir: env.dir, agentWaitMs: 1500 }).listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => server.close());
  const hub = `http://127.0.0.1:${server.address().port}`;

  const { code } = env.manager.createPairCode();
  const pairRes = await fetch(`${hub}/agent/pair`, { method: 'POST', body: JSON.stringify({ code, name: 'Box' }) }).then((r) => r.json());
  assert.ok(pairRes.token);
  const unauth = await fetch(`${hub}/agent/sync`, { method: 'POST', body: '{}' });
  assert.equal(unauth.status, 401);

  // The machine: Claude Code signed in to account 1 already, plus an MCP token to keep.
  const box = tempDir();
  const paths = { configDir: box, claudeDir: box, claudeJson: path.join(box, '.claude.json') };
  writeJson(path.join(box, '.credentials.json'), { claudeAiOauth: { ...oauth(1), accessToken: 'at-1-50', refreshToken: 'rt-1-50' }, mcpOAuth: { s: 'keep' } });
  writeJson(paths.claudeJson, { projects: {}, oauthAccount: { accountUuid: 'acct-1', organizationUuid: 'org-1' } });
  env.anthropic.owners.set('at-1-50', 1);
  const store = credentialStore({ platform: 'linux', paths });
  const cfg = { hub, token: pairRes.token };
  const state = {};
  const backupDir = path.join(box, 'backups');
  const sync = (o = {}) => syncOnce({ cfg, store, paths, state, backupDir, ...o });

  let res = await sync();
  const m = env.manager.machineByToken(pairRes.token);
  assert.equal(m.activeId, env.store.state.accounts[0].id, 'adopted as account 1');
  let creds = readJson(path.join(box, '.credentials.json'));
  assert.equal(creds.claudeAiOauth.accessToken, env.store.state.accounts[0].creds.claudeAiOauth.accessToken, 'the hub’s token replaced the local one');
  assert.equal(creds.claudeAiOauth.refreshToken, undefined);
  assert.deepEqual(creds.mcpOAuth, { s: 'keep' });
  assert.equal(fs.statSync(path.join(box, '.credentials.json')).mode & 0o777, 0o600);
  assert.equal(state.wrote, tokenHash(creds.claudeAiOauth.accessToken));
  assert.equal(readJson(path.join(backupDir, 'original.json')).claudeAiOauth.refreshToken, 'rt-1-50', 'the replaced login is kept');

  // Nothing changed: the check-in waits (long poll), then answers with the same login.
  const t0 = Date.now();
  res = await sync({ wait: 1000 });
  assert.ok(Date.now() - t0 >= 900, 'held until the wait ran out');

  // A switch on the dashboard ends the wait early and reaches the machine.
  const pending = sync({ wait: 1000 });
  await env.manager.switchMachine(m.id, id2);
  res = await pending;
  creds = readJson(path.join(box, '.credentials.json'));
  assert.match(creds.claudeAiOauth.accessToken, /^at-2-/);
  assert.equal(res.account.email, 'user2@example.com');
  assert.equal(readJson(paths.claudeJson).oauthAccount.accountUuid, 'acct-2');
  assert.deepEqual(readJson(paths.claudeJson).projects, {});

  // A credentials file it can't parse is reported and left untouched.
  fs.writeFileSync(path.join(box, '.credentials.json'), '{"claudeAiOauth": {"acc');
  await env.manager.switchMachine(m.id, env.store.state.accounts[0].id);
  await sync();
  assert.equal(fs.readFileSync(path.join(box, '.credentials.json'), 'utf8'), '{"claudeAiOauth": {"acc');
  assert.match(m.warnings.join(), /can't update the login here: .*isn't valid JSON/);
});

// A stand-in for macOS `security`, backed by a JSON file. Like the real one, `-i` cuts lines at
// 4 KB and echoes what it can't run to stderr (secrets included).
function fakeSecurity(dir) {
  const bin = path.join(dir, 'security');
  const db = path.join(dir, 'kc.json');
  fs.writeFileSync(db, '{}');
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node
const fs = require('fs'), db = ${JSON.stringify(db)}, kc = JSON.parse(fs.readFileSync(db, 'utf8'));
const a = process.argv.slice(2), opt = (args, f) => args[args.indexOf(f) + 1];
const add = (args) => { kc[opt(args, '-s')] = Buffer.from(opt(args, '-X'), 'hex').toString('utf8'); fs.writeFileSync(db, JSON.stringify(kc)); };
if (a[0] === 'find-generic-password') { const v = kc[opt(a, '-s')]; if (v === undefined) process.exit(44); process.stdout.write(v + '\\n'); }
else if (a[0] === 'add-generic-password') add(a);
else if (a[0] === '-i') {
  const line = fs.readFileSync(0, 'utf8').trim();
  if (line.length > 4096) { process.stderr.write('security: unknown command "' + line.slice(4096) + '": returned 1\\n'); process.exit(1); }
  add(line.match(/"[^"]*"|\\S+/g).map((t) => t.replace(/^"|"$/g, '')));
}`,
    { mode: 0o755 },
  );
  return { bin, db, items: () => JSON.parse(fs.readFileSync(db, 'utf8')) };
}

test('agent on macOS: big Keychain items are written whole, other keys kept, errors carry no secrets', () => {
  const dir = tempDir();
  const sec = fakeSecurity(dir);
  const paths = { configDir: '', claudeDir: dir, claudeJson: path.join(dir, '.claude.json') };
  const store = credentialStore({ platform: 'darwin', paths, security: sec.bin });
  assert.equal(store.read(), null, 'no item yet');
  // An existing login with lots of MCP tokens: well past security's 4 KB line limit.
  const mcpOAuth = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`server-${i}`, { accessToken: `mcp-secret-${i}-${'x'.repeat(60)}` }]));
  store.write({ claudeAiOauth: oauth(1), mcpOAuth });
  writeLogin(store, { accessToken: 'at-2-1', expiresAt: 1 }, path.join(dir, 'backups'));
  const saved = JSON.parse(sec.items()['Claude Code-credentials']);
  assert.deepEqual(saved.mcpOAuth, mcpOAuth);
  assert.deepEqual(saved.claudeAiOauth, { accessToken: 'at-2-1', expiresAt: 1 });
  assert.deepEqual(readJson(path.join(dir, 'backups', 'original.json')).mcpOAuth, mcpOAuth);

  // An item that isn't JSON is never overwritten.
  fs.writeFileSync(sec.db, JSON.stringify({ 'Claude Code-credentials': '{"claudeAiOauth": trunc' }));
  assert.throws(() => writeLogin(store, { accessToken: 'at-3-1' }), /isn't readable JSON/);
  assert.equal(sec.items()['Claude Code-credentials'], '{"claudeAiOauth": trunc');

  // A failing `security -i` (which echoes the secret) produces an error without it.
  const failing = credentialStore({ platform: 'darwin', paths, security: '/bin/false' });
  assert.throws(() => failing.write({ claudeAiOauth: { accessToken: 'secret-at' } }), (e) => !/secret|[0-9a-f]{40}/.test(e.message));
});

test('agent token counter: counts once, batches, resends until acknowledged', async () => {
  const dir = tempDir();
  const projects = path.join(dir, 'projects', 'p');
  fs.mkdirSync(projects, { recursive: true });
  const line = (id, ts, model) =>
    JSON.stringify({ type: 'assistant', timestamp: new Date(ts).toISOString(), requestId: `r${id}`, message: { id: `m${id}`, model, usage: { input_tokens: 1, output_tokens: 9, cache_creation_input_tokens: 90, cache_read_input_tokens: 5000 } } });
  const t0 = Date.UTC(2026, 9, 1, 10, 5);
  fs.writeFileSync(path.join(projects, 's.jsonl'), `${line(1, t0, 'claude-opus-5-5')}\n${line(1, t0, 'claude-opus-5-5')}\n${line(2, t0, 'claude-haiku-5-5')}\n{"partial`);
  const file = path.join(dir, 'tokens.json');
  let c = createTokenCounter({ projectsDir: path.join(dir, 'projects'), file });
  await c.scan();
  const b = c.batch();
  assert.deepEqual(b, { seq: 1, slots: [[Date.UTC(2026, 9, 1, 10, 0), { 'claude-opus-5-5': 100, 'claude-haiku-5-5': 100 }]] });
  c.ack(0); // not applied yet
  assert.equal(c.batch().seq, 1, 'same batch again');

  // A restart reads the rest of the half-written line, and keeps the unacknowledged batch.
  fs.appendFileSync(path.join(projects, 's.jsonl'), `x":1}\n${line(3, t0 + 3600_000, 'claude-opus-5-5')}\n`);
  c = createTokenCounter({ projectsDir: path.join(dir, 'projects'), file });
  await c.scan();
  assert.equal(c.batch().seq, 1);
  c.ack(7); // the hub is ahead: resend as 8
  assert.equal(c.batch().seq, 8);
  c.ack(8);
  const next = c.batch();
  assert.equal(next.seq, 9);
  assert.deepEqual(next.slots, [[Date.UTC(2026, 9, 1, 11, 0), { 'claude-opus-5-5': 100 }]]);
});

test('agent: Keychain item names match Claude Code’s', () => {
  assert.equal(keychainService(''), 'Claude Code-credentials');
  // Claude Code 2.1.x: "-" + the first 8 hex characters of sha256(CLAUDE_CONFIG_DIR), checked on a real Mac.
  assert.equal(keychainService('/Users/me/claude'), 'Claude Code-credentials-41769e1b');
});
