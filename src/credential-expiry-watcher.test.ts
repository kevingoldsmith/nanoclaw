import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _resetForTests,
  checkCredential,
  formatAlert,
  formatRecovery,
  readClientCreds,
  readRefreshToken,
  runExpiryCheckOnce,
  type CredentialSpec,
  type FetchLike,
  checkAnthropicFallback,
  ANTHROPIC_FALLBACK_LABEL,
} from './credential-expiry-watcher.js';

const DAY = 86400;
const WARN = 2 * DAY;

let tmpDir: string;

function writeJson(name: string, value: unknown): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, JSON.stringify(value));
  return p;
}

function makeSpec(overrides: Partial<CredentialSpec> = {}): CredentialSpec {
  const keysPath = writeJson('keys.json', {
    installed: { client_id: 'cid', client_secret: 'secret' },
  });
  const tokensPath = writeJson('tokens.json', { refresh_token: 'rt-value' });
  return {
    label: 'account3 drive',
    service: 'drive',
    keysPath,
    tokensPath,
    ...overrides,
  };
}

interface RecordedCall {
  url: string;
  body?: string;
  method: string;
  headers: Record<string, string>;
}

function fetchReturning(
  status: number,
  body: unknown,
): { fn: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({
      url,
      body: init.body,
      method: init.method,
      headers: init.headers,
    });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  };
  return { fn, calls };
}

/**
 * API-key mode, which switches the Anthropic fallback probe off. These tests
 * are about the account3 credentials; without this they would read the real
 * `.env` and change behaviour from machine to machine.
 */
const NO_ANTHROPIC = () => ({ ANTHROPIC_API_KEY: 'sk-ant-api-test' });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cred-expiry-'));
  _resetForTests();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  _resetForTests();
});

describe('readClientCreds', () => {
  it('reads from the `installed` wrapper', () => {
    const p = writeJson('k.json', {
      installed: { client_id: 'a', client_secret: 'b' },
    });
    expect(readClientCreds(p)).toEqual({ clientId: 'a', clientSecret: 'b' });
  });

  it('reads from the `web` wrapper', () => {
    const p = writeJson('k.json', {
      web: { client_id: 'a', client_secret: 'b' },
    });
    expect(readClientCreds(p)).toEqual({ clientId: 'a', clientSecret: 'b' });
  });

  it('throws when the secret is absent', () => {
    const p = writeJson('k.json', { installed: { client_id: 'a' } });
    expect(() => readClientCreds(p)).toThrow(/client_id\/client_secret/);
  });
});

describe('readRefreshToken', () => {
  it('reads a top-level refresh_token (drive/gmail schema)', () => {
    const p = writeJson('t.json', { refresh_token: 'rt' });
    expect(readRefreshToken(p)).toBe('rt');
  });

  it('reads a nested refresh_token (calendar `normal` schema)', () => {
    const p = writeJson('t.json', { normal: { refresh_token: 'rt' } });
    expect(readRefreshToken(p, 'normal')).toBe('rt');
  });

  it('throws when the nested key is missing', () => {
    const p = writeJson('t.json', { refresh_token: 'rt' });
    expect(() => readRefreshToken(p, 'normal')).toThrow(/no refresh_token/);
  });
});

