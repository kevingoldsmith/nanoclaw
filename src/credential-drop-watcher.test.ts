import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import {
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
    const buf = Buffer.from(
      JSON.stringify({ normal: { refresh_token: 'r' } }),
    );
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
