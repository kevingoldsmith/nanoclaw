import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  decryptWithIdentity,
  installFile,
  lookupTarget,
  moveToErrors,
  parseIdentityFile,
  processDropDirOnce,
  validateTokensJson,
} from './credential-drop-watcher.js';

describe('credential-drop-watcher: parseIdentityFile', () => {
  it('extracts AGE-SECRET-KEY line from age-keygen output', () => {
    const content =
      '# created: 2026-06-17T22:13:37-07:00\n' +
      '# public key: age19xd8clthrrumwvhwzzmutyln7237j9e2kj0ejw7kty5q5q296fgqy3cra0\n' +
      'AGE-SECRET-KEY-1HURRPQDKAVQ709FHXQDALU7U3R7Q630KKNAV4WT66QYHX2HPJCZSFT29UR\n';
    expect(parseIdentityFile(content)).toBe(
      'AGE-SECRET-KEY-1HURRPQDKAVQ709FHXQDALU7U3R7Q630KKNAV4WT66QYHX2HPJCZSFT29UR',
    );
  });

  it('extracts bare key from a file with no comments', () => {
    const content = 'AGE-SECRET-KEY-1ABCDEF\n';
    expect(parseIdentityFile(content)).toBe('AGE-SECRET-KEY-1ABCDEF');
  });

  it('throws on a file with no AGE-SECRET-KEY line', () => {
    expect(() => parseIdentityFile('# created\n# public key: age1XYZ\n')).toThrow(
      /no AGE-SECRET-KEY/,
    );
  });
});

describe('credential-drop-watcher: lookupTarget', () => {
  it('maps drive filename to drive token path', () => {
    const result = lookupTarget('tokens-account3-drive.json.age');
    expect(result).toEqual({
      target: path.join(
        os.homedir(),
        '.config',
        'google-drive-mcp-account3',
        'tokens.json',
      ),
      label: 'account3 drive',
    });
  });

  it('maps calendar filename to calendar token path', () => {
    const result = lookupTarget('tokens-account3-calendar.json.age');
    expect(result).toEqual({
      target: path.join(
        os.homedir(),
        '.config',
        'google-calendar-mcp-account3',
        'tokens.json',
      ),
      label: 'account3 calendar',
    });
  });

  it('returns null for unknown filename', () => {
    expect(lookupTarget('something-else.age')).toBeNull();
    expect(lookupTarget('tokens-account3-drive.json')).toBeNull(); // missing .age
  });
});

describe('credential-drop-watcher: validateTokensJson', () => {
  it('accepts JSON with a refresh_token', () => {
    const buf = Buffer.from(
      JSON.stringify({ refresh_token: 'r', access_token: 'a' }),
    );
    expect(validateTokensJson(buf)).toEqual({ ok: true });
  });

  it('rejects JSON without refresh_token', () => {
    const buf = Buffer.from(JSON.stringify({ access_token: 'a' }));
    const r = validateTokensJson(buf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/refresh_token/);
  });

  it('accepts nested-shape tokens with refresh_token inside `normal`', () => {
    // Calendar MCP stores: { normal: { refresh_token: '...' } }
    const buf = Buffer.from(JSON.stringify({ normal: { refresh_token: 'r' } }));
    expect(validateTokensJson(buf)).toEqual({ ok: true });
  });

  it('rejects malformed JSON', () => {
    const buf = Buffer.from('{not json');
    const r = validateTokensJson(buf);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/parse/i);
  });

  it('rejects empty input', () => {
    const r = validateTokensJson(Buffer.alloc(0));
    expect(r.ok).toBe(false);
  });
});

// Helper: generate a keypair and encrypt a plaintext using age-encryption.
async function makeFixture(plaintext: string) {
  const age = await import('age-encryption');
  const identity = await age.generateIdentity();
  const recipient = await age.identityToRecipient(identity);
  const encrypter = new age.Encrypter();
  encrypter.addRecipient(recipient);
  const ciphertext = await encrypter.encrypt(Buffer.from(plaintext));
  return { identity, ciphertext: Buffer.from(ciphertext) };
}

describe('credential-drop-watcher: decryptWithIdentity', () => {
  it('decrypts a ciphertext encrypted to the matching identity', async () => {
    const { identity, ciphertext } = await makeFixture('hello world');
    const result = await decryptWithIdentity(ciphertext, identity);
    expect(result.ok).toBe(true);
    if (result.ok)
      expect(result.plaintext.toString('utf8')).toBe('hello world');
  });

  it('fails with a wrong-key identity', async () => {
    const { ciphertext } = await makeFixture('secret');
    const age = await import('age-encryption');
    const wrongIdentity = await age.generateIdentity();
    const result = await decryptWithIdentity(ciphertext, wrongIdentity);
    expect(result.ok).toBe(false);
  });

  it('fails on garbage bytes', async () => {
    const age = await import('age-encryption');
    const someIdentity = await age.generateIdentity();
    const result = await decryptWithIdentity(
      Buffer.from('not-age-ciphertext'),
      someIdentity,
    );
    expect(result.ok).toBe(false);
  });
});