describe('checkCredential', () => {
  it('reports ok when the window is wide', async () => {
    const { fn } = fetchReturning(200, { refresh_token_expires_in: 6 * DAY });
    const r = await checkCredential(makeSpec(), WARN, fn);
    expect(r.status).toBe('ok');
    expect(r.secondsLeft).toBe(6 * DAY);
  });

  it('reports expiring at or below the threshold', async () => {
    const { fn } = fetchReturning(200, { refresh_token_expires_in: WARN });
    const r = await checkCredential(makeSpec(), WARN, fn);
    expect(r.status).toBe('expiring');
  });

  it('sends the refresh_token grant to the token endpoint', async () => {
    const { fn, calls } = fetchReturning(200, {
      refresh_token_expires_in: 6 * DAY,
    });
    await checkCredential(makeSpec(), WARN, fn);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(calls[0].body).toContain('grant_type=refresh_token');
    expect(calls[0].body).toContain('refresh_token=rt-value');
  });

  it('does not rewrite the token file', async () => {
    const spec = makeSpec();
    const before = fs.readFileSync(spec.tokensPath, 'utf8');
    const { fn } = fetchReturning(200, {
      refresh_token_expires_in: 6 * DAY,
      access_token: 'fresh',
    });
    await checkCredential(spec, WARN, fn);
    expect(fs.readFileSync(spec.tokensPath, 'utf8')).toBe(before);
  });

  it('treats a missing refresh_token_expires_in as ok with no countdown', async () => {
    const { fn } = fetchReturning(200, { access_token: 'x' });
    const r = await checkCredential(makeSpec(), WARN, fn);
    expect(r.status).toBe('ok');
    expect(r.secondsLeft).toBeUndefined();
  });

  it('reports dead on invalid_grant', async () => {
    const { fn } = fetchReturning(400, { error: 'invalid_grant' });
    const r = await checkCredential(makeSpec(), WARN, fn);
    expect(r.status).toBe('dead');
    expect(r.reason).toBe('invalid_grant');
  });

  it('reports unknown on a server error rather than crying wolf', async () => {
    const { fn } = fetchReturning(503, { error: 'backendError' });
    const r = await checkCredential(makeSpec(), WARN, fn);
    expect(r.status).toBe('unknown');
  });

  it('reports unknown when the network throws', async () => {
    const fn: FetchLike = async () => {
      throw new Error('ENOTFOUND');
    };
    const r = await checkCredential(makeSpec(), WARN, fn);
    expect(r.status).toBe('unknown');
    expect(r.reason).toBe('ENOTFOUND');
  });

  it('reports missing when the token file is absent', async () => {
    const spec = makeSpec();
    fs.rmSync(spec.tokensPath);
    const { fn } = fetchReturning(200, {});
    const r = await checkCredential(spec, WARN, fn);
    expect(r.status).toBe('missing');
  });
});

describe('formatting', () => {
  it('names the rotate script and the silent-no-op trap in the warning', () => {
    const text = formatAlert({
      label: 'account3 drive',
      service: 'drive',
      status: 'expiring',
      secondsLeft: 1.4 * DAY,
    });
    expect(text).toContain('account3 drive');
    expect(text).toContain('1.4d');
    expect(text).toContain('./scripts/rotate-account3.sh drive');
    expect(text).toMatch(/NOT re-consent/i);
  });

  it('reports the restored window on recovery', () => {
    const text = formatRecovery({
      label: 'account3 gmail',
      service: 'gmail',
      status: 'ok',
      secondsLeft: 7 * DAY,
    });
    expect(text).toContain('account3 gmail');
    expect(text).toContain('7.0d');
  });
});

