import os from 'os';
import path from 'path';

export interface DropTarget {
  target: string;
  label: string;
}

const HOME = os.homedir();

const MAPPING: Record<string, DropTarget> = {
  'tokens-account3-drive.json.age': {
    target: path.join(
      HOME,
      '.config',
      'google-drive-mcp-account3',
      'tokens.json',
    ),
    label: 'account3 drive',
  },
  'tokens-account3-calendar.json.age': {
    target: path.join(
      HOME,
      '.config',
      'google-calendar-mcp-account3',
      'tokens.json',
    ),
    label: 'account3 calendar',
  },
};

export function lookupTarget(filename: string): DropTarget | null {
  return MAPPING[filename] ?? null;
}

export type ValidationResult = { ok: true } | { ok: false; reason: string };

export function validateTokensJson(buf: Buffer): ValidationResult {
  if (buf.length === 0) {
    return { ok: false, reason: 'empty input' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(buf.toString('utf8'));
  } catch (err) {
    return { ok: false, reason: `parse error: ${(err as Error).message}` };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, reason: 'not an object' };
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.refresh_token === 'string' && obj.refresh_token.length > 0) {
    return { ok: true };
  }
  // Calendar MCP wraps under `normal`.
  const inner = obj.normal as Record<string, unknown> | undefined;
  if (
    inner &&
    typeof inner === 'object' &&
    typeof inner.refresh_token === 'string' &&
    inner.refresh_token.length > 0
  ) {
    return { ok: true };
  }
  return { ok: false, reason: 'missing refresh_token' };
}

export type DecryptResult =
  | { ok: true; plaintext: Buffer }
  | { ok: false; reason: string };

export async function decryptWithIdentity(
  ciphertext: Buffer,
  identity: string,
): Promise<DecryptResult> {
  try {
    const age = await import('age-encryption');
    const decrypter = new age.Decrypter();
    decrypter.addIdentity(identity);
    const plaintext = await decrypter.decrypt(ciphertext);
    return { ok: true, plaintext: Buffer.from(plaintext) };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}
