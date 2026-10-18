#!/usr/bin/env node
// Claude Accounts Manager agent. Runs on each of your other machines and keeps Claude Code there
// signed in to the account the hub (the machine running the Claude Accounts Manager app) picks.
//
//   node agent.mjs setup <hub url> <code> [--name "My laptop"]   pair with the hub, install as a service
//   node agent.mjs run                                         the loop the service runs
//   node agent.mjs status
//   node agent.mjs uninstall                                   remove the service and forget the hub
//
// The hub only ever sends access tokens. Refresh tokens stay on the hub, which renews logins
// before they expire, so Claude Code here never refreshes (and rotates) a shared login itself.
// Where the login lives:
//   macOS:          the login Keychain, item "Claude Code-credentials" (what Claude Code uses there)
//   Linux, Windows: <claude dir>/.credentials.json
// Running Claude Code sessions pick up a new login by themselves (macOS: within about 30 s).
//
// Also sends the hub token counts from this machine's Claude Code transcripts, for the chart.
// No dependencies; needs Node.js 20 or newer.

import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_VERSION = '1';
const HOME = os.homedir();
const DIR = process.env.CAM_AGENT_DIR || path.join(HOME, '.claude-accounts-agent');
const CONFIG = path.join(DIR, 'config.json');
const TOKENS = path.join(DIR, 'tokens.json');
const SERVICE = 'claude-accounts-agent';
const MAC_LABEL = 'com.claude-accounts-manager.agent';
const WIN_TASK = 'Claude Accounts Agent';

// Keys of Claude Code's credentials that belong to the signed-in account; others (MCP tokens) stay.
const ACCOUNT_KEYS = ['claudeAiOauth', 'trustedDeviceToken', 'trustedDeviceEnrolledAfterRefusalAtMs'];

const log = (...a) => console.log(new Date().toISOString().replace('T', ' ').slice(0, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tokenHash = (t) => (t ? crypto.createHash('sha256').update(String(t)).digest('hex').slice(0, 16) : null);

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, obj, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.cam-tmp.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode });
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, file);
}

// ---------- where Claude Code keeps its login ----------

export function claudePaths(env = process.env) {
  const configDir = env.CLAUDE_CONFIG_DIR || '';
  const claudeDir = configDir || path.join(HOME, '.claude');
  return { configDir, claudeDir, claudeJson: configDir ? path.join(configDir, '.claude.json') : path.join(HOME, '.claude.json') };
}

// Claude Code's Keychain item name: one per config directory.
export function keychainService(configDir) {
  const suffix = configDir ? `-${crypto.createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)}` : '';
  return `Claude Code-credentials${suffix}`;
}

function keychainAccount() {
  let u;
  try {
    u = process.env.USER || os.userInfo().username;
  } catch {
    u = 'claude-code-user';
  }
  return /^[a-zA-Z0-9._-]+$/.test(u) ? u : 'claude-code-user';
}

function parseSecret(raw) {
  if (!raw) return null;
  for (const t of [raw, /^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, 'hex').toString('utf8') : null]) {
    try {
      if (t) return JSON.parse(t);
    } catch {}
  }
  return null;
}