describe('runExpiryCheckOnce notify-once semantics', () => {
  const expiringFetch = fetchReturning(200, {
    refresh_token_expires_in: DAY,
  }).fn;
  const healthyFetch = fetchReturning(200, {
    refresh_token_expires_in: 7 * DAY,
  }).fn;

  it('notifies once while a credential stays expiring', async () => {
    const notify = vi.fn();
    const credentials = [makeSpec()];
    for (let i = 0; i < 3; i++) {
      await runExpiryCheckOnce({
        readEnv: NO_ANTHROPIC,
        credentials,
        warnThresholdSeconds: WARN,
        notify,
        doFetch: expiringFetch,
      });
    }
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toMatch(/expires in/);
  });

  it('notifies again when expiring escalates to dead', async () => {
    const notify = vi.fn();
    const credentials = [makeSpec()];
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: expiringFetch,
    });
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: fetchReturning(400, { error: 'invalid_grant' }).fn,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatch(/dead/);
  });

  it('sends a recovery message after rotation, then goes quiet', async () => {
    const notify = vi.fn();
    const credentials = [makeSpec()];
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: expiringFetch,
    });
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: healthyFetch,
    });
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: healthyFetch,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatch(/renewed/);
  });

  it('stays silent on a healthy credential from the start', async () => {
    const notify = vi.fn();
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials: [makeSpec()],
      warnThresholdSeconds: WARN,
      notify,
      doFetch: healthyFetch,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not clear an armed warning on an inconclusive check', async () => {
    const notify = vi.fn();
    const credentials = [makeSpec()];
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: expiringFetch,
    });
    // A network blip must not look like a recovery...
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: fetchReturning(503, {}).fn,
    });
    // ...nor re-alarm when the credential is still expiring afterwards.
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: expiringFetch,
    });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('retries the alert when delivery failed (boot race with Slack)', async () => {
    const credentials = [makeSpec()];
    const undelivered = vi.fn().mockResolvedValue(false);
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify: undelivered,
      doFetch: expiringFetch,
    });
    expect(undelivered).toHaveBeenCalledTimes(1);

    // Nothing was armed, so the next tick must warn again.
    const delivered = vi.fn().mockResolvedValue(true);
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify: delivered,
      doFetch: expiringFetch,
    });
    expect(delivered).toHaveBeenCalledTimes(1);

    // And now that it landed, it goes quiet.
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify: delivered,
      doFetch: expiringFetch,
    });
    expect(delivered).toHaveBeenCalledTimes(1);
  });

  it('retries an undelivered recovery message', async () => {
    const credentials = [makeSpec()];
    const notify = vi.fn().mockResolvedValue(true);
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: expiringFetch,
    });
    const dropped = vi.fn().mockResolvedValue(false);
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify: dropped,
      doFetch: healthyFetch,
    });
    expect(dropped).toHaveBeenCalledTimes(1);
    await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: healthyFetch,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatch(/renewed/);
  });

  it('checks every credential even when an earlier one fails', async () => {
    const notify = vi.fn();
    const broken = makeSpec({ label: 'a', tokensPath: '/nonexistent/t.json' });
    const fine = makeSpec({ label: 'b' });
    const results = await runExpiryCheckOnce({
      readEnv: NO_ANTHROPIC,
      credentials: [broken, fine],
      warnThresholdSeconds: WARN,
      notify,
      doFetch: healthyFetch,
    });
    expect(results.map((r) => r.status)).toEqual(['missing', 'ok']);
  });
});

