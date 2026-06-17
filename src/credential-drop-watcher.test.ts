import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
  decryptWithIdentity,
  lookupTarget,
  validateTokensJson,
} from './credential-drop-watcher.js';

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
    if (result.ok) expect(result.plaintext.toString('utf8')).toBe('hello world');
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
