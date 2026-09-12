import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

export interface DivergentSkillFile {
  skill: string;
  relPath: string;
}

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel))) {
    const r = rel ? path.join(rel, entry) : entry;
    if (fs.statSync(path.join(root, r)).isDirectory())
      out.push(...walk(root, r));
    else out.push(r);
  }
  return out;
}

export function findDivergentSkillFiles(
  srcRoot: string,
  dstRoot: string,
): DivergentSkillFile[] {
  const found: DivergentSkillFile[] = [];
  for (const skill of fs.readdirSync(srcRoot)) {
    const srcDir = path.join(srcRoot, skill);
    const dstDir = path.join(dstRoot, skill);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    if (!fs.existsSync(dstDir)) continue;

    for (const relPath of walk(dstDir)) {
      const srcFile = path.join(srcDir, relPath);
      const dstFile = path.join(dstDir, relPath);
      if (!fs.existsSync(srcFile)) continue;
      if (fs.readFileSync(srcFile).equals(fs.readFileSync(dstFile))) continue;
      if (fs.statSync(dstFile).mtimeMs <= fs.statSync(srcFile).mtimeMs)
        continue;
      found.push({ skill, relPath });
    }
  }
  return found;
}

/**
 * Copy the container's versions aside before the sync overwrites them, so a
 * warning is actionable rather than just an obituary. Returns the directory.
 */
export function quarantineDivergentFiles(
  files: DivergentSkillFile[],
  dstRoot: string,
  quarantineRoot: string,
  stamp: string,
): string {
  const dir = path.join(quarantineRoot, stamp);
  for (const f of files) {
    const from = path.join(dstRoot, f.skill, f.relPath);
    const to = path.join(dir, f.skill, f.relPath);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
  return dir;
}

const MAX_LISTED = 5;

/**
 * The agent can edit its own skills (the mount is read-write), but the next
 * spawn overwrites them from `skills_for_nanoclaw/` and nothing copies back.
 * Such an edit is therefore write-only memory unless someone ports it, so say
 * where the saved copy is and what makes the change durable.
 */
export function formatSkillOverwriteWarning(
  files: DivergentSkillFile[],
  quarantineDir: string,
): string {
  const listed = files
    .slice(0, MAX_LISTED)
    .map((f) => `  • ${f.skill}/${f.relPath}`);
  if (files.length > MAX_LISTED) {
    listed.push(`  • …and ${files.length - MAX_LISTED} more`);
  }

  return [
    `⚠ Overwrote ${files.length} container-side skill edit` +
      `${files.length === 1 ? '' : 's'}:`,
    ...listed,
    `Saved to ${quarantineDir}`,
    'These are lost on every spawn unless ported into `skills_for_nanoclaw/`.',
  ].join('\n');
}

export interface SyncSkillsArgs {
  srcRoot: string;
  dstRoot: string;
  quarantineRoot: string;
  /** Called only when the sync is about to destroy a container-side edit. */
  onOverwrite?: (files: DivergentSkillFile[], quarantineDir: string) => void;
  now?: () => Date;
}

function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/**
 * Copy `skills_for_nanoclaw/` into a group's session skills directory.
 *
 * The copy is unconditional — the repo stays the source of truth. The point of
 * this wrapper is that the overwrite is no longer silent: an edit the agent
 * made inside the container is saved aside and reported first.
 */
export function syncSkills(args: SyncSkillsArgs): DivergentSkillFile[] {
  const {
    srcRoot,
    dstRoot,
    quarantineRoot,
    onOverwrite,
    now = () => new Date(),
  } = args;
  if (!fs.existsSync(srcRoot)) return [];

  const diverged = findDivergentSkillFiles(srcRoot, dstRoot);
  if (diverged.length > 0) {
    const dir = quarantineDivergentFiles(
      diverged,
      dstRoot,
      quarantineRoot,
      timestamp(now()),
    );
    onOverwrite?.(diverged, dir);
  }

  for (const skill of fs.readdirSync(srcRoot)) {
    const srcDir = path.join(srcRoot, skill);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    fs.cpSync(srcDir, path.join(dstRoot, skill), { recursive: true });
  }

  return diverged;
}

type NotifyFn = (text: string) => void | boolean | Promise<void | boolean>;

let notify: NotifyFn = () => {
  // Default no-op until index.ts wires the real channel at startup.
};

export function setSkillOverwriteNotify(fn: NotifyFn): void {
  notify = fn;
}

/**
 * Delivery is best-effort: a container spawn must never fail because a warning
 * could not be sent.
 */
export function notifySkillOverwrite(text: string): void {
  try {
    const result = notify(text);
    if (result && typeof (result as Promise<unknown>).catch === 'function') {
      (result as Promise<unknown>).catch((err) => {
        logger.error({ err }, 'skill-sync notify rejected');
      });
    }
  } catch (err) {
    logger.error({ err }, 'skill-sync notify threw');
  }
}
