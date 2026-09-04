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

function fetchReturning(
  status: number,
  body: unknown,
): { fn: FetchLike; calls: Array<{ url: string; body: string }> } {
  const calls: Array<{ url: string; body: string }> = [];
  const fn: FetchLike = async (url, init) => {
    calls.push({ url, body: init.body });
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
    };
  };
  return { fn, calls };
}

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
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: expiringFetch,
    });
    await runExpiryCheckOnce({
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
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: expiringFetch,
    });
    await runExpiryCheckOnce({
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: healthyFetch,
    });
    await runExpiryCheckOnce({
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
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: expiringFetch,
    });
    // A network blip must not look like a recovery...
    await runExpiryCheckOnce({
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: fetchReturning(503, {}).fn,
    });
    // ...nor re-alarm when the credential is still expiring afterwards.
    await runExpiryCheckOnce({
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
      credentials,
      warnThresholdSeconds: WARN,
      notify: undelivered,
      doFetch: expiringFetch,
    });
    expect(undelivered).toHaveBeenCalledTimes(1);

    // Nothing was armed, so the next tick must warn again.
    const delivered = vi.fn().mockResolvedValue(true);
    await runExpiryCheckOnce({
      credentials,
      warnThresholdSeconds: WARN,
      notify: delivered,
      doFetch: expiringFetch,
    });
    expect(delivered).toHaveBeenCalledTimes(1);

    // And now that it landed, it goes quiet.
    await runExpiryCheckOnce({
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
      credentials,
      warnThresholdSeconds: WARN,
      notify,
      doFetch: expiringFetch,
    });
    const dropped = vi.fn().mockResolvedValue(false);
    await runExpiryCheckOnce({
      credentials,
      warnThresholdSeconds: WARN,
      notify: dropped,
      doFetch: healthyFetch,
    });
    expect(dropped).toHaveBeenCalledTimes(1);
    await runExpiryCheckOnce({
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
      credentials: [broken, fine],
      warnThresholdSeconds: WARN,
      notify,
      doFetch: healthyFetch,
    });
    expect(results.map((r) => r.status)).toEqual(['missing', 'ok']);
  });
});
