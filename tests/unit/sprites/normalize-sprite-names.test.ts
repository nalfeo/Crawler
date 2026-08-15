import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { normalizeSpriteNames } from '../../../scripts/sprites/normalize-sprite-names.js';

/**
 * These tests run the migration against a REAL temporary generated dir rather
 * than a mocked fs, because the bug class this migration is most exposed to is
 * a filesystem-ordering hazard (rename chains/cycles clobbering each other),
 * which an in-memory stub would not reproduce.
 */
let dir: string;

function shard(key: string, entry: Record<string, unknown>): void {
  const file = path.join(dir, 'entries', `${key}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(entry, null, 2)}\n`);
  // A matching PNG, so asset moves are exercised too.
  writeFileSync(path.join(dir, `${key}.png`), key);
}

function shardKeys(): string[] {
  const root = path.join(dir, 'entries');
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const dirent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isDirectory()) walk(path.join(abs, dirent.name), childRel);
      else if (dirent.name.endsWith('.json')) out.push(childRel.replace(/\.json$/, ''));
    }
  };
  walk(root, '');
  return out.sort();
}

function readShard(key: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(dir, 'entries', `${key}.json`), 'utf8')) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sprite-names-'));
  mkdirSync(path.join(dir, 'entries'), { recursive: true });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('normalizeSpriteNames', () => {
  it('de-versions a single-lineage concept and moves its PNG', async () => {
    shard('rat-v1-var-0', {
      briefId: 'rat-v1',
      spriteName: 'rat-v1-var-0',
      assetPath: 'generated/rat-v1-var-0.png',
      variantIndex: 0,
      sourceRun: 'run-a',
    });

    await normalizeSpriteNames({ generatedDir: dir, mode: 'apply' });

    expect(shardKeys()).toEqual(['rat-var-0']);
    const entry = readShard('rat-var-0');
    expect(entry).toMatchObject({
      briefId: 'rat',
      spriteName: 'rat-var-0',
      assetPath: 'generated/rat-var-0.png',
    });
    expect(readdirSync(dir).filter((f) => f.endsWith('.png'))).toEqual(['rat-var-0.png']);
  });

  it('preserves every non-identity field verbatim', async () => {
    shard('rat-v1-var-0', {
      briefId: 'rat-v1',
      spriteName: 'rat-v1-var-0',
      assetPath: 'generated/rat-v1-var-0.png',
      variantIndex: 0,
      sourceRun: 'run-a',
      contentHash: 'abc123',
      sensorScore: '7/8',
      judgeScore: '4',
      type: 'enemy',
      anchor: { x: 28, y: 30, source: 'derived' },
      opaqueBounds: { x: 3, y: 11, width: 58, height: 42, canvasWidth: 64, canvasHeight: 64 },
    });

    await normalizeSpriteNames({ generatedDir: dir, mode: 'apply' });

    const entry = readShard('rat-var-0');
    expect(entry.contentHash).toBe('abc123');
    expect(entry.sensorScore).toBe('7/8');
    expect(entry.type).toBe('enemy');
    expect(entry.anchor).toEqual({ x: 28, y: 30, source: 'derived' });
    expect(entry.opaqueBounds).toMatchObject({ width: 58, height: 42 });
  });

  it('REGRESSION: a rename chain never destroys an approved variant', async () => {
    // The real `rat` case that lost art. Three entries, two lineages:
    //   rat-var-9      (newest) -> renumbered to rat-var-0
    //   rat-v1-var-9   (older)  -> takes rat-var-9, which is STILL OCCUPIED
    //   rat-v1-var-3   (older)  -> rat-var-3
    // A naive sequential rename writes rat-v1-var-9 onto rat-var-9 before its
    // occupant has moved, clobbering it — 5 concepts silently lost a variant.
    shard('rat-var-9', {
      briefId: 'rat',
      spriteName: 'rat-var-9',
      assetPath: 'generated/rat-var-9.png',
      variantIndex: 9,
      sourceRun: 'run-newest',
      approvedAt: '2026-08-01T16:34:44Z',
    });
    shard('rat-v1-var-3', {
      briefId: 'rat-v1',
      spriteName: 'rat-v1-var-3',
      assetPath: 'generated/rat-v1-var-3.png',
      variantIndex: 3,
      sourceRun: 'run-old-a',
      approvedAt: '2026-06-29T06:42:37Z',
    });
    shard('rat-v1-var-9', {
      briefId: 'rat-v1',
      spriteName: 'rat-v1-var-9',
      assetPath: 'generated/rat-v1-var-9.png',
      variantIndex: 9,
      sourceRun: 'run-old-b',
      approvedAt: '2026-06-29T06:42:49Z',
    });

    await normalizeSpriteNames({ generatedDir: dir, mode: 'apply' });

    const keys = shardKeys();
    // All three approved variants must survive the merge.
    expect(keys).toHaveLength(3);
    const runs = keys.map((k) => readShard(k).sourceRun).sort();
    expect(runs).toEqual(['run-newest', 'run-old-a', 'run-old-b']);
    // Every entry now belongs to the single `rat` bucket.
    for (const key of keys) {
      expect(readShard(key).briefId).toBe('rat');
    }
    // Variant indices are unique, so no two entries collide at runtime.
    const indices = keys.map((k) => readShard(k).variantIndex);
    expect(new Set(indices).size).toBe(3);
  });

  it('keeps a PNG for every surviving shard after a rename chain', async () => {
    shard('slime-var-3', {
      briefId: 'slime',
      spriteName: 'slime-var-3',
      assetPath: 'generated/slime-var-3.png',
      variantIndex: 3,
      approvedAt: '2026-01-01T00:00:00Z',
      sourceRun: 'a',
    });
    shard('slime-v1-var-3', {
      briefId: 'slime-v1',
      spriteName: 'slime-v1-var-3',
      assetPath: 'generated/slime-v1-var-3.png',
      variantIndex: 3,
      approvedAt: '2026-02-01T00:00:00Z',
      sourceRun: 'b',
    });

    await normalizeSpriteNames({ generatedDir: dir, mode: 'apply' });

    const pngs = new Set(readdirSync(dir).filter((f) => f.endsWith('.png')));
    for (const key of shardKeys()) {
      const assetPath = readShard(key).assetPath as string;
      expect(pngs.has(path.basename(assetPath))).toBe(true);
    }
    // No temp staging artifacts left behind.
    expect([...pngs].some((p) => p.includes('__migrating__'))).toBe(false);
    expect(shardKeys().some((k) => k.includes('__migrating__'))).toBe(false);
  });

  it('is idempotent — a second apply is a no-op', async () => {
    shard('rat-v1-var-0', {
      briefId: 'rat-v1',
      spriteName: 'rat-v1-var-0',
      assetPath: 'generated/rat-v1-var-0.png',
      variantIndex: 0,
      sourceRun: 'run-a',
    });

    await normalizeSpriteNames({ generatedDir: dir, mode: 'apply' });
    const afterFirst = shardKeys().map((k) => JSON.stringify(readShard(k)));

    const second = await normalizeSpriteNames({ generatedDir: dir, mode: 'apply' });

    expect(second.plan.renames).toEqual([]);
    expect(shardKeys().map((k) => JSON.stringify(readShard(k)))).toEqual(afterFirst);
  });

  it('--check reports a pending migration without touching disk', async () => {
    shard('rat-v1-var-0', {
      briefId: 'rat-v1',
      spriteName: 'rat-v1-var-0',
      assetPath: 'generated/rat-v1-var-0.png',
      variantIndex: 0,
      sourceRun: 'run-a',
    });

    const result = await normalizeSpriteNames({ generatedDir: dir, mode: 'check' });

    expect(result.clean).toBe(false);
    expect(shardKeys()).toEqual(['rat-v1-var-0']);
  });

  it('retires a placeholder once its concept has real bare art', async () => {
    shard('rat-placeholder', {
      briefId: 'rat',
      spriteName: 'rat-placeholder',
      assetPath: 'generated/rat-placeholder.png',
      sourceRun: 'placeholder',
    });
    shard('rat-v1-var-0', {
      briefId: 'rat-v1',
      spriteName: 'rat-v1-var-0',
      assetPath: 'generated/rat-v1-var-0.png',
      variantIndex: 0,
      sourceRun: 'run-a',
    });

    await normalizeSpriteNames({ generatedDir: dir, mode: 'apply' });

    expect(shardKeys()).toEqual(['rat-var-0']);
    expect(readdirSync(dir).filter((f) => f.endsWith('.png'))).toEqual(['rat-var-0.png']);
  });

  it('keeps a placeholder whose concept has no real art', async () => {
    shard('lonely-thing-placeholder', {
      briefId: 'lonely-thing',
      spriteName: 'lonely-thing-placeholder',
      assetPath: 'generated/lonely-thing-placeholder.png',
      sourceRun: 'placeholder',
    });

    await normalizeSpriteNames({ generatedDir: dir, mode: 'apply' });

    expect(shardKeys()).toEqual(['lonely-thing-placeholder']);
  });
});
