// Claude Code's own files. On Linux it keeps the login in <claude dir>/.credentials.json
// ("claudeAiOauth") and the account profile in ~/.claude.json ("oauthAccount"). Running Claude
// processes check the credentials file's mtime before using their token and reload it when it
// changes, which is what makes a switch take effect without restarting anything.

import fs from 'node:fs';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './util.mjs';

// Keys of .credentials.json that belong to the signed-in account. Everything else in that file
// (MCP server tokens and so on) is machine-wide and is left alone on a switch.
export const ACCOUNT_KEYS = ['claudeAiOauth', 'trustedDeviceToken', 'trustedDeviceEnrolledAfterRefusalAtMs'];

export function accountPart(raw) {
  const out = {};
  for (const k of ACCOUNT_KEYS) if (raw?.[k] !== undefined) out[k] = raw[k];
  return out;
}

export function createClaudeFiles({ claudeDir, claudeJson, backupDir, keepBackups = 30 }) {
  const credsFile = path.join(claudeDir, '.credentials.json');

  return {
    credsFile,

    // { raw, oauth } for the login Claude Code is using now, or null.
    readLive() {
      const raw = readJson(credsFile);
      return raw ? { raw, oauth: raw.claudeAiOauth || null } : null;
    },

    // Replace the account part of .credentials.json, keeping every other key.
    writeAccount(accountKeys) {
      const cur = readJson(credsFile) || {};
      for (const k of ACCOUNT_KEYS) delete cur[k];
      fs.mkdirSync(claudeDir, { recursive: true });
      writeJsonAtomic(credsFile, { ...cur, ...accountKeys });
    },

    backup(reason) {
      try {
        if (!fs.existsSync(credsFile)) return;
        fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
        const name = `credentials.${new Date().toISOString().replace(/[:.]/g, '-')}.${reason}.json`;
        fs.copyFileSync(credsFile, path.join(backupDir, name));
        fs.chmodSync(path.join(backupDir, name), 0o600);
        const files = fs.readdirSync(backupDir).filter((f) => f.startsWith('credentials.')).sort();
        for (const f of files.slice(0, Math.max(0, files.length - keepBackups))) fs.unlinkSync(path.join(backupDir, f));
      } catch (e) {
        console.error('backup failed:', e.message);
      }
    },

    // Point ~/.claude.json "oauthAccount" at this account. Returns true if the file changed.
    setOauthAccount(oauthAccount) {
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
    },

    readClaudeJson: () => readJson(claudeJson),
  };
}
