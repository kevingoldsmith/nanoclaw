import os from 'os';
import path from 'path';

import { describe, expect, it } from 'vitest';

import { lookupTarget } from './credential-drop-watcher.js';

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