describe('credential-drop-watcher: file routing', () => {
  let tmpRoot: string;
  let dropDir: string;
  let targetDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdw-'));
    dropDir = path.join(tmpRoot, 'drop');
    targetDir = path.join(tmpRoot, 'target');
    fs.mkdirSync(dropDir);
    fs.mkdirSync(targetDir);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('installFile: writes plaintext to target atomically and moves source to .processed/', () => {
    const source = path.join(dropDir, 'tokens-account3-drive.json.age');
    fs.writeFileSync(source, 'encrypted-payload');
    const target = path.join(targetDir, 'tokens.json');
    const plaintext = Buffer.from('{"refresh_token":"r"}');

    installFile({ source, target, plaintext, dropDir });

    expect(fs.readFileSync(target, 'utf8')).toBe('{"refresh_token":"r"}');
    expect(fs.existsSync(source)).toBe(false);
    const processed = fs.readdirSync(path.join(dropDir, '.processed'));
    expect(processed).toHaveLength(1);
    expect(processed[0]).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-tokens-account3-drive\.json\.age$/,
    );
  });

  it('installFile: creates the target directory if missing', () => {
    const source = path.join(dropDir, 'tokens-account3-drive.json.age');
    fs.writeFileSync(source, 'enc');
    const target = path.join(targetDir, 'nested', 'subdir', 'tokens.json');

    installFile({ source, target, plaintext: Buffer.from('{}'), dropDir });

    expect(fs.existsSync(target)).toBe(true);
  });

  it('installFile: does not leave the .tmp file behind on success', () => {
    const source = path.join(dropDir, 'tokens-account3-drive.json.age');
    fs.writeFileSync(source, 'enc');
    const target = path.join(targetDir, 'tokens.json');

    installFile({ source, target, plaintext: Buffer.from('{}'), dropDir });

    const stragglers = fs
      .readdirSync(targetDir)
      .filter((f) => f.endsWith('.tmp'));
    expect(stragglers).toHaveLength(0);
  });

  it('moveToErrors: moves source to .errors/ with a .reason sidecar', () => {
    const source = path.join(dropDir, 'bogus.age');
    fs.writeFileSync(source, 'garbage');

    moveToErrors({ source, reason: 'decrypt failed: bad header', dropDir });

    expect(fs.existsSync(source)).toBe(false);
    const errors = fs.readdirSync(path.join(dropDir, '.errors'));
    const enc = errors.find((f) => f.endsWith('.age'));
    const reasonFile = errors.find((f) => f.endsWith('.reason'));
    expect(enc).toBeDefined();
    expect(reasonFile).toBeDefined();
    const content = fs.readFileSync(
      path.join(dropDir, '.errors', reasonFile!),
      'utf8',
    );
    expect(content).toBe('decrypt failed: bad header');
  });
});

import {
  startCredentialDropWatcher,
  stopCredentialDropWatcher,
  _resetWatcherForTests,
} from './credential-drop-watcher.js';

