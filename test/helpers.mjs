import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const made = [];
process.on('exit', () => made.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

export function tempDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cam-test-'));
  made.push(d);
  return d;
}

export const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
export const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o));

export function profile(n) {
  return {
    account: { uuid: `acct-${n}`, email: `user${n}@example.com`, display_name: `User ${n}`, created_at: '2026-01-01T00:00:00Z' },
    organization: { uuid: `org-${n}`, name: `Org ${n}`, organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_5x', billing_type: 'stripe_subscription' },
  };
}

export function oauth(n, gen = 1) {
  return {
    accessToken: `at-${n}-${gen}`,
    refreshToken: `rt-${n}-${gen}`,
    expiresAt: Date.now() + 8 * 3600_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max',
  };
}

export const usageAt = (pct) => ({ five_hour: { utilization: pct, resets_at: new Date(Date.now() + 3600_000).toISOString() }, seven_day: null, limits: [] });

// A stand-in for the Anthropic client: who owns which token, and each account's usage.
export function fakeAnthropic() {
  const owners = new Map(); // access token -> account number
  const usage = new Map(); // account number -> usage body
  const calls = { exchange: 0, refresh: 0 };
  let exchangeStatus = 200;
  let gen = 100;
  const tokensFor = (n) => {
    gen++;
    owners.set(`at-${n}-${gen}`, n);
    return { access_token: `at-${n}-${gen}`, refresh_token: `rt-${n}-${gen}`, expires_in: 3600, scope: 'user:inference user:profile' };
  };
  return {
    owners,
    usage,
    calls,
    nextExchange: { account: 2 },
    failExchangeWith(status) {
      exchangeStatus = status;
    },
    async fetchProfile(token) {
      if (!owners.has(token)) throw Object.assign(new Error('profile request answered 401'), { status: 401 });
      return profile(owners.get(token));
    },
    async fetchUsage(token) {
      return owners.has(token) ? { status: 200, body: usage.get(owners.get(token)) || usageAt(0) } : { status: 401, body: null };
    },
    async exchangeCode() {
      calls.exchange++;
      if (exchangeStatus !== 200) throw Object.assign(new Error('rate limited'), { status: exchangeStatus });
      return tokensFor(this.nextExchange.account);
    },
    async refresh({ refreshToken }) {
      calls.refresh++;
      return tokensFor(Number(refreshToken.split('-')[1]));
    },
  };
}
