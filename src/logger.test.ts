import { describe, expect, it } from 'vitest';

import { isTestEnv, redactSecrets, resolveLogDir } from './logger.js';

const HOME = '/Users/someone';

describe('isTestEnv', () => {
  it('detects vitest', () => {
    expect(isTestEnv({ VITEST: 'true' })).toBe(true);
  });

  it('detects jest', () => {
    expect(isTestEnv({ JEST_WORKER_ID: '3' })).toBe(true);
  });

  it('detects NODE_ENV=test on its own', () => {
    expect(isTestEnv({ NODE_ENV: 'test' })).toBe(true);
  });

  it('is false for a normal process', () => {
    expect(isTestEnv({ NODE_ENV: 'production', HOME })).toBe(false);
  });

  it('does not treat other NODE_ENV values as test', () => {
    expect(isTestEnv({ NODE_ENV: 'testing' })).toBe(false);
  });
});

describe('resolveLogDir', () => {
  it('uses the macOS log dir for a normal process', () => {
    expect(resolveLogDir({ HOME }, 'darwin')).toBe(
      '/Users/someone/Library/Logs/nanoclaw',
    );
  });

  it('writes no file under test, so `npm test` cannot pollute the real log', () => {
    expect(resolveLogDir({ HOME, VITEST: 'true' }, 'darwin')).toBe('');
    expect(resolveLogDir({ HOME, NODE_ENV: 'test' }, 'darwin')).toBe('');
    expect(resolveLogDir({ HOME, JEST_WORKER_ID: '1' }, 'darwin')).toBe('');
  });

  it('honours an explicit LOG_DIR even under test', () => {
    // How a test points file logging at a temp dir on purpose.
    expect(resolveLogDir({ HOME, VITEST: 'true', LOG_DIR: '/tmp/x' })).toBe(
      '/tmp/x',
    );
  });

  it('treats an explicit empty LOG_DIR as "no file"', () => {
    expect(resolveLogDir({ HOME, LOG_DIR: '' }, 'darwin')).toBe('');
  });

  it('writes no file on non-darwin, where journald captures stdout', () => {
    expect(resolveLogDir({ HOME }, 'linux')).toBe('');
  });

  it('writes no file on darwin without HOME', () => {
    expect(resolveLogDir({}, 'darwin')).toBe('');
  });

  it('is inert in this very run — the guard is actually active', () => {
    // Reads the real process.env: proves the suite you are running right now
    // is not appending to ~/Library/Logs/nanoclaw/nanoclaw.log.
    expect(resolveLogDir()).toBe('');
  });
});

describe('redactSecrets', () => {
  it('strips the bearer token axios dumps into Slack Web API errors', () => {
    // Shape of the real 2026-10-29 leak: an axios error's request config,
    // JSON-serialised under an `error` key, Authorization header included.
    const line = JSON.stringify({
      config: {
        headers: { Authorization: 'Bearer xoxb-0000-1111-FAKEtokenVALUE' },
      },
    });
    const out = redactSecrets(line);
    expect(out).not.toContain('FAKEtokenVALUE');
    expect(out).toContain('Bearer [REDACTED]');
  });

  it('strips bare Slack tokens of every prefix', () => {
    for (const tok of [
      'xoxb-1-2-abc',
      'xoxp-1-2-abc',
      'xoxc-1-2-abc',
      'xoxd-abc',
      'xapp-1-A0-abc',
    ]) {
      const out = redactSecrets(`token=${tok} trailing`);
      expect(out).not.toContain('abc');
      expect(out).toContain('trailing');
    }
  });

  it('strips Anthropic keys and OAuth tokens', () => {
    const out = redactSecrets('key sk-ant-oat01-AbC_d-9 and sk-ant-api03-XyZ');
    expect(out).toBe('key sk-ant-[REDACTED] and sk-ant-[REDACTED]');
  });

  it('strips Google OAuth access tokens', () => {
    expect(redactSecrets('tok ya29.a0AfH6SM-x_y.z end')).toBe(
      'tok ya29.[REDACTED] end',
    );
  });

  it('leaves ordinary log text alone', () => {
    const line = 'Slack socket connected group: "slack-main" xox ya29 sk-ant';
    expect(redactSecrets(line)).toBe(line);
  });
});
