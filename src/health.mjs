// Warnings about anything that would make Claude Code bypass the subscription login, so that
// switching accounts wouldn't affect it (or it would bill API credits instead).

import fs from 'node:fs';
import path from 'node:path';
import { readJson } from './util.mjs';

const AUTH_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

// ignorePids: Claude processes this app started itself (they set CLAUDE_CODE_OAUTH_TOKEN on purpose).
export function checkHealth({ claudeDir, claudeJson, ignorePids = new Set() }) {
  const warnings = [];
  const seen = new Set();

  // Running Claude processes of this user (Linux /proc only).
  let pids = [];
  try {
    pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d));
  } catch {}
  for (const pid of pids) {
    if (ignorePids.has(Number(pid))) continue;
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== process.getuid()) continue;
      if (!/claude/.test(fs.readlinkSync(`/proc/${pid}/exe`))) continue;
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      for (const v of [...AUTH_ENV, 'CLAUDE_CONFIG_DIR']) {
        if (seen.has(v) || !env.some((e) => e.startsWith(`${v}=`))) continue;
        seen.add(v);
        warnings.push(
          v === 'CLAUDE_CONFIG_DIR'
            ? 'A running Claude process uses CLAUDE_CONFIG_DIR, so it reads a different login; switching won’t affect it.'
            : `A running Claude process has ${v} set. It overrides the subscription login (and may bill API credits); switching won’t affect it.`,
        );
      }
    } catch {}
  }

  for (const f of ['settings.json', 'settings.local.json']) {
    const s = readJson(path.join(claudeDir, f));
    if (s?.apiKeyHelper) warnings.push(`${f} sets apiKeyHelper, which overrides the subscription login.`);
    for (const v of AUTH_ENV) if (s?.env?.[v]) warnings.push(`${f} sets ${v}, which overrides the subscription login.`);
  }
  if (readJson(claudeJson)?.primaryApiKey) warnings.push('.claude.json holds an API-key login (primaryApiKey); Claude Code may use it instead of a subscription.');
  return warnings;
}
