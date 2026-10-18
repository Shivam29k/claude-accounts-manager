#!/usr/bin/env node
// Claude Accounts Manager: keep several Claude subscription logins, watch their usage limits,
// and switch the one Claude Code uses with one click, or automatically near a limit.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createAnthropicClient, detectClientVersions } from './src/anthropic.mjs';
import { createClaudeFiles } from './src/claude-files.mjs';
import { loadConfig } from './src/config.mjs';
import { checkHealth } from './src/health.mjs';
import { createHttpServer } from './src/http.mjs';
import { createManager } from './src/manager.mjs';
import { createStore } from './src/store.mjs';
import { createTokenIndex } from './src/tokens.mjs';
import { createWarmupRunner } from './src/warmup.mjs';

const config = loadConfig();
fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
fs.chmodSync(config.dataDir, 0o700);

const versions = await detectClientVersions(config.claudeBin);
console.log(`requests mimic Claude Code ${versions.cli} (token endpoint: axios/${versions.axios})`);

const store = createStore(path.join(config.dataDir, 'state.json'));
const files = createClaudeFiles({ claudeDir: config.claudeDir, claudeJson: config.claudeJson, backupDir: path.join(config.dataDir, 'backups') });
const warmup = createWarmupRunner({ claudeBin: config.claudeBin, workDir: path.join(config.dataDir, 'warmup') });
const manager = createManager({
  store,
  files,
  anthropic: createAnthropicClient(versions),
  warmup,
  checkHealth: () => checkHealth({ ...config, ignorePids: warmup.pids }),
});
const tokens = createTokenIndex({
  projectsDir: path.join(config.claudeDir, 'projects'),
  file: path.join(config.dataDir, 'tokens.json'),
  accountAt: store.accountAt,
});

await manager.start();

const server = createHttpServer({
  manager,
  tokens,
  publicDir: path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'),
  allowedLogins: config.allowedLogins,
});
server.listen(config.port, config.host, () => console.log(`Claude Accounts Manager on http://${config.host}:${config.port} (data in ${config.dataDir})`));

setInterval(manager.tick, 15_000);
setTimeout(manager.tick, 1000);
setTimeout(() => tokens.scan().then(() => console.log('token usage index ready')), 3000);
setInterval(() => tokens.scan(), 60_000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await manager.idle();
    store.save();
    process.exit(0);
  });
}
