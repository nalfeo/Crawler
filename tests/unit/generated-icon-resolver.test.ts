import { describe, expect, it, vi } from 'vitest';
import type Phaser from 'phaser';
import { resolveGeneratedIconEntry } from '../../src/engine/generated-icon-resolver.js';
import { GENERATED_SPRITE_REGISTRY_KEY } from '../../src/engine/generatedAssets/index.js';
import type {
  GeneratedSpriteEntry,
  GeneratedSpriteRegistry,
} from '../../src/shared/generated-assets.js';

function makeEntry(overrides: Partial<GeneratedSpriteEntry> & { textureKey: string }) {
  const { textureKey, ...rest } = overrides;
  return {
    briefId: 'some-brief',
    assetPath: `generated/${textureKey}.png`,
    anchor: { x: 8, y: 8 },
    centerOfGravity: { x: 8, y: 8 },
    anchorIsDefault: true,
    approvedAt: '2026-01-01T00:00:00.000Z',
    sourceRun: 'run-1',
    variantIndex: 0,
    sensorScore: '1',
    judgeScore: null,
    facingDirection: 'right',
    ...rest,
    textureKey,
  } as GeneratedSpriteEntry;
}

function makeRegistry(entries: readonly GeneratedSpriteEntry[]): GeneratedSpriteRegistry {
  const byBrief = new Map<string, GeneratedSpriteEntry[]>();
  for (const entry of entries) {
    const bucket = byBrief.get(entry.briefId);
    if (bucket) bucket.push(entry);
    else byBrief.set(entry.briefId, [entry]);
  }
  return {
    version: 1,
    lookup: (briefId: string) => byBrief.get(briefId)?.[0] ?? null,
    variants: (briefId: string) => byBrief.get(briefId) ?? [],
    entries: vi.fn(() => entries),
    briefIds: () => [...byBrief.keys()],
    has: (briefId: string) => byBrief.has(briefId),
    size: entries.length,
  };
}

function makeScene(registry: unknown, loadedTextureKeys: ReadonlySet<string>): Phaser.Scene {
  return {
    game: {
      registry: {
        get: vi.fn((key: string) => (key === GENERATED_SPRITE_REGISTRY_KEY ? registry : undefined)),
      },
    },
    textures: { exists: vi.fn((key: string) => loadedTextureKeys.has(key)) },
  } as unknown as Phaser.Scene;
}

