import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function findOnPath(name, envPath = '') {
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {}
  }
  return null;
}

// All settings come from environment variables; see the README for the full list.
export function loadConfig(env = process.env) {
  const home = os.homedir();
  // Claude Code reads both files from CLAUDE_CONFIG_DIR when it is set.
  const claudeConfigDir = env.CLAUDE_CONFIG_DIR;
  const claudeDir = env.CAM_CLAUDE_DIR || claudeConfigDir || path.join(home, '.claude');
  const claudeJson = env.CAM_CLAUDE_JSON || (claudeConfigDir ? path.join(claudeConfigDir, '.claude.json') : path.join(home, '.claude.json'));
  return {
    host: env.CAM_HOST || '127.0.0.1',
    port: Number(env.CAM_PORT || 4330),
    dataDir: env.CAM_DATA_DIR || path.join(home, '.claude-accounts-manager'),
    claudeDir,
    claudeJson,
    claudeBin: env.CAM_CLAUDE_BIN || findOnPath('claude', env.PATH) || path.join(home, '.local/bin/claude'),
    allowedLogins: (env.CAM_ALLOWED_LOGINS || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