describe('checkAnthropicFallback', () => {
  const GOOD = { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-good' };

  it('reports ok when the token authenticates', async () => {
    const { fn } = fetchReturning(200, { data: [] });
    const r = await checkAnthropicFallback(GOOD, fn);
    expect(r?.status).toBe('ok');
  });

  it('authenticates without consuming inference', async () => {
    const { fn, calls } = fetchReturning(200, { data: [] });
    await checkAnthropicFallback(GOOD, fn);
    expect(calls[0].method).toBe('GET');
    expect(calls[0].url).toContain('/v1/models');
    expect(calls[0].body).toBeUndefined();
    expect(calls[0].headers.Authorization).toBe('Bearer sk-ant-oat-good');
  });

  it('reports dead on a revoked token, quoting the API message', async () => {
    const { fn } = fetchReturning(401, {
      error: { message: 'OAuth access token has been revoked.' },
    });
    const r = await checkAnthropicFallback(GOOD, fn);
    expect(r?.status).toBe('dead');
    expect(r?.reason).toBe('OAuth access token has been revoked.');
  });

  it('reports dead on 403', async () => {
    const { fn } = fetchReturning(403, {});
    expect((await checkAnthropicFallback(GOOD, fn))?.status).toBe('dead');
  });

  it('reports missing when no fallback token is configured', async () => {
    const { fn } = fetchReturning(200, {});
    const r = await checkAnthropicFallback({}, fn);
    expect(r?.status).toBe('missing');
  });

  it('does not apply in API-key mode', async () => {
    const { fn, calls } = fetchReturning(200, {});
    const r = await checkAnthropicFallback(
      { ...GOOD, ANTHROPIC_API_KEY: 'sk-ant-api-x' },
      fn,
    );
    expect(r).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('reports unknown on a server error rather than crying wolf', async () => {
    const { fn } = fetchReturning(503, {});
    const r = await checkAnthropicFallback(GOOD, fn);
    expect(r?.status).toBe('unknown');
  });

  it('reports unknown when the network throws', async () => {
    const fn: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const r = await checkAnthropicFallback(GOOD, fn);
    expect(r?.status).toBe('unknown');
    expect(r?.reason).toBe('ECONNREFUSED');
  });

  it('survives a 401 body that is not JSON', async () => {
    const fn: FetchLike = async () => ({
      ok: false,
      status: 401,
      text: async () => '<html>gateway</html>',
    });
    const r = await checkAnthropicFallback(GOOD, fn);
    expect(r?.status).toBe('dead');
    expect(r?.reason).toBe('HTTP 401');
  });
});

describe('anthropic fallback alert wording', () => {
  it('leads with the fact that agents are still fine', () => {
    const text = formatAlert({
      label: ANTHROPIC_FALLBACK_LABEL,
      service: 'anthropic',
      kind: 'anthropic-fallback',
      status: 'dead',
      reason: 'OAuth access token has been revoked.',
    });
    expect(text).toMatch(/unaffected right now/i);
    expect(text).toContain('sync-oauth-fallback.sh');
    // Must not borrow the Google wording: nothing is down and there is no
    // refresh token involved.
    expect(text).not.toMatch(/refresh token/i);
    expect(text).not.toMatch(/integration is down/i);
    expect(text).not.toContain('rotate-account3');
  });

  it('does not claim a rotation window on recovery', () => {
    const text = formatRecovery({
      label: ANTHROPIC_FALLBACK_LABEL,
      service: 'anthropic',
      kind: 'anthropic-fallback',
      status: 'ok',
    });
    expect(text).toMatch(/valid again/i);
    expect(text).not.toMatch(/renewed/);
  });
});

describe('runExpiryCheckOnce with the anthropic fallback', () => {
  const healthyGoogle = {
    access_token: 'x',
    refresh_token_expires_in: 7 * DAY,
  };

  it('checks the fallback alongside the google credentials', async () => {
    const notify = vi.fn();
    const results = await runExpiryCheckOnce({
      credentials: [],
      warnThresholdSeconds: 2 * DAY,
      notify,
      doFetch: fetchReturning(401, {
        error: { message: 'OAuth access token has been revoked.' },
      }).fn,
      readEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'stale' }),
    });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('dead');
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0][0]).toContain('sync-oauth-fallback.sh');
  });

  it('notifies once while the fallback stays dead', async () => {
    const notify = vi.fn();
    const args = {
      credentials: [],
      warnThresholdSeconds: 2 * DAY,
      notify,
      doFetch: fetchReturning(401, {}).fn,
      readEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'stale' }),
    };
    await runExpiryCheckOnce(args);
    await runExpiryCheckOnce(args);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('sends one recovery message after the token is synced', async () => {
    const notify = vi.fn();
    const base = {
      credentials: [],
      warnThresholdSeconds: 2 * DAY,
      notify,
      readEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'tok' }),
    };
    await runExpiryCheckOnce({ ...base, doFetch: fetchReturning(401, {}).fn });
    await runExpiryCheckOnce({
      ...base,
      doFetch: fetchReturning(200, { data: [] }).fn,
    });
    await runExpiryCheckOnce({
      ...base,
      doFetch: fetchReturning(200, { data: [] }).fn,
    });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls[1][0]).toMatch(/valid again/i);
  });

  it('stays silent in API-key mode instead of reporting a missing fallback', async () => {
    const notify = vi.fn();
    const results = await runExpiryCheckOnce({
      credentials: [],
      warnThresholdSeconds: 2 * DAY,
      notify,
      doFetch: fetchReturning(200, healthyGoogle).fn,
      readEnv: () => ({ ANTHROPIC_API_KEY: 'sk-ant-api-x' }),
    });
    expect(results).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not let a dead fallback suppress the google checks', async () => {
    const notify = vi.fn();
    const results = await runExpiryCheckOnce({
      credentials: [makeSpec()],
      warnThresholdSeconds: 2 * DAY,
      // Both the google refresh and the fallback probe see this 401.
      doFetch: fetchReturning(401, { error: 'invalid_grant' }).fn,
      notify,
      readEnv: () => ({ CLAUDE_CODE_OAUTH_TOKEN: 'stale' }),
    });
    expect(results.map((r) => r.label)).toEqual([
      'account3 drive',
      ANTHROPIC_FALLBACK_LABEL,
    ]);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