describe('resolveGeneratedIconEntry', () => {
  it('returns null when the scene has no generated sprite registry', () => {
    const scene = makeScene(undefined, new Set());
    expect(
      resolveGeneratedIconEntry(scene, { briefIds: ['brief-1'], textureKeys: [], seed: 1 }),
    ).toBeNull();
  });

  it('returns null when the registry value on the scene is malformed', () => {
    const scene = makeScene({ variants: 'not-a-function' }, new Set());
    expect(
      resolveGeneratedIconEntry(scene, { briefIds: ['brief-1'], textureKeys: [], seed: 1 }),
    ).toBeNull();
  });

  it('resolves via briefIds when the variant texture is loaded', () => {
    const entry = makeEntry({ briefId: 'brief-1', textureKey: 'brief-1-tex' });
    const registry = makeRegistry([entry]);
    const scene = makeScene(registry, new Set(['brief-1-tex']));
    const result = resolveGeneratedIconEntry(scene, {
      briefIds: ['brief-1'],
      textureKeys: [],
      seed: 1,
    });
    expect(result).toEqual(entry);
  });

  it('skips a brief match whose texture is not loaded and tries the next briefId', () => {
    const unloaded = makeEntry({ briefId: 'brief-1', textureKey: 'brief-1-tex' });
    const loaded = makeEntry({ briefId: 'brief-2', textureKey: 'brief-2-tex' });
    const registry = makeRegistry([unloaded, loaded]);
    const scene = makeScene(registry, new Set(['brief-2-tex']));
    const result = resolveGeneratedIconEntry(scene, {
      briefIds: ['brief-1', 'brief-2'],
      textureKeys: [],
      seed: 1,
    });
    expect(result).toEqual(loaded);
  });

  it('falls back to textureKeys when no briefId variant has a loaded texture', () => {
    const brief = makeEntry({ briefId: 'brief-1', textureKey: 'brief-1-tex' });
    const fallback = makeEntry({ briefId: 'other-brief', textureKey: 'fallback-tex' });
    const registry = makeRegistry([brief, fallback]);
    const scene = makeScene(registry, new Set(['fallback-tex']));
    const result = resolveGeneratedIconEntry(scene, {
      briefIds: ['brief-1'],
      textureKeys: ['fallback-tex'],
      seed: 1,
    });
    expect(result).toEqual(fallback);
  });

  it('picks the lowest-variantIndex loaded entry when a textureKey has multiple variants', () => {
    const higher = makeEntry({ briefId: 'brief-2', textureKey: 'fallback-tex', variantIndex: 2 });
    const lower = makeEntry({ briefId: 'brief-3', textureKey: 'fallback-tex', variantIndex: 0 });
    const registry = makeRegistry([higher, lower]);
    const scene = makeScene(registry, new Set(['fallback-tex']));
    const result = resolveGeneratedIconEntry(scene, {
      briefIds: [],
      textureKeys: ['fallback-tex'],
      seed: 1,
    });
    expect(result).toEqual(lower);
  });

  it('returns null when neither briefIds nor textureKeys resolve to a loaded texture', () => {
    const entry = makeEntry({ briefId: 'brief-1', textureKey: 'brief-1-tex' });
    const registry = makeRegistry([entry]);
    const scene = makeScene(registry, new Set());
    expect(
      resolveGeneratedIconEntry(scene, { briefIds: ['brief-1'], textureKeys: [], seed: 1 }),
    ).toBeNull();
  });

  it('ties on textureKey when two candidates share the same variantIndex', () => {
    const entryTexB = makeEntry({ briefId: 'brief-a', textureKey: 'tex-b', variantIndex: 0 });
    const entryTexA = makeEntry({ briefId: 'brief-b', textureKey: 'tex-a', variantIndex: 0 });
    const registry = makeRegistry([entryTexB, entryTexA]);
    const scene = makeScene(registry, new Set(['tex-a', 'tex-b']));
    const result = resolveGeneratedIconEntry(scene, {
      briefIds: [],
      textureKeys: ['tex-b', 'tex-a'],
      seed: 1,
    });
    // 'tex-b' is scanned first and becomes the incumbent `best`; only the
    // textureKey localeCompare tie-break in `compareEntries` can make 'tex-a'
    // displace it. If that tie-break were removed, `best` would stay 'tex-b'
    // and this assertion would fail.
    expect(result).toEqual(entryTexA);
  });

  it('reuses the cached texture index across repeated calls for the same registry', () => {
    const entry = makeEntry({ briefId: 'brief-1', textureKey: 'fallback-tex' });
    const registry = makeRegistry([entry]);
    const scene = makeScene(registry, new Set(['fallback-tex']));
    const options = { briefIds: [], textureKeys: ['fallback-tex'], seed: 1 };
    const first = resolveGeneratedIconEntry(scene, options);
    const second = resolveGeneratedIconEntry(scene, options);
    expect(first).toEqual(entry);
    expect(second).toEqual(entry);
    // The texture index (and the registry.entries() scan that builds it) must be
    // built once and cached, not rebuilt on every call.
    expect(vi.mocked(registry.entries)).toHaveBeenCalledTimes(1);
  });

  it('skips a textureKey with no indexed variants at all', () => {
    const entry = makeEntry({ briefId: 'brief-1', textureKey: 'known-tex' });
    const registry = makeRegistry([entry]);
    const scene = makeScene(registry, new Set(['known-tex', 'unknown-tex']));
    const result = resolveGeneratedIconEntry(scene, {
      briefIds: [],
      textureKeys: ['unknown-tex', 'known-tex'],
      seed: 1,
    });
    expect(result).toEqual(entry);
  });

  it('returns null immediately when both briefIds and textureKeys are empty', () => {
    const registry = makeRegistry([]);
    const scene = makeScene(registry, new Set());
    expect(resolveGeneratedIconEntry(scene, { briefIds: [], textureKeys: [], seed: 1 })).toBeNull();
  });

  it('skips falsy briefId/textureKey entries in the provided arrays', () => {
    const entry = makeEntry({ briefId: 'brief-1', textureKey: 'brief-1-tex' });
    const registry = makeRegistry([entry]);
    const scene = makeScene(registry, new Set(['brief-1-tex']));
    const result = resolveGeneratedIconEntry(scene, {
      briefIds: ['', 'brief-1'],
      textureKeys: [''],
      seed: 1,
    });
    expect(result).toEqual(entry);
  });
});
