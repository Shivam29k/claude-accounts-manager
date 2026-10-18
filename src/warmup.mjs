// "Auto-start 5-hour windows": a Claude subscription's 5-hour session window only starts with
// the first message, and resets 5 hours after that. Sending a one-word message to an idle
// account starts its window early, so it has reset (or is close to resetting) by the time you
// switch to it.
//
// The message goes through the real Claude Code CLI in print mode, logged in with the
// account's own token via CLAUDE_CODE_OAUTH_TOKEN. It runs in a separate, empty config
// directory, so it never touches the live login, your settings, hooks or history.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// True when the account's 5-hour window isn't running: no window in the usage answer, no
// reset time, or the reset time has passed (the old window ended and nothing started a new one).
export function sessionIdle(usage, nowMs = Date.now()) {
  const w = usage?.five_hour;
  if (!w || !w.resets_at) return true;
  const t = Date.parse(w.resets_at);
  return !Number.isFinite(t) || t <= nowMs;
}

export function createWarmupRunner({ claudeBin, workDir, timeoutMs = 90_000 }) {
  const pids = new Set(); // our own Claude processes, so the health check doesn't warn about them

  function prepare() {
    fs.mkdirSync(workDir, { recursive: true, mode: 0o700 });
    const cfg = path.join(workDir, '.claude.json');
    if (!fs.existsSync(cfg)) fs.writeFileSync(cfg, JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
  }

  // Sends "hi" as the account that owns accessToken. Resolves { ok, model?, error? }.
  function run(accessToken) {
    prepare();
    const env = {
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      LANG: process.env.LANG || 'C.UTF-8',
      CLAUDE_CODE_OAUTH_TOKEN: accessToken,
      CLAUDE_CONFIG_DIR: workDir,
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    };
    const args = ['-p', 'hi', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--output-format', 'json'];
    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(claudeBin, args, { env, cwd: workDir, stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        return resolve({ ok: false, error: e.message });
      }
      pids.add(child.pid);
      let out = '', err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.on('error', (e) => {
        clearTimeout(timer);
        pids.delete(child.pid);
        resolve({ ok: false, error: e.message });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        pids.delete(child.pid);
        let j = null;
        try {
          j = JSON.parse(out);
        } catch {}
        if (code === 0 && j && !j.is_error) return resolve({ ok: true, model: Object.keys(j.modelUsage || {})[0] || null });
        const why = (j?.result || err || out || `exit code ${code}`).toString().trim().split('\n')[0].slice(0, 200);
        resolve({ ok: false, error: why });
      });
    });
  }

  return { run, pids };
}
