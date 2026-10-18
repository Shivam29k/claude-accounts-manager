// Talks to Anthropic the way the Claude Code CLI does: same OAuth client, endpoints, scopes
// and request headers. None of this is a documented public API; it mirrors Claude Code
// 2.1.x and may change with future Claude Code releases.

import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import zlib from 'node:zlib';

export const OAUTH = {
  clientId: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
  authorizeUrl: 'https://claude.com/cai/oauth/authorize',
  tokenUrl: 'https://platform.claude.com/v1/oauth/token',
  redirectUri: 'https://platform.claude.com/oauth/code/callback',
  apiBase: 'https://api.anthropic.com',
  beta: 'oauth-2025-04-20',
  loginScopes: ['org:create_api_key', 'user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload', 'user:plugins'],
  refreshScopes: ['user:profile', 'user:inference', 'user:sessions:claude_code', 'user:mcp_servers', 'user:file_upload', 'user:plugins'],
};

export const PLAN_BY_ORG_TYPE = { claude_max: 'max', claude_pro: 'pro', claude_enterprise: 'enterprise', claude_team: 'team' };

// Versions used in request headers, read from the installed CLI so they follow its updates.
// Claude Code calls the token endpoint through axios without a custom User-Agent, so those
// requests say "axios/<version>"; its other API calls say "claude-code/<version>".
export async function detectClientVersions(claudeBin) {
  const versions = { cli: '2.1.302', axios: '1.15.2' };
  let real;
  try {
    real = fs.realpathSync(claudeBin);
  } catch {
    return versions;
  }
  const base = path.basename(real);
  if (/^\d+\.\d+\.\d+$/.test(base)) versions.cli = base; // native installer: .../versions/2.1.302
  else {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(real), 'package.json'), 'utf8')); // npm install
      if (pkg?.version) versions.cli = pkg.version;
    } catch {}
  }
  try {
    const counts = new Map();
    let tail = '';
    for await (const chunk of fs.createReadStream(real, { highWaterMark: 4 << 20 })) {
      const text = tail + chunk.toString('latin1');
      for (const m of text.matchAll(/axios\/(\d+\.\d+\.\d+)/g)) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
      tail = text.slice(-32);
    }
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    if (best) versions.axios = best[0];
  } catch {}
  return versions;
}

export function buildAuthorizeUrl({ challenge, state, email }) {
  const u = new URL(OAUTH.authorizeUrl);
  u.searchParams.append('code', 'true');
  u.searchParams.append('client_id', OAUTH.clientId);
  u.searchParams.append('response_type', 'code');
  u.searchParams.append('redirect_uri', OAUTH.redirectUri);
  u.searchParams.append('scope', OAUTH.loginScopes.join(' '));
  u.searchParams.append('code_challenge', challenge);
  u.searchParams.append('code_challenge_method', 'S256');
  u.searchParams.append('state', state);
  if (email) u.searchParams.append('login_hint', String(email));
  return u.toString();
}

// Claude's callback page shows "<code>#<state>". Accept that, the bare code, or the whole URL.
export function parsePastedCode(text) {
  let raw = String(text || '').trim();
  try {
    const u = new URL(raw);
    raw = `${u.searchParams.get('code') || ''}#${u.searchParams.get('state') || ''}`;
  } catch {}
  const [code = '', state = ''] = raw.replace(/\s+/g, '').split('#');
  return { code, state };
}

export const accountKey = (profile) => `${profile.account.uuid}:${profile.organization?.uuid}`;

// What the UI and the account list need from /api/oauth/profile.
export function profileSummary(p) {
  const o = p.organization || {};
  return {
    key: accountKey(p),
    email: p.account.email,
    displayName: p.account.display_name || p.account.full_name || '',
    orgName: o.name || '',
    orgType: o.organization_type || '',
    plan: PLAN_BY_ORG_TYPE[o.organization_type] || o.organization_type || '',
    rateLimitTier: o.rate_limit_tier || '',
    subscriptionStatus: o.subscription_status || '',
  };
}

// The shape Claude Code itself writes to ~/.claude.json "oauthAccount".
export function oauthAccountFromProfile(p, at = Date.now()) {
  const o = p.organization || {};
  const acc = {
    accountUuid: p.account.uuid,
    emailAddress: p.account.email,
    organizationUuid: o.uuid,
    hasExtraUsageEnabled: o.has_extra_usage_enabled ?? false,
    billingType: o.billing_type ?? undefined,
    accountCreatedAt: p.account.created_at,
    subscriptionCreatedAt: o.subscription_created_at ?? undefined,
    ccOnboardingFlags: o.cc_onboarding_flags ?? {},
    claudeCodeTrialEndsAt: o.claude_code_trial_ends_at ?? null,
    claudeCodeTrialDurationDays: o.claude_code_trial_duration_days ?? null,
    seatTier: o.seat_tier ?? null,
    profileFetchedAt: at,
  };
  if (p.account.display_name) acc.displayName = p.account.display_name;
  if (p.account.full_name) acc.fullName = p.account.full_name;
  if (o.name) acc.organizationName = o.name;
  if (o.organization_type) acc.organizationType = o.organization_type;
  if (o.rate_limit_tier) acc.organizationRateLimitTier = o.rate_limit_tier;
  return acc;
}

