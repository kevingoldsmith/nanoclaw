/**
 * launchd shim for backup-personal.sh. Exists only to borrow a TCC grant.
 *
 * The repo lives on an external volume (/Volumes/WIP). macOS blocks launchd
 * agents from reading removable volumes unless the *executable* has been
 * granted access — a plain `/bin/bash` job cannot even `ls` the directory:
 *
 *   /bin/bash: /Volumes/WIP/nanoclaw/scripts/backup-personal.sh:
 *   Operation not permitted
 *
 * The node binary the main nanoclaw service runs under already holds that
 * grant, and child processes inherit it. So launchd starts node, node starts
 * bash, and the script runs with the access it needs — instead of granting
 * Full Disk Access to /bin/bash, which would extend it to everything.
 *
 * If node is ever upgraded, this plist's hardcoded path must be updated to the
 * new binary AND that binary needs the same grant (the main com.nanoclaw plist
 * has the identical constraint).
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'backup-personal.sh');
try {
  execFileSync('/bin/bash', [script, ...process.argv.slice(2)], { stdio: 'inherit' });
} catch (err) {
  process.exit(typeof err.status === 'number' ? err.status : 1);
}
