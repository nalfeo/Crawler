import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GENERATED_MANIFEST_VERSION } from '../../../src/shared/generated-assets.js';
import type { ManifestEntry } from '../../../src/shared/generated-assets.js';
import {
  assertSafeManifestKey,
  composeManifest,
  composeManifestFromShards,
  deleteShard,
  keyFromShardRelPath,
  listShardRelPaths,
  loadGeneratedManifest,
  readAllShards,
  readShard,
  serializeManifest,
  shardPathForKey,
  shardsDir,
  writeShard,
} from '../../../scripts/sprites/generated-shards.js';

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    assetPath: 'generated/foo.png',
    briefId: 'foo-brief',
    spriteName: 'foo',
    ...overrides,
  } as ManifestEntry;
}

describe('generated-shards (Node shard I/O)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'crawler-shards-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('shardPathForKey / keyFromShardRelPath', () => {
    it('maps a slashed key to a nested path and back losslessly', () => {
      const key = 'equipment/weapon/bone-saw';
      const abs = shardPathForKey(dir, key);
      expect(abs.endsWith(`${path.join('entries', 'equipment', 'weapon', 'bone-saw')}.json`)).toBe(
        true,
      );
      const rel = path.relative(shardsDir(dir), abs);
      expect(keyFromShardRelPath(rel)).toBe(key);
    });

    it('round-trips a flat key', () => {
      const rel = path.relative(shardsDir(dir), shardPathForKey(dir, 'goblin-var-0'));
      expect(keyFromShardRelPath(rel)).toBe('goblin-var-0');
    });

    it('normalizes a Windows-separated rel path back to a POSIX key', () => {
      expect(keyFromShardRelPath('equipment\\weapon\\bone-saw.json')).toBe(
        'equipment/weapon/bone-saw',
      );
    });
  });

  describe('assertSafeManifestKey (trust boundary)', () => {
    it('accepts normal flat and slashed keys', () => {
      expect(() => assertSafeManifestKey('goblin-var-0')).not.toThrow();
      expect(() => assertSafeManifestKey('equipment/weapon/bone-saw')).not.toThrow();
    });

    it('rejects a traversal key that would escape the entries/ tree', () => {
      expect(() => assertSafeManifestKey('../../src/shared/data/sprite-catalog.json')).toThrow();
      expect(() => assertSafeManifestKey('a/../../b')).toThrow();
      expect(() => assertSafeManifestKey('.')).toThrow();
    });

    it('rejects absolute, backslash, and empty keys', () => {
      expect(() => assertSafeManifestKey('')).toThrow();
      expect(() => assertSafeManifestKey('/etc/passwd')).toThrow();
      expect(() => assertSafeManifestKey('C:/Windows/system32')).toThrow();
      expect(() => assertSafeManifestKey('equipment\\weapon\\x')).toThrow();
    });

    it('is enforced by shardPathForKey so every reader/writer is guarded', () => {
      expect(() => shardPathForKey(dir, '../../escape')).toThrow();
    });
  });

  describe('write / read / round-trip', () => {
    it('writes pretty JSON with a trailing newline', () => {
      const file = writeShard(dir, 'goblin', entry({ type: 'enemy' }));
      const raw = readFileSync(file, 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      expect(raw).toBe(`${JSON.stringify(entry({ type: 'enemy' }), null, 2)}\n`);
    });

    it('readShard returns the entry, or undefined when missing', () => {
      writeShard(dir, 'goblin', entry({ type: 'enemy' }));
      expect(readShard(dir, 'goblin')).toMatchObject({ type: 'enemy', briefId: 'foo-brief' });
      expect(readShard(dir, 'nope')).toBeUndefined();
    });

    it('readAllShards recovers every key including nested ones', () => {
      writeShard(dir, 'a', entry());
      writeShard(dir, 'equipment/weapon/b', entry());
      const all = readAllShards(dir);
      expect(Object.keys(all).sort()).toEqual(['a', 'equipment/weapon/b']);
    });

    // Regression gate for the mega-file failure mode that closed PR #1972: a
    // writer that round-trips entries through a lossy schema silently strips
    // per-asset fields (there, `opaqueBounds` on 462/464 entries). The shard
    // writer/composer MUST be a byte-faithful passthrough, so assert a FULL
    // deep-equality of a rich entry — including load-bearing `opaqueBounds` and
    // an unmodelled `.passthrough()` field — survives write -> compose intact.
    // Key-only assertions (used elsewhere in this file) would NOT catch this.
    it('preserves every field (opaqueBounds + unknown passthrough) through write -> compose', () => {
      const rich = entry({
        type: 'prop',
        opaqueBounds: { x: 3, y: 5, width: 12, height: 9, canvasWidth: 16, canvasHeight: 16 },
        catalog: { description: 'hand copy', tags: ['prop', 'generated', 'hand-authored'] },
        // An unmodelled field that only survives because the writer/composer do
        // raw JSON passthrough rather than schema-parsing the entry.
        futureField: { nested: [1, 2, 3] },
      } as Partial<ManifestEntry>);

      writeShard(dir, 'welcome-room-rug-var-0', rich);
      const composed = composeManifestFromShards(dir);

      expect(composed.entries['welcome-room-rug-var-0']).toEqual(rich);
    });
  });

  describe('listShardRelPaths', () => {
    it('returns [] when the shards dir does not exist', () => {
      expect(listShardRelPaths(dir)).toEqual([]);
    });

    it('lists shards POSIX-separated and sorted', () => {
      writeShard(dir, 'zeta', entry());
      writeShard(dir, 'equipment/weapon/alpha', entry());
      expect(listShardRelPaths(dir)).toEqual(['equipment/weapon/alpha.json', 'zeta.json']);
    });
  });

  describe('deleteShard', () => {
    it('deletes the shard and prunes now-empty ancestor dirs', () => {
      writeShard(dir, 'equipment/weapon/only', entry());
      expect(deleteShard(dir, 'equipment/weapon/only')).toBe(true);
      // The entire equipment/ subtree should be pruned since it is now empty.
      expect(listShardRelPaths(dir)).toEqual([]);
    });

    it('does not prune a sibling-occupied ancestor', () => {
      writeShard(dir, 'equipment/weapon/a', entry());
      writeShard(dir, 'equipment/weapon/b', entry());
      deleteShard(dir, 'equipment/weapon/a');
      expect(listShardRelPaths(dir)).toEqual(['equipment/weapon/b.json']);
    });

    it('returns false when the shard is absent', () => {
      expect(deleteShard(dir, 'ghost')).toBe(false);
    });
  });

  describe('composeManifest / composeManifestFromShards', () => {
    it('sorts keys deterministically and stamps the version', () => {
      const composed = composeManifest({ zed: entry(), abc: entry() });
      expect(composed.version).toBe(GENERATED_MANIFEST_VERSION);
      expect(Object.keys(composed.entries)).toEqual(['abc', 'zed']);
    });

    it('composes the aggregate from on-disk shards, sorted', () => {
      writeShard(dir, 'zed', entry({ type: 'weapon' }));
      writeShard(dir, 'abc', entry({ type: 'item' }));
      const composed = composeManifestFromShards(dir);
      expect(Object.keys(composed.entries)).toEqual(['abc', 'zed']);
    });

    it('composition is byte-stable across two reads (the CI determinism invariant)', () => {
      writeShard(dir, 'a/b/c', entry({ type: 'prop' }));
      writeShard(dir, 'a/d', entry({ type: 'item' }));
      const first = serializeManifest(composeManifestFromShards(dir));
      const second = serializeManifest(composeManifestFromShards(dir));
      expect(first).toBe(second);
      expect(first.endsWith('\n')).toBe(true);
    });

    it('an empty shards dir composes to an empty manifest', () => {
      mkdirSync(shardsDir(dir), { recursive: true });
      const composed = composeManifestFromShards(dir);
      expect(composed.entries).toEqual({});
      expect(composed.version).toBe(GENERATED_MANIFEST_VERSION);
    });
  });

  describe('loadGeneratedManifest (fresh-checkout tolerance)', () => {
    it('composes from shards when the entries/ dir exists (aggregate absent)', () => {
      writeShard(dir, 'zed', entry({ type: 'weapon' }));
      writeShard(dir, 'abc', entry({ type: 'item' }));
      const manifest = loadGeneratedManifest(dir);
      expect(Object.keys(manifest.entries)).toEqual(['abc', 'zed']);
    });

    it('prefers shards over a STALE aggregate file on disk', () => {
      writeShard(dir, 'fresh', entry({ type: 'item' }));
      // A stale aggregate that disagrees with the shards must be ignored.
      writeFileSync(
        path.join(dir, 'manifest.json'),
        serializeManifest(composeManifest({ stale: entry({ type: 'weapon' }) })),
      );
      const manifest = loadGeneratedManifest(dir);
      expect(Object.keys(manifest.entries)).toEqual(['fresh']);
    });

    it('falls back to a committed aggregate in a legacy tree with no shards', () => {
      writeFileSync(
        path.join(dir, 'manifest.json'),
        serializeManifest(composeManifest({ legacy: entry({ type: 'item' }) })),
      );
      const manifest = loadGeneratedManifest(dir);
      expect(Object.keys(manifest.entries)).toEqual(['legacy']);
    });

    it('returns an empty manifest when neither shards nor an aggregate exist', () => {
      const manifest = loadGeneratedManifest(dir);
      expect(manifest.entries).toEqual({});
      expect(manifest.version).toBe(GENERATED_MANIFEST_VERSION);
    });
  });

  describe('shard byte-format matches a pre-written entry', () => {
    it('writeShard output equals a hand-written pretty file', () => {
      const key = 'equipment/weapon/hand';
      const value = entry({ type: 'weapon', catalog: { description: 'x' } });
      const manual = shardPathForKey(dir, key);
      mkdirSync(path.dirname(manual), { recursive: true });
      writeFileSync(manual, `${JSON.stringify(value, null, 2)}\n`);
      const before = readFileSync(manual, 'utf8');
      writeShard(dir, key, value);
      expect(readFileSync(manual, 'utf8')).toBe(before);
    });
  });
});