// { read() -> object | null, write(object) } for Claude Code's whole credentials blob.
export function credentialStore({ platform = process.platform, paths = claudePaths(), security = '/usr/bin/security' } = {}) {
  if (platform === 'darwin') {
    const svc = keychainService(paths.configDir);
    const acct = keychainAccount();
    return {
      where: `Keychain item "${svc}"`,
      read() {
        try {
          return parseSecret(execFileSync(security, ['find-generic-password', '-s', svc, '-a', acct, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim());
        } catch {
          return null;
        }
      },
      write(obj) {
        // Through stdin, so the secret never shows up in a process list.
        const hex = Buffer.from(JSON.stringify(obj)).toString('hex');
        execFileSync(security, ['-i'], { input: `add-generic-password -U -a "${acct}" -s "${svc}" -X "${hex}"\n`, stdio: ['pipe', 'ignore', 'pipe'] });
      },
    };
  }
  const file = path.join(paths.claudeDir, '.credentials.json');
  return { where: file, read: () => readJson(file), write: (obj) => writeJsonAtomic(file, obj) };
}

// Put this account's login in, keeping everything else in the blob.
export function writeLogin(store, claudeAiOauth) {
  const cur = store.read() || {};
  for (const k of ACCOUNT_KEYS) delete cur[k];
  store.write({ ...cur, claudeAiOauth });
}

// ~/.claude.json "oauthAccount": the profile Claude Code shows (email, organization).
export function setOauthAccount(claudeJson, oauthAccount) {
  if (!oauthAccount) return false;
  const cfg = readJson(claudeJson);
  if (!cfg) return false;
  const cur = cfg.oauthAccount || {};
  if (cur.accountUuid === oauthAccount.accountUuid && cur.organizationUuid === oauthAccount.organizationUuid) return false;
  cfg.oauthAccount = { ...oauthAccount };
  let mode = 0o600;
  try {
    mode = fs.statSync(claudeJson).mode & 0o777;
  } catch {}
  writeJsonAtomic(claudeJson, cfg, mode);
  return true;
}

// Things that make Claude Code ignore the subscription login, so switching wouldn't affect it.
function warnings(paths) {
  const out = [];
  const vars = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
  for (const f of ['settings.json', 'settings.local.json']) {
    const s = readJson(path.join(paths.claudeDir, f));
    if (s?.apiKeyHelper) out.push(`${f} sets apiKeyHelper, which overrides the subscription login.`);
    for (const v of vars) if (s?.env?.[v]) out.push(`${f} sets ${v}, which overrides the subscription login.`);
  }
  if (readJson(paths.claudeJson)?.primaryApiKey) out.push('.claude.json holds an API-key login (primaryApiKey); Claude Code may use it instead of a subscription.');
  return out;
}

let claudeVersion = { at: 0, v: '' };
function readClaudeVersion() {
  if (Date.now() - claudeVersion.at < 6 * 3600_000) return claudeVersion.v;
  claudeVersion.at = Date.now();
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  const dirs = [...(process.env.PATH || '').split(path.delimiter), path.join(HOME, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const d of dirs.filter(Boolean)) {
    const p = path.join(d, exe);
    if (!fs.existsSync(p)) continue;
    execFile(p, ['--version'], { timeout: 15_000 }, (err, out) => {
      if (!err) claudeVersion.v = String(out).trim().split(/\s/)[0].slice(0, 40);
    });
    break;
  }
  return claudeVersion.v;
}

// ---------- token counts from Claude Code transcripts ----------
// Same counting as the hub: input + output + cache writes per assistant message, de-duplicated by
// message id + request id, in half-hour slots, per model. Only totals leave this machine.

const SLOT = 1800_000;

export function createTokenCounter({ projectsDir, file }) {
  const st = { files: {}, seen: [], pending: {}, batch: null, seq: 0, ...(readJson(file) || {}) };
  const seen = new Set(st.seen);

  function list(dir, out = []) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) list(p, out);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
    }
    return out;
  }

  function onLine(line) {
    if (!line.includes('"usage"') || !line.includes('"assistant"')) return;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      return;
    }
    const m = d?.message;
    const u = m?.usage;
    if (d.type !== 'assistant' || !u) return;
    const key = crypto.createHash('sha1').update(`${m.id}:${d.requestId}`).digest('base64').slice(0, 14);
    if (seen.has(key)) return;
    seen.add(key);
    const ts = Date.parse(d.timestamp);
    const n = (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0);
    if (!ts || !n) return;
    const slot = Math.floor(ts / SLOT) * SLOT;
    const row = (st.pending[slot] ||= {});
    const model = m.model || 'unknown';
    row[model] = (row[model] || 0) + n;
  }

  async function scan() {
    for (const f of list(projectsDir)) {
      let size;
      try {
        size = fs.statSync(f).size;
      } catch {
        continue;
      }
      let off = st.files[f] || 0;
      if (size < off) off = 0;
      if (size === off) {
        st.files[f] = off;
        continue;
      }
      const fh = await fs.promises.open(f, 'r');
      try {
        let pos = off, carry = Buffer.alloc(0);
        while (pos < size) {
          const buf = Buffer.alloc(Math.min(1 << 20, size - pos));
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          pos += bytesRead;
          const data = carry.length ? Buffer.concat([carry, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
          let start = 0;
          for (let nl = data.indexOf(10); nl !== -1; nl = data.indexOf(10, start)) {
            onLine(data.subarray(start, nl).toString('utf8'));
            start = nl + 1;
          }
          carry = Buffer.from(data.subarray(start));
          off = pos - carry.length; // just past the last complete line
          await sleep(0);
        }
      } finally {
        await fh.close();
      }
      st.files[f] = off;
    }
    for (const f of Object.keys(st.files)) if (!fs.existsSync(f)) delete st.files[f];
    save();
  }

  function save() {
    st.seen = [...seen];
    writeJsonAtomic(file, st);
  }

  return {
    scan,
    // The batch to send: re-sent with the same seq until the hub acknowledges it.
    batch() {
      if (!st.batch) {
        const slots = Object.keys(st.pending).map(Number).sort((a, b) => a - b).slice(0, 1500);
        if (!slots.length) return null;
        st.batch = { seq: ++st.seq, slots: slots.map((t) => [t, st.pending[t]]) };
        for (const t of slots) delete st.pending[t];
        save();
      }
      return st.batch;
    },
    // seq: the last batch number the hub has applied.
    ack(seq) {
      if (!st.batch) {
        if (seq > st.seq) st.seq = seq;
        return;
      }
      if (seq === st.batch.seq) st.batch = null;
      else if (seq > st.batch.seq) st.batch.seq = st.seq = seq + 1; // hub is ahead (this file was reset): resend under a new number
      else return;
      save();
    },
  };
}

// ---------- talking to the hub ----------

async function post(hub, pathname, body, token, timeoutMs = 20_000) {
  const r = await fetch(new URL(pathname, hub), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token && { Authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || `hub answered ${r.status}`), { status: r.status });
  return j;
}

// One round: report, get the login this machine should have, write it if it differs.
export async function syncOnce({ cfg, store, paths, counter = null, wait = 0, state = {} }) {
  const cur = store.read();
  const live = cur?.claudeAiOauth;
  const have = tokenHash(live?.accessToken);
  // A login the hub didn't write: an existing one, or `claude /login` run here. Sent once so the
  // hub can tell whose it is (and save it, if the account is new to it).
  const sent = state.foreignSent;
  const foreign = live?.accessToken && have !== state.wrote && (sent?.hash !== have || Date.now() - sent.at > 5 * 60_000) ? { claudeAiOauth: live } : undefined;
  const batch = counter?.batch() || undefined;
  const res = await post(
    cfg.hub,
    `/agent/sync?wait=${Math.round(wait / 1000)}`,
    {
      have,
      live: !live?.accessToken ? 'none' : have === state.wrote ? 'managed' : 'foreign',
      foreign,
      os: process.platform,
      hostname: os.hostname(),
      agentVersion: AGENT_VERSION,
      claudeVersion: readClaudeVersion(),
      warnings: warnings(paths),
      tokens: batch,
    },
    cfg.token,
    wait + 20_000,
  );
  if (foreign) state.foreignSent = { hash: have, at: Date.now() };
  if (counter && Number.isInteger(res.ackSeq)) counter.ack(res.ackSeq);
  const want = res.creds?.claudeAiOauth;
  if (want?.accessToken && tokenHash(want.accessToken) !== tokenHash(store.read()?.claudeAiOauth?.accessToken)) {
    writeLogin(store, want);
    state.wrote = tokenHash(want.accessToken);
    const who = res.account?.email || res.account?.name || 'the chosen account';
    if (state.lastAccount !== res.account?.id) log(`Claude Code here now uses ${who}`);
    state.lastAccount = res.account?.id;
  } else if (want?.accessToken) state.wrote = tokenHash(want.accessToken);
  if (res.oauthAccount && setOauthAccount(paths.claudeJson, res.oauthAccount)) log('updated the profile in .claude.json');
  return res;
}

async function run() {
  const cfg = readJson(CONFIG);
  if (!cfg?.hub || !cfg?.token) {
    console.error(`Not set up. Run: node ${process.argv[1]} setup <hub url> <code>`);
    process.exit(1);
  }
  const paths = cfg.claudeConfigDir ? claudePaths({ CLAUDE_CONFIG_DIR: cfg.claudeConfigDir }) : claudePaths();
  const store = credentialStore({ paths });
  const counter = createTokenCounter({ projectsDir: path.join(paths.claudeDir, 'projects'), file: TOKENS });
  log(`agent ${AGENT_VERSION} for ${cfg.hub}, login in ${store.where}`);
  const state = { wrote: cfg.wrote || null };
  let backoff = 5_000, lastScan = 0, scanning = null;
  for (;;) {
    if (!scanning && Date.now() - lastScan > 60_000) {
      lastScan = Date.now();
      scanning = counter.scan().catch((e) => log('token count failed:', e.message)).finally(() => (scanning = null));
    }
    try {
      const before = state.wrote;
      await syncOnce({ cfg, store, paths, counter, wait: 25_000, state });
      if (state.wrote !== before) writeJsonAtomic(CONFIG, { ...readJson(CONFIG), wrote: state.wrote });
      backoff = 5_000;
    } catch (e) {
      if (e.status === 401) {
        log(e.message);
        await sleep(10 * 60_000);
      } else {
        log(`can't reach the hub: ${e.message}`);
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }
}

// ---------- setup ----------

function installService(agentPath) {
  const node = process.execPath;
  if (process.platform === 'linux') {
    const unitDir = path.join(HOME, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    fs.writeFileSync(
      path.join(unitDir, `${SERVICE}.service`),
      `[Unit]\nDescription=Claude Accounts Manager agent\nAfter=network-online.target\n\n[Service]\nExecStart="${node}" "${agentPath}" run\nRestart=always\nRestartSec=10\nNice=10\n\n[Install]\nWantedBy=default.target\n`,
    );
    execFileSync('systemctl', ['--user', 'daemon-reload']);
    execFileSync('systemctl', ['--user', 'enable', '--now', SERVICE]);
    execFileSync('systemctl', ['--user', 'restart', SERVICE]);
    return `systemd user service "${SERVICE}". To keep it running while you're logged out: loginctl enable-linger $USER`;
  }
  if (process.platform === 'darwin') {
    const plist = path.join(HOME, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`);
    const xml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(
      plist,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${MAC_LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>${xml(agentPath)}</string><string>run</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>${xml(path.join(DIR, 'agent.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(DIR, 'agent.log'))}</string>
</dict></plist>
`,
    );
    const domain = `gui/${process.getuid()}`;
    try {
      execFileSync('launchctl', ['bootout', `${domain}/${MAC_LABEL}`], { stdio: 'ignore' });
    } catch {}
    execFileSync('launchctl', ['bootstrap', domain, plist]);
    return `launchd agent "${MAC_LABEL}", log in ${path.join(DIR, 'agent.log')}`;
  }
  if (process.platform === 'win32') {
    // A scheduled task at logon, started through wscript so no console window stays open.
    const vbs = path.join(DIR, 'run-hidden.vbs');
    fs.writeFileSync(vbs, `CreateObject("WScript.Shell").Run """${node}"" ""${agentPath}"" run", 0, False\r\n`);
    execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', WIN_TASK, '/TR', `wscript.exe "${vbs}"`]);
    execFileSync('schtasks', ['/Run', '/TN', WIN_TASK]);
    return `scheduled task "${WIN_TASK}" (runs at logon)`;
  }
  throw new Error(`no service support for ${process.platform}`);
}

function removeService() {
  try {
    if (process.platform === 'linux') {
      execFileSync('systemctl', ['--user', 'disable', '--now', SERVICE], { stdio: 'ignore' });
      fs.rmSync(path.join(HOME, '.config', 'systemd', 'user', `${SERVICE}.service`), { force: true });
      execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'ignore' });
    } else if (process.platform === 'darwin') {
      execFileSync('launchctl', ['bootout', `gui/${process.getuid()}/${MAC_LABEL}`], { stdio: 'ignore' });
      fs.rmSync(path.join(HOME, 'Library', 'LaunchAgents', `${MAC_LABEL}.plist`), { force: true });
    } else if (process.platform === 'win32') {
      execFileSync('schtasks', ['/End', '/TN', WIN_TASK], { stdio: 'ignore' });
      execFileSync('schtasks', ['/Delete', '/F', '/TN', WIN_TASK], { stdio: 'ignore' });
    }
  } catch {}
}

async function setup(args) {
  const [hub, code] = args.filter((a) => !a.startsWith('--'));
  const nameAt = args.indexOf('--name');
  const name = nameAt >= 0 ? args[nameAt + 1] : '';
  if (!hub || !code) {
    console.error('Usage: node agent.mjs setup <hub url> <code> [--name "My laptop"]');
    process.exit(1);
  }
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20) throw new Error(`Node.js 20 or newer is needed (this is ${process.versions.node})`);
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const r = await post(hub, '/agent/pair', { code, name, os: process.platform, hostname: os.hostname() });
  const cfg = { hub: new URL(hub).origin, token: r.token, machineId: r.machineId, name: r.name, claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || '' };
  writeJsonAtomic(CONFIG, cfg);
  console.log(`Paired with ${cfg.hub} as "${r.name}".`);
  // Keep a copy next to the config, so the service doesn't depend on where this file was run from.
  const self = fileURLToPath(import.meta.url);
  const agentPath = path.join(DIR, 'agent.mjs');
  if (path.resolve(self) !== path.resolve(agentPath)) fs.copyFileSync(self, agentPath);
  // First check-in now, so the dashboard shows this machine and its current login right away.
  const paths = cfg.claudeConfigDir ? claudePaths({ CLAUDE_CONFIG_DIR: cfg.claudeConfigDir }) : claudePaths();
  try {
    const state = {};
    const res = await syncOnce({ cfg, store: credentialStore({ paths }), paths, state });
    if (state.wrote) writeJsonAtomic(CONFIG, { ...cfg, wrote: state.wrote });
    console.log(res.account ? `Claude Code here uses ${res.account.email || res.account.name}.` : 'No account chosen for this machine yet: pick one in the dashboard.');
  } catch (e) {
    console.log(`First check-in failed (${e.message}); the service will retry.`);
  }
  try {
    console.log(`Running in the background as a ${installService(agentPath)}.`);
  } catch (e) {
    console.log(`Couldn't install a background service (${e.message}). Run it yourself: node "${agentPath}" run`);
  }
}

function status() {
  const cfg = readJson(CONFIG);
  if (!cfg) return console.log('Not set up.');
  const paths = cfg.claudeConfigDir ? claudePaths({ CLAUDE_CONFIG_DIR: cfg.claudeConfigDir }) : claudePaths();
  const o = credentialStore({ paths }).read()?.claudeAiOauth;
  const who = readJson(paths.claudeJson)?.oauthAccount?.emailAddress;
  console.log(`Hub:     ${cfg.hub}\nMachine: ${cfg.name}\nLogin:   ${o?.accessToken ? `${who || 'signed in'}${tokenHash(o.accessToken) === cfg.wrote ? ' (set by the hub)' : ' (not set by the hub)'}` : 'none'}`);
}

function uninstall() {
  removeService();
  fs.rmSync(CONFIG, { force: true });
  fs.rmSync(TOKENS, { force: true });
  console.log('Agent removed. Claude Code keeps its current login until it expires; then run `claude /login` to sign in normally.');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [cmd, ...args] = process.argv.slice(2);
  const commands = { setup: () => setup(args), run, status, uninstall };
  if (!commands[cmd]) {
    console.log('Usage: node agent.mjs setup <hub url> <code> [--name "My laptop"] | run | status | uninstall');
    process.exit(cmd ? 1 : 0);
  }
  Promise.resolve(commands[cmd]()).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
