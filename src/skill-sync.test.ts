import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  findDivergentSkillFiles,
  quarantineDivergentFiles,
  formatSkillOverwriteWarning,
  syncSkills,
  setSkillOverwriteNotify,
  notifySkillOverwrite,
} from './skill-sync.js';

let tmpDir: string;
let src: string;
let dst: string;

/** Write a file with an explicit mtime so "which side is newer" is deterministic. */
function write(root: string, rel: string, body: string, mtimeMs: number): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  fs.utimesSync(p, mtimeMs / 1000, mtimeMs / 1000);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-sync-'));
  src = path.join(tmpDir, 'skills_for_nanoclaw');
  dst = path.join(tmpDir, 'session-skills');
  fs.mkdirSync(src, { recursive: true });
  fs.mkdirSync(dst, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('findDivergentSkillFiles', () => {
  it('reports a skill the container edited after the last sync', () => {
    write(src, 'morning-briefing/SKILL.md', 'calls foursquare\n', 1000);
    write(dst, 'morning-briefing/SKILL.md', 'calls checkin\n', 2000);

    const found = findDivergentSkillFiles(src, dst);

    expect(found).toHaveLength(1);
    expect(found[0].skill).toBe('morning-briefing');
    expect(found[0].relPath).toBe('SKILL.md');
  });
});

it('stays quiet when content matches, even though cpSync left dst newer', () => {
  // cpSync does not preserve mtimes, so after every ordinary sync the
  // destination is newer than the source. mtime alone would warn constantly.
  write(src, 'housekeeping/SKILL.md', 'same bytes\n', 1000);
  write(dst, 'housekeeping/SKILL.md', 'same bytes\n', 9999);

  expect(findDivergentSkillFiles(src, dst)).toEqual([]);
});

it('stays quiet when the repo is the newer side', () => {
  // A normal host-side edit. The repo is authoritative; overwrite silently.
  write(src, 'travel-recs/SKILL.md', 'host edit\n', 5000);
  write(dst, 'travel-recs/SKILL.md', 'older container copy\n', 1000);

  expect(findDivergentSkillFiles(src, dst)).toEqual([]);
});

it('finds an edit nested below the skill directory', () => {
  write(src, 'travel-recs/refs/places.md', 'old\n', 1000);
  write(dst, 'travel-recs/refs/places.md', 'new\n', 2000);

  expect(findDivergentSkillFiles(src, dst)).toEqual([
    { skill: 'travel-recs', relPath: path.join('refs', 'places.md') },
  ]);
});

it('ignores a skill that exists only in the session directory', () => {
  write(dst, 'ghost-skill/SKILL.md', 'orphan\n', 2000);

  expect(findDivergentSkillFiles(src, dst)).toEqual([]);
});

describe('quarantineDivergentFiles', () => {
  it("saves the container's version so the edit survives the overwrite", () => {
    write(src, 'morning-briefing/SKILL.md', 'calls foursquare\n', 1000);
    write(dst, 'morning-briefing/SKILL.md', 'calls checkin\n', 2000);
    const files = findDivergentSkillFiles(src, dst);
    const quarantine = path.join(tmpDir, 'quarantine');

    const dir = quarantineDivergentFiles(
      files,
      dst,
      quarantine,
      '20260912-101500',
    );

    const saved = path.join(dir, 'morning-briefing', 'SKILL.md');
    expect(fs.existsSync(saved)).toBe(true);
    expect(fs.readFileSync(saved, 'utf8')).toBe('calls checkin\n');
  });
});

describe('formatSkillOverwriteWarning', () => {
  it('names the skill and where the container version was saved', () => {
    const text = formatSkillOverwriteWarning(
      [{ skill: 'morning-briefing', relPath: 'SKILL.md' }],
      '/data/skill-edits/slack-main/20260912-101500',
    );

    expect(text).toContain('morning-briefing/SKILL.md');
    expect(text).toContain('/data/skill-edits/slack-main/20260912-101500');
    // Must point at the durable fix, or the edit is lost again next spawn.
    expect(text).toContain('skills_for_nanoclaw');
  });

  it('summarises rather than listing every file when many diverge', () => {
    const files = Array.from({ length: 7 }, (_, i) => ({
      skill: `skill-${i}`,
      relPath: 'SKILL.md',
    }));

    const text = formatSkillOverwriteWarning(files, '/tmp/q');

    expect(text).toContain('7');
    // Slack messages must stay readable — cap the enumerated entries.
    expect(text.split('\n').length).toBeLessThanOrEqual(10);
  });
});

describe('syncSkills', () => {
  const quarantineRoot = () => path.join(tmpDir, 'skill-edits');

  it('still overwrites, but saves the container edit and reports it first', () => {
    write(src, 'morning-briefing/SKILL.md', 'calls foursquare\n', 1000);
    write(dst, 'morning-briefing/SKILL.md', 'calls checkin\n', 2000);
    const reported: Array<{ count: number; dir: string }> = [];

    const diverged = syncSkills({
      srcRoot: src,
      dstRoot: dst,
      quarantineRoot: quarantineRoot(),
      onOverwrite: (files, dir) => reported.push({ count: files.length, dir }),
    });

    // The repo stays authoritative — the overwrite must still happen.
    expect(
      fs.readFileSync(path.join(dst, 'morning-briefing/SKILL.md'), 'utf8'),
    ).toBe('calls foursquare\n');
    expect(diverged).toHaveLength(1);
    expect(reported).toHaveLength(1);
    // ...and the container's version is recoverable.
    const saved = path.join(reported[0].dir, 'morning-briefing', 'SKILL.md');
    expect(fs.readFileSync(saved, 'utf8')).toBe('calls checkin\n');
  });

  it('stays silent and copies normally when nothing diverged', () => {
    write(src, 'housekeeping/SKILL.md', 'same\n', 1000);
    const reported: unknown[] = [];

    syncSkills({
      srcRoot: src,
      dstRoot: dst,
      quarantineRoot: quarantineRoot(),
      onOverwrite: (...a) => reported.push(a),
    });

    expect(
      fs.readFileSync(path.join(dst, 'housekeeping/SKILL.md'), 'utf8'),
    ).toBe('same\n');
    expect(reported).toHaveLength(0);
    // No empty quarantine directories on every ordinary spawn.
    expect(fs.existsSync(quarantineRoot())).toBe(false);
  });

  it('does not report a file the agent added, since nothing is lost', () => {
    write(src, 'trip-map/SKILL.md', 'body\n', 1000);
    write(dst, 'trip-map/SKILL.md', 'body\n', 1000);
    write(dst, 'trip-map/notes.md', 'agent scratch\n', 2000);
    const reported: unknown[] = [];

    syncSkills({
      srcRoot: src,
      dstRoot: dst,
      quarantineRoot: quarantineRoot(),
      onOverwrite: (...a) => reported.push(a),
    });

    expect(reported).toHaveLength(0);
    // The sync never prunes, so the agent's extra file survives on its own.
    expect(fs.existsSync(path.join(dst, 'trip-map/notes.md'))).toBe(true);
  });
});

describe('setSkillOverwriteNotify', () => {
  it('routes the warning to the channel index.ts wired up', () => {
    const sent: string[] = [];
    setSkillOverwriteNotify((t) => {
      sent.push(t);
    });

    notifySkillOverwrite('⚠ something');

    expect(sent).toEqual(['⚠ something']);
    setSkillOverwriteNotify(() => {});
  });

  it('does not let a failing channel break the spawn', () => {
    setSkillOverwriteNotify(() => {
      throw new Error('slack down');
    });

    // A container spawn must not die because a warning could not be delivered.
    expect(() => notifySkillOverwrite('⚠ something')).not.toThrow();
    setSkillOverwriteNotify(() => {});
  });
});
