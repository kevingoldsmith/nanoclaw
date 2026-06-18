import fs from 'fs';
import os from 'os';
import path from 'path';

import { logger } from './logger.js';

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

function timestampForFilename(): string {
  // 2026-06-17T14-32-15Z (colons replaced with dashes for filesystem safety)
  return new Date().toISOString().replace(/:/g, '-').replace(/\.\d+/, '');
}

export interface InstallArgs {
  source: string;
  target: string;
  plaintext: Buffer;
  dropDir: string;
}

export function installFile(args: InstallArgs): void {
  const { source, target, plaintext, dropDir } = args;

  // 1. Ensure target directory exists.
  fs.mkdirSync(path.dirname(target), { recursive: true });

  // 2. Atomic rename via tmp file in the same directory.
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, plaintext, { mode: 0o600 });
  fs.renameSync(tmp, target);

  // 3. Move source to .processed/
  const processedDir = path.join(dropDir, '.processed');
  fs.mkdirSync(processedDir, { recursive: true });
  const stamped = `${timestampForFilename()}-${path.basename(source)}`;
  fs.renameSync(source, path.join(processedDir, stamped));
}

export interface ErrorArgs {
  source: string;
  reason: string;
  dropDir: string;
}

export function moveToErrors(args: ErrorArgs): void {
  const { source, reason, dropDir } = args;
  const errorsDir = path.join(dropDir, '.errors');
  fs.mkdirSync(errorsDir, { recursive: true });
  const stamped = `${timestampForFilename()}-${path.basename(source)}`;
  const dest = path.join(errorsDir, stamped);
  fs.renameSync(source, dest);
  fs.writeFileSync(`${dest}.reason`, reason);
}

export interface ProcessOnceArgs {
  dropDir: string;
  identity: string;
  notify: (text: string) => void | Promise<void>;
  // Test seam — production code uses the real lookupTarget.
  lookupTargetOverride?: (filename: string) => DropTarget | null;
}

function extractExpiryNote(plaintext: Buffer): string {
  try {
    const obj = JSON.parse(plaintext.toString('utf8')) as Record<
      string,
      unknown
    >;
    const inner = (obj.normal as Record<string, unknown> | undefined) ?? obj;
    const expiresIn = inner.refresh_token_expires_in as number | undefined;
    if (typeof expiresIn === 'number') {
      const expiry = new Date(Date.now() + expiresIn * 1000);
      return ` (refresh expires ${expiry.toISOString().slice(0, 10)})`;
    }
  } catch {
    // Best-effort only; absence of expiry is not an error.
  }
  return '';
}

export async function processDropDirOnce(args: ProcessOnceArgs): Promise<void> {
  const { dropDir, identity, notify } = args;
  const lookup = args.lookupTargetOverride ?? lookupTarget;

  if (!fs.existsSync(dropDir)) return;

  const entries = fs
    .readdirSync(dropDir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.age'))
    .map((e) => e.name)
    .sort();

  for (const filename of entries) {
    const source = path.join(dropDir, filename);
    try {
      const mapping = lookup(filename);
      if (!mapping) {
        moveToErrors({ source, reason: 'no mapping for filename', dropDir });
        await notify(
          `⚠ Credential drop failed for ${filename}: no mapping for filename`,
        );
        continue;
      }

      const ciphertext = fs.readFileSync(source);
      const decrypted = await decryptWithIdentity(ciphertext, identity);
      if (!decrypted.ok) {
        moveToErrors({
          source,
          reason: `decrypt failed: ${decrypted.reason}`,
          dropDir,
        });
        await notify(
          `⚠ Credential drop failed for ${filename}: decrypt failed`,
        );
        continue;
      }

      const validation = validateTokensJson(decrypted.plaintext);
      if (!validation.ok) {
        moveToErrors({
          source,
          reason: `validation failed: ${validation.reason}`,
          dropDir,
        });
        await notify(
          `⚠ Credential drop failed for ${filename}: ${validation.reason}`,
        );
        continue;
      }

      installFile({
        source,
        target: mapping.target,
        plaintext: decrypted.plaintext,
        dropDir,
      });
      await notify(
        `✓ Installed ${mapping.label} tokens${extractExpiryNote(decrypted.plaintext)}`,
      );
    } catch (err) {
      // Last-resort: never let one bad file crash the batch.
      // If renameSync fails (e.g. EACCES), leave the file in place for retry next tick.
      const reason = (err as Error).message;
      try {
        if (fs.existsSync(source)) {
          // Transient FS error — leave file for next tick, just notify.
          await notify(
            `⚠ Credential drop transient failure for ${filename}: ${reason}`,
          );
        }
      } catch {
        // Notify itself failed; we've done all we can.
      }
    }
  }
}

export interface StartArgs {
  dropDir: string;
  identityFile: string;
  intervalMs: number;
  notify: (text: string) => void | Promise<void>;
}

let interval: NodeJS.Timeout | null = null;

// age-keygen writes a file with `# created: ...` and `# public key: ...`
// comment lines before the actual `AGE-SECRET-KEY-1...` line. The
// age-encryption npm library only accepts the bare key string, so we strip
// comments and blanks.
export function parseIdentityFile(content: string): string {
  const lines = content.split('\n').map((l) => l.trim());
  const keyLine = lines.find((l) => l.startsWith('AGE-SECRET-KEY-'));
  if (!keyLine) {
    throw new Error('no AGE-SECRET-KEY line in identity file');
  }
  return keyLine;
}

export function startCredentialDropWatcher(args: StartArgs): void {
  const { dropDir, identityFile, intervalMs, notify } = args;

  if (!fs.existsSync(identityFile)) {
    logger.warn(
      { identityFile },
      'credential-drop-watcher: AGE_IDENTITY_FILE missing — watcher not started',
    );
    return;
  }

  const identity = parseIdentityFile(fs.readFileSync(identityFile, 'utf8'));

  const tick = () => {
    processDropDirOnce({ dropDir, identity, notify }).catch((err) => {
      logger.error(
        { err: (err as Error).message },
        'credential-drop-watcher: tick failed',
      );
    });
  };

  // Immediate tick, then on interval.
  tick();
  interval = setInterval(tick, intervalMs);

  logger.info({ dropDir, intervalMs }, 'credential-drop-watcher: started');
}

export function stopCredentialDropWatcher(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}

// Test-only: reset module-level state between tests.
export function _resetWatcherForTests(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