// The "claudeAiOauth" object Claude Code keeps in .credentials.json.
export function oauthFromTokenResponse(t, prev = {}, profile = null, at = Date.now()) {
  const o = profile?.organization;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token || prev.refreshToken,
    expiresAt: at + (t.expires_in || 3600) * 1000,
    ...(typeof t.refresh_token_expires_in === 'number'
      ? { refreshTokenExpiresAt: at + t.refresh_token_expires_in * 1000 }
      : prev.refreshTokenExpiresAt
        ? { refreshTokenExpiresAt: prev.refreshTokenExpiresAt }
        : {}),
    scopes: typeof t.scope === 'string' ? t.scope.split(' ').filter(Boolean) : prev.scopes || OAUTH.refreshScopes,
    subscriptionType: (o && PLAN_BY_ORG_TYPE[o.organization_type]) ?? prev.subscriptionType ?? null,
    rateLimitTier: o?.rate_limit_tier ?? prev.rateLimitTier ?? null,
  };
}

export class OAuthError extends Error {
  constructor(message, { status, code } = {}) {
    super(message);
    this.status = status;
    this.oauthError = code;
  }
}

export function createAnthropicClient(versions) {
  async function getJson(pathname, token) {
    const r = await fetch(OAUTH.apiBase + pathname, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH.beta,
        'Content-Type': 'application/json',
        'User-Agent': `claude-code/${versions.cli}`,
      },
      signal: AbortSignal.timeout(15000),
    });
    let body = null;
    try {
      body = await r.json();
    } catch {}
    return { status: r.status, body, retryAfter: Number(r.headers.get('retry-after')) || 0 };
  }

  // Same headers as the CLI's axios request (captured from Claude Code 2.1.302). Requests that
  // look different have been reported to get 429s from this endpoint.
  function tokenPost(payload) {
    const data = JSON.stringify(payload);
    return new Promise((resolve, reject) => {
      const req = https.request(
        OAUTH.tokenUrl,
        {
          method: 'POST',
          headers: {
            Accept: 'application/json, text/plain, */*',
            'Content-Type': 'application/json',
            'User-Agent': `axios/${versions.axios}`,
            'Content-Length': Buffer.byteLength(data),
            'Accept-Encoding': 'gzip, compress, deflate, br',
          },
          agent: false, // one connection per request, so it says "Connection: close" like the CLI
          timeout: 30000,
        },
        (res) => {
          const enc = res.headers['content-encoding'];
          const stream =
            enc === 'gzip' ? res.pipe(zlib.createGunzip())
            : enc === 'deflate' ? res.pipe(zlib.createInflate())
            : enc === 'br' ? res.pipe(zlib.createBrotliDecompress())
            : res;
          let text = '';
          stream.on('data', (c) => (text += c));
          stream.on('end', () => resolve({ status: res.statusCode, text }));
          stream.on('error', reject);
        },
      );
      req.on('timeout', () => req.destroy(new Error('token endpoint timed out')));
      req.on('error', reject);
      req.end(data);
    });
  }

  async function tokenRequest(payload) {
    const r = await tokenPost(payload);
    let body = null;
    try {
      body = JSON.parse(r.text);
    } catch {}
    if (r.status !== 200 || !body?.access_token) {
      const code = typeof body?.error === 'string' ? body.error : body?.error?.type;
      const detail = body?.error_description || body?.error?.message || code || 'no access token';
      throw new OAuthError(r.status === 429 ? 'Claude is rate-limiting sign-ins from this machine' : `Sign-in failed (${r.status}): ${detail}`, {
        status: r.status,
        code,
      });
    }
    return body;
  }

  return {
    async fetchProfile(token) {
      const r = await getJson('/api/oauth/profile', token);
      if (r.status !== 200 || !r.body?.account) throw Object.assign(new Error(`profile request answered ${r.status}`), { status: r.status });
      return r.body;
    },
    fetchUsage: (token) => getJson('/api/oauth/usage', token),
    exchangeCode: ({ code, verifier, state }) =>
      tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: OAUTH.redirectUri, client_id: OAUTH.clientId, code_verifier: verifier, state }),
    refresh: ({ refreshToken, scopes }) =>
      tokenRequest({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH.clientId,
        scope: (scopes?.length ? scopes : OAUTH.refreshScopes).join(' '),
      }),
  };
}
