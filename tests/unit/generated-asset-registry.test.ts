/**
 * Unit tests for the engine-portable generated sprite registry.
 *
 * Covers schema validation, registry lookup semantics, anchor fallback
 * for null-anchor manifest entries, and the empty-registry boot path.
 */

import { describe, expect, it } from 'vitest';
import {
  buildGeneratedSpriteRegistry,
  emptyGeneratedSpriteRegistry,
  loadGeneratedManifest,
  parseGeneratedManifest,
  pickGeneratedVariant,
  GENERATED_MANIFEST_VERSION,
} from '../../src/shared/generated-assets.js';
import { hashStringToSeed } from '../../src/shared/random.js';

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

  it('falls back to { x: 8, y: 8 } (DEFAULT_GENERATED_ANCHOR) when the entry anchor is null', () => {
    const registry = loadGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'throwing-star': { ...baseEntry, briefId: 'throwing-star', anchor: null },
      },
    });
    const found = registry.lookup('throwing-star');
    expect(found?.anchor).toEqual({ x: 8, y: 8 });
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

describe('loadGeneratedManifest — multiple variants per brief', () => {
  // Mirrors what current approve.ts writes: per-variant manifest KEY
  // (`<brief>-var-<N>`) but historically a brief-wide `spriteName`. The
  // registry must key textures off the unique map key, not `spriteName`.
  const variantManifest = {
    version: GENERATED_MANIFEST_VERSION,
    entries: {
      'skull-mace-var-5': {
        ...baseEntry,
        briefId: 'skull-mace',
        spriteName: 'skull-mace',
        assetPath: 'generated/skull-mace-var-5.png',
        variantIndex: 5,
      },
      'skull-mace-var-2': {
        ...baseEntry,
        briefId: 'skull-mace',
        spriteName: 'skull-mace',
        assetPath: 'generated/skull-mace-var-2.png',
        variantIndex: 2,
      },
    },
  };

  it('derives a unique textureKey per variant from the manifest key', () => {
    const registry = loadGeneratedManifest(variantManifest);
    const keys = registry
      .entries()
      .map((e) => e.textureKey)
      .sort();
    expect(keys).toEqual(['skull-mace-var-2', 'skull-mace-var-5']);
  });

  it('counts every variant in size and flattens entries()', () => {
    const registry = loadGeneratedManifest(variantManifest);
    expect(registry.size).toBe(2);
    expect(registry.entries()).toHaveLength(2);
    expect(registry.briefIds()).toEqual(['skull-mace']);
  });

  it('exposes all variants for a brief sorted by variantIndex', () => {
    const registry = loadGeneratedManifest(variantManifest);
    const variants = registry.variants('skull-mace');
    expect(variants.map((v) => v.variantIndex)).toEqual([2, 5]);
    expect(variants.map((v) => v.textureKey)).toEqual(['skull-mace-var-2', 'skull-mace-var-5']);
  });

  it('lookup returns the first variant (lowest variantIndex) deterministically', () => {
    const registry = loadGeneratedManifest(variantManifest);
    expect(registry.lookup('skull-mace')?.textureKey).toBe('skull-mace-var-2');
  });

  it('variants() returns an empty list for an unknown brief', () => {
    const registry = loadGeneratedManifest(variantManifest);
    expect(registry.variants('nope')).toEqual([]);
    expect(registry.has('nope')).toBe(false);
  });
});

