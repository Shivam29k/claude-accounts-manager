import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// Files the browser may load, by exact path. Nothing else is served from disk.
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/lib.js': ['lib.js', 'text/javascript; charset=utf-8'],
  '/favicon.svg': ['favicon.svg', 'image/svg+xml'],
  '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png'],
  '/icon-192.png': ['icon-192.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
};

// Browsers can't send this header cross-site without a CORS preflight, which we never answer,
// so requiring it on every POST stops other web pages from driving the API.
export const CSRF_HEADER = 'x-cam';

const RANGES = { '24h': 86400_000, '7d': 7 * 86400_000, '30d': 30 * 86400_000 };

function sendJson(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(body));
}

async function readBody(req, max = 100_000) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > max) throw new Error('body too large');
  }
  return s ? JSON.parse(s) : {};
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// agentFile: the agent script other machines download (GET /agent.mjs).
// agentWaitMs: how long a check-in may wait for a change before answering (long poll).
export function createHttpServer({ manager, tokens, publicDir, agentFile = null, allowedLogins = [], agentWaitMs = 25_000 }) {
  const routes = {
    'GET /api/state': () => manager.publicState(),
    'GET /api/tokens': (_b, q) => {
      const span = RANGES[q.get('range')];
      // One extra day so the browser can cut day boundaries in its own time zone.
      return { now: Date.now(), ...tokens.series(span ? Date.now() - span - 86400_000 : 0) };
    },
    'POST /api/switch': (b) => manager.switchMachine(b.machine, b.id),
    'POST /api/login/start': (b) => manager.startLogin(b),
    'POST /api/login/finish': (b) => manager.finishLogin(b),
    'POST /api/import-live': (b) => manager.importLive(b.label),
    'POST /api/account': (b) => manager.updateAccount(b),
    'POST /api/account/remove': (b) => manager.removeAccount(b.id),
    'POST /api/order': (b) => manager.reorder(b.ids),
    'POST /api/refresh': (b) => manager.refreshUsage(b.id),
    'POST /api/settings': (b) => manager.updateSettings(b),
    'POST /api/machines/code': () => manager.createPairCode(),
    'POST /api/machine': (b) => manager.renameMachine(b),
    'POST /api/machine/remove': (b) => manager.removeMachine(b.id),
  };

  // Agents on other machines. They authenticate with the token they got when pairing, sent as
  // "Authorization: Bearer <token>" (a header web pages can't send cross-site either).
  async function agentRoute(req, res, url) {
    const body = await readBody(req, 2_000_000);
    if (url.pathname === '/agent/pair') return sendJson(res, 200, await manager.pairMachine(body));
    const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    let m = manager.machineByToken(token);
    if (!m) return sendJson(res, 401, { error: 'This machine was removed from the hub. Add it again.' });
    let out = await manager.agentSync(m, body);
    // Long poll: if the machine already has the right login, hold the answer until that changes,
    // so a switch reaches it within a second or two.
    const wait = Math.min(agentWaitMs, Math.max(0, Number(url.searchParams.get('wait')) * 1000 || 0));
    const until = Date.now() + wait;
    while (Date.now() < until && (!out.creds || out.hash === body.have) && !req.socket.destroyed) {
      await sleep(1000);
      m = manager.machineByToken(token);
      if (!m) return sendJson(res, 401, { error: 'This machine was removed from the hub. Add it again.' });
      out = { ...out, ...manager.machineLogin(m) };
    }
    sendJson(res, 200, out);
  }

  return http.createServer(async (req, res) => {
    try {
      // Behind `tailscale serve`, this header names the tailnet user making the request.
      if (allowedLogins.length && !allowedLogins.includes(String(req.headers['tailscale-user-login'] || '').toLowerCase())) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        return res.end('Forbidden');
      }
      const url = new URL(req.url, 'http://localhost');
      const asset = req.method === 'GET' && STATIC[url.pathname];
      if (asset) {
        const [file, type] = asset;
        res.writeHead(200, { 'Content-Type': type, 'Cache-Control': file === 'index.html' ? 'no-store' : 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return res.end(fs.readFileSync(path.join(publicDir, file)));
      }
      if (req.method === 'GET' && url.pathname === '/agent.mjs' && agentFile) {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' });
        return res.end(fs.readFileSync(agentFile));
      }
      if (req.method === 'POST' && (url.pathname === '/agent/pair' || url.pathname === '/agent/sync')) return await agentRoute(req, res, url);
      if (req.method === 'GET' && url.pathname === '/favicon.ico') {
        res.writeHead(301, { Location: '/favicon.svg' });
        return res.end();
      }
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) return sendJson(res, 404, { error: 'Not found' });
      if (req.method === 'POST' && req.headers[CSRF_HEADER] !== '1') return sendJson(res, 403, { error: 'Missing request header' });
      const body = req.method === 'POST' ? await readBody(req) : {};
      sendJson(res, 200, await route(body, url.searchParams));
    } catch (e) {
      sendJson(res, 400, { error: e.message || String(e), ...(e.data || {}) });
    }
  });
}