describe('credential-drop-watcher: start/stop', () => {
  let tmpRoot: string;
  let dropDir: string;
  let identityFile: string;

  beforeEach(async () => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdw-start-'));
    dropDir = path.join(tmpRoot, 'drop');
    identityFile = path.join(tmpRoot, 'identity.txt');
    fs.mkdirSync(dropDir);

    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    fs.writeFileSync(identityFile, identity);

    _resetWatcherForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopCredentialDropWatcher();
    vi.useRealTimers();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('runs an immediate tick on start', async () => {
    fs.writeFileSync(path.join(dropDir, 'mystery.age'), 'garbage');
    const notify = vi.fn();

    startCredentialDropWatcher({
      dropDir,
      identityFile,
      intervalMs: 60_000,
      notify,
    });

    // Allow the immediate async tick to run.
    await vi.advanceTimersByTimeAsync(0);

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('runs periodic ticks at the configured interval', async () => {
    const notify = vi.fn();
    startCredentialDropWatcher({
      dropDir,
      identityFile,
      intervalMs: 1000,
      notify,
    });
    await vi.advanceTimersByTimeAsync(0); // initial tick

    // Drop a new file and advance one interval.
    fs.writeFileSync(path.join(dropDir, 'mystery.age'), 'garbage');
    await vi.advanceTimersByTimeAsync(1000);

    expect(notify).toHaveBeenCalledTimes(1); // initial tick saw nothing, second saw mystery.age
  });

  it('does not start if identity file is missing', () => {
    const notify = vi.fn();
    const missing = path.join(tmpRoot, 'no-such-file.txt');

    startCredentialDropWatcher({
      dropDir,
      identityFile: missing,
      intervalMs: 1000,
      notify,
    });

    // Drop a file; advance time. Nothing should happen.
    fs.writeFileSync(path.join(dropDir, 'mystery.age'), 'garbage');
    return vi.advanceTimersByTimeAsync(5000).then(() => {
      expect(notify).not.toHaveBeenCalled();
    });
  });

  it('stop() prevents further ticks', async () => {
    const notify = vi.fn();
    startCredentialDropWatcher({
      dropDir,
      identityFile,
      intervalMs: 1000,
      notify,
    });
    await vi.advanceTimersByTimeAsync(0);

    stopCredentialDropWatcher();
    fs.writeFileSync(path.join(dropDir, 'mystery.age'), 'garbage');
    await vi.advanceTimersByTimeAsync(5000);

    expect(notify).not.toHaveBeenCalled();
  });
});

describe('credential-drop-watcher: processDropDirOnce', () => {
  let tmpRoot: string;
  let dropDir: string;
  let homeOverride: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cdw-orch-'));
    dropDir = path.join(tmpRoot, 'drop');
    homeOverride = path.join(tmpRoot, 'home');
    fs.mkdirSync(dropDir);
    fs.mkdirSync(homeOverride);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('skips .processed/ and .errors/ subdirectories', async () => {
    fs.mkdirSync(path.join(dropDir, '.processed'));
    fs.mkdirSync(path.join(dropDir, '.errors'));
    fs.writeFileSync(path.join(dropDir, '.processed', 'old.age'), 'old-data');
    const notify = vi.fn();
    await processDropDirOnce({
      dropDir,
      identity: 'AGE-SECRET-KEY-1XXX',
      notify,
      lookupTargetOverride: () => null,
    });
    expect(notify).not.toHaveBeenCalled();
  });

  it('routes unknown filenames to .errors/ with notify', async () => {
    fs.writeFileSync(path.join(dropDir, 'mystery.age'), 'data');
    const notify = vi.fn();

    await processDropDirOnce({
      dropDir,
      identity: 'AGE-SECRET-KEY-1XXX',
      notify,
    });

    const errors = fs.readdirSync(path.join(dropDir, '.errors'));
    expect(errors.some((f) => f.endsWith('.age'))).toBe(true);
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/Credential drop failed.*mystery\.age.*no mapping/),
    );
  });

  it('happy path: decrypts and installs a known file, notifies success', async () => {
    const age = await import('age-encryption');
    const identity = await age.generateIdentity();
    const recipient = await age.identityToRecipient(identity);

    const tokensJson = JSON.stringify({
      refresh_token: 'r',
      refresh_token_expires_in: 604799,
    });
    const encrypter = new age.Encrypter();
    encrypter.addRecipient(recipient);
    const ciphertext = Buffer.from(
      await encrypter.encrypt(Buffer.from(tokensJson)),
    );
    const filename = 'tokens-account3-drive.json.age';
    fs.writeFileSync(path.join(dropDir, filename), ciphertext);

    const targetPath = path.join(homeOverride, 'tokens.json');
    const notify = vi.fn();

    await processDropDirOnce({
      dropDir,
      identity,
      notify,
      lookupTargetOverride: (name) =>
        name === filename
          ? { target: targetPath, label: 'account3 drive' }
          : null,
    });

    expect(fs.readFileSync(targetPath, 'utf8')).toBe(tokensJson);
    expect(notify).toHaveBeenCalledWith(
      expect.stringMatching(/Installed account3 drive tokens/),
    );
  });

  it('continues after a bad file (one error does not poison the batch)', async () => {
    fs.writeFileSync(path.join(dropDir, 'a-bogus.age'), 'garbage');
    fs.writeFileSync(path.join(dropDir, 'b-also-bogus.age'), 'more garbage');
    const notify = vi.fn();

    await processDropDirOnce({
      dropDir,
      identity: 'AGE-SECRET-KEY-1XXX',
      notify,
    });

    const errors = fs.readdirSync(path.join(dropDir, '.errors'));
    expect(errors.filter((f) => f.endsWith('.age'))).toHaveLength(2);
    expect(notify).toHaveBeenCalledTimes(2);
  });
});