describe('manifest entry animation descriptor', () => {
  const animatedEntry = {
    ...baseEntry,
    briefId: 'player-walk',
    spriteName: 'player-walk-v1-var-0',
    assetPath: 'generated/player-walk-v1-var-0.png',
    animation: {
      frameWidth: 16,
      frameHeight: 16,
      frameCount: 3,
      frameRate: 6,
      loop: true,
    },
  };

  it('parses an entry with an animation descriptor', () => {
    const manifest = parseGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'player-walk-v1-var-0': animatedEntry },
    });
    expect(manifest.entries['player-walk-v1-var-0']?.animation).toEqual({
      frameWidth: 16,
      frameHeight: 16,
      frameCount: 3,
      frameRate: 6,
      loop: true,
    });
  });

  it('leaves animation undefined for an entry without the field', () => {
    const manifest = parseGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'iron-sword': baseEntry },
    });
    expect(manifest.entries['iron-sword']?.animation).toBeUndefined();
    const registry = loadGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'iron-sword': baseEntry },
    });
    expect(registry.lookup('iron-sword')?.animation).toBeUndefined();
  });

  it('surfaces the animation descriptor on the registry entry', () => {
    const registry = loadGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'player-walk-v1-var-0': animatedEntry },
    });
    expect(registry.lookup('player-walk')?.animation).toEqual({
      frameWidth: 16,
      frameHeight: 16,
      frameCount: 3,
      frameRate: 6,
      loop: true,
    });
  });

  it('defaults loop to true when omitted', () => {
    const manifest = parseGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: {
        'player-walk-v1-var-0': {
          ...animatedEntry,
          animation: { frameWidth: 16, frameHeight: 16, frameCount: 3, frameRate: 6 },
        },
      },
    });
    expect(manifest.entries['player-walk-v1-var-0']?.animation?.loop).toBe(true);
  });

  it('rejects a frameCount below 2', () => {
    expect(() =>
      parseGeneratedManifest({
        version: GENERATED_MANIFEST_VERSION,
        entries: {
          'player-walk-v1-var-0': {
            ...animatedEntry,
            animation: { ...animatedEntry.animation, frameCount: 1 },
          },
        },
      }),
    ).toThrow();
  });

  it('rejects a non-positive frameRate', () => {
    expect(() =>
      parseGeneratedManifest({
        version: GENERATED_MANIFEST_VERSION,
        entries: {
          'player-walk-v1-var-0': {
            ...animatedEntry,
            animation: { ...animatedEntry.animation, frameRate: 0 },
          },
        },
      }),
    ).toThrow();
  });

  it('rejects non-positive frame dimensions', () => {
    expect(() =>
      parseGeneratedManifest({
        version: GENERATED_MANIFEST_VERSION,
        entries: {
          'player-walk-v1-var-0': {
            ...animatedEntry,
            animation: { ...animatedEntry.animation, frameWidth: 0 },
          },
        },
      }),
    ).toThrow();
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

describe('pickGeneratedVariant', () => {
  const make = (briefId: string, spriteName: string, variantIndex: number, assetPath: string) => ({
    ...baseEntry,
    briefId,
    spriteName,
    variantIndex,
    assetPath,
  });

  const multi = loadGeneratedManifest({
    version: GENERATED_MANIFEST_VERSION,
    entries: {
      'skull-mace-var-1': make('skull-mace', 'skull-mace', 1, 'generated/skull-mace-var-1.png'),
      'skull-mace-var-2': make('skull-mace', 'skull-mace', 2, 'generated/skull-mace-var-2.png'),
      'skull-mace-var-3': make('skull-mace', 'skull-mace', 3, 'generated/skull-mace-var-3.png'),
    },
  });

  it('returns null for a brief with no approved variants', () => {
    expect(pickGeneratedVariant(emptyGeneratedSpriteRegistry(), 'skull-mace', 123)).toBeNull();
  });

  it('returns the only variant without depending on the seed', () => {
    const single = loadGeneratedManifest({
      version: GENERATED_MANIFEST_VERSION,
      entries: { 'iron-sword-var-0': baseEntry },
    });
    expect(pickGeneratedVariant(single, 'iron-sword', 1)?.textureKey).toBe('iron-sword-var-0');
    expect(pickGeneratedVariant(single, 'iron-sword', 999)?.textureKey).toBe('iron-sword-var-0');
  });

  it('is deterministic for a given seed', () => {
    const seed = hashStringToSeed('skull-mace') ^ 42;
    const a = pickGeneratedVariant(multi, 'skull-mace', seed)?.textureKey;
    const b = pickGeneratedVariant(multi, 'skull-mace', seed)?.textureKey;
    expect(a).toBe(b);
    expect(a).toMatch(/^skull-mace-var-[123]$/);
  });

  it('always returns one of the registered variants', () => {
    const keys = new Set(multi.variants('skull-mace').map((v) => v.textureKey));
    for (let seed = 0; seed < 50; seed++) {
      const picked = pickGeneratedVariant(multi, 'skull-mace', seed * 2654435761)?.textureKey;
      expect(picked).toBeDefined();
      expect(keys.has(picked!)).toBe(true);
    }
  });

  it('spreads across variants for different seeds', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 64; seed++) {
      const picked = pickGeneratedVariant(multi, 'skull-mace', seed * 0x9e3779b1)?.textureKey;
      if (picked) seen.add(picked);
    }
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('hashStringToSeed', () => {
  it('is deterministic for the same input', () => {
    expect(hashStringToSeed('skull-mace')).toBe(hashStringToSeed('skull-mace'));
  });

  it('differs for different inputs (no trivial collisions on sample set)', () => {
    const ids = ['skull-mace', 'iron-sword', 'throwing-star', 'bent-pipe-v1', 'a', 'b'];
    const seeds = new Set(ids.map(hashStringToSeed));
    expect(seeds.size).toBe(ids.length);
  });

  it('never returns 0 (the xorshift32 fixed point)', () => {
    // Empty string would FNV-hash to the offset basis, not 0, but guard anyway.
    expect(hashStringToSeed('')).not.toBe(0);
  });
});
