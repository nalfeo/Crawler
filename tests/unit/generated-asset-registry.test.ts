/**
 * Unit tests for the engine-portable generated sprite registry.
 *
 * Covers schema validation, registry lookup semantics, anchor fallback
 * for null-anchor manifest entries, and the empty-registry boot path.
 */

import { describe, expect, it } from 'vitest';
import {
  buildGeneratedSpriteRegistry,
  DEFAULT_GENERATED_ANCHOR,
  emptyGeneratedSpriteRegistry,
  loadGeneratedManifest,
  parseGeneratedManifest,
  GENERATED_MANIFEST_VERSION,
} from '../../src/shared/generated-assets.js';

const baseEntry = {
  briefId: 'iron-sword',
  spriteName: 'iron-sword',
  assetPath: 'generated/iron-sword.png',
  approvedAt: '2026-06-08T15:30:00.000Z',
  sourceRun: 'generated/runs/iron-sword/2026-06-08T12-00-00-deadbeef',
  variantIndex: 1,
  anchor: { x: 8, y: 13, source: 'brief' as const },
  sensorScore: '7/7',
  judgeScore: '4',
};

const emptyManifestJson = { version: GENERATED_MANIFEST_VERSION, entries: {} };

describe('parseGeneratedManifest', () => {
  it('accepts the canonical empty manifest', () => {
    const manifest = parseGeneratedManifest(emptyManifestJson);
    expect(manifest.version).toBe(GENERATED_MANIFEST_VERSION);
    expect(Object.keys(manifest.entries)).toHaveLength(0);
  });

  it('accepts a populated manifest with a brief-sourced anchor', () => {
    const manifest = parseGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'iron-sword': baseEntry },
    });
    expect(manifest.entries['iron-sword']?.anchor).toEqual({ x: 8, y: 13, source: 'brief' });
  });

  it('rejects an unsupported version number', () => {
    expect(() => parseGeneratedManifest({ version: 2, entries: {} })).toThrow();
  });

  it('rejects a manifest missing a required entry field', () => {
    const broken = {
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'iron-sword': { ...baseEntry, spriteName: undefined },
      },
    };
    expect(() => parseGeneratedManifest(broken)).toThrow();
  });

  it('rejects a malformed top-level shape', () => {
    expect(() => parseGeneratedManifest({ entries: { foo: baseEntry } })).toThrow();
    expect(() => parseGeneratedManifest('not an object')).toThrow();
  });
});

describe('loadGeneratedManifest', () => {
  it('returns an empty registry for the canonical empty manifest', () => {
    const registry = loadGeneratedManifest(emptyManifestJson);
    expect(registry.size).toBe(0);
    expect(registry.lookup('anything')).toBeNull();
    expect(registry.has('anything')).toBe(false);
    expect(registry.entries()).toEqual([]);
  });

  it('exposes a single entry via lookup and entries()', () => {
    const registry = loadGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'iron-sword': baseEntry },
    });
    expect(registry.size).toBe(1);
    const found = registry.lookup('iron-sword');
    expect(found).not.toBeNull();
    expect(found?.textureKey).toBe('iron-sword');
    expect(found?.assetPath).toBe('generated/iron-sword.png');
    expect(found?.anchor).toEqual({ x: 8, y: 13 });
    expect(found?.anchorIsDefault).toBe(false);
    expect(registry.entries()).toHaveLength(1);
  });

  it('returns null from lookup for an unknown briefId', () => {
    const registry = loadGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'iron-sword': baseEntry },
    });
    expect(registry.lookup('not-a-thing')).toBeNull();
    expect(registry.has('not-a-thing')).toBe(false);
  });

  it('falls back to DEFAULT_GENERATED_ANCHOR when the entry anchor is null', () => {
    const registry = loadGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'throwing-star': { ...baseEntry, briefId: 'throwing-star', anchor: null },
      },
    });
    const found = registry.lookup('throwing-star');
    expect(found?.anchor).toEqual(DEFAULT_GENERATED_ANCHOR);
    expect(found?.anchorIsDefault).toBe(true);
  });

  it('preserves derived-source anchors verbatim', () => {
    const registry = loadGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'baseball-bat': {
          ...baseEntry,
          briefId: 'baseball-bat',
          spriteName: 'baseball-bat',
          assetPath: 'generated/baseball-bat.png',
          anchor: { x: 5, y: 12, source: 'derived' },
        },
      },
    });
    const found = registry.lookup('baseball-bat');
    expect(found?.anchor).toEqual({ x: 5, y: 12 });
    expect(found?.anchorIsDefault).toBe(false);
  });

  it('builds a registry over multiple entries', () => {
    const registry = loadGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'iron-sword': baseEntry,
        'throwing-star': { ...baseEntry, briefId: 'throwing-star', spriteName: 'throwing-star' },
      },
    });
    expect(registry.size).toBe(2);
    expect(registry.lookup('iron-sword')).not.toBeNull();
    expect(registry.lookup('throwing-star')).not.toBeNull();
  });
});

describe('buildGeneratedSpriteRegistry', () => {
  it('parses raw JSON and returns a lookup registry', () => {
    const registry = buildGeneratedSpriteRegistry({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'iron-sword': baseEntry },
    });
    expect(registry.lookup('iron-sword')?.textureKey).toBe('iron-sword');
  });

  it('throws on malformed input (callers may catch for soft-fail)', () => {
    expect(() => buildGeneratedSpriteRegistry({ totally: 'wrong' })).toThrow();
  });
});

describe('emptyGeneratedSpriteRegistry', () => {
  it('produces a registry with no entries that never crashes on lookup', () => {
    const registry = emptyGeneratedSpriteRegistry();
    expect(registry.size).toBe(0);
    expect(registry.lookup('iron-sword')).toBeNull();
    expect(registry.has('iron-sword')).toBe(false);
    expect(registry.entries()).toEqual([]);
  });
});
