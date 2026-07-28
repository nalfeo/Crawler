/**
 * Tests for the static terrain-pack preload registry
 * (`src/engine/sprites/terrain-pack-visuals.ts`) — reviewed-design
 * refinement #1: every shipped terrain-pack asset is registered and
 * preloaded, with no second hand-authored list to drift from the manifests.
 */
import { describe, expect, it } from 'vitest';
import {
  collectTerrainPackPreloadEntries,
  preloadTerrainPacks,
  type TerrainPackLoaderLike,
} from '../../src/engine/sprites/terrain-pack-visuals.js';
import {
  getAllRuntimeTerrainPackIds,
  getTerrainPack,
} from '../../src/shared/terrain-pack-registry.js';

class MockLoader implements TerrainPackLoaderLike {
  readonly images: Array<{ key: string; url: string }> = [];
  readonly spritesheets: Array<{
    key: string;
    url: string;
    config: { frameWidth: number; frameHeight: number };
  }> = [];

  image(key: string, url: string): unknown {
    this.images.push({ key, url });
    return this;
  }

  spritesheet(
    key: string,
    url: string,
    config: { frameWidth: number; frameHeight: number },
  ): unknown {
    this.spritesheets.push({ key, url, config });
    return this;
  }
}

describe('collectTerrainPackPreloadEntries', () => {
  const entries = collectTerrainPackPreloadEntries();

  it('includes one wall-atlas entry PLUS one per wall-accent atlas, for every RUNTIME pack', () => {
    const wallEntries = entries.filter((e) => e.kind === 'wall-atlas');
    const expectedCount = getAllRuntimeTerrainPackIds().reduce(
      (sum, id) => sum + 1 + (getTerrainPack(id).wallAccents?.length ?? 0),
      0,
    );
    expect(wallEntries).toHaveLength(expectedCount);
  });

  it('includes one ground-decals spritesheet entry per declared decal set', () => {
    const decalEntries = entries.filter((e) => e.kind === 'ground-decals');
    const declaredSets = getAllRuntimeTerrainPackIds().flatMap((id) =>
      (getTerrainPack(id).groundDecals ?? []).map((set) => ({ id, set })),
    );
    expect(decalEntries).toHaveLength(declaredSets.length);
    for (const { id, set } of declaredSets) {
      const entry = decalEntries.find((e) => e.textureKey === set.textureKey);
      expect(entry, `${id} ground-decals entry for ${set.textureKey}`).toBeDefined();
      // Decal frames are sized by the DECAL cell, never the wall cellPx — the
      // reason this is a distinct preload kind. Sets differ in cellPx, so a
      // shared kind would make the wall-atlas frame invariant untrue twice over.
      expect(entry && 'frameWidth' in entry ? entry.frameWidth : null).toBe(set.cellPx);
      expect(entry && 'frameHeight' in entry ? entry.frameHeight : null).toBe(set.cellPx);
    }
  });

  it('does not include any caeles-fixture assets (build-only pack, not preloaded at boot)', () => {
    expect(entries.every((e) => !e.textureKey.includes('caeles-fixture'))).toBe(true);
  });

  it('includes every floorPool + corridorPool + doorSet + wallAccents asset for every RUNTIME pack', () => {
    for (const id of getAllRuntimeTerrainPackIds()) {
      const pack = getTerrainPack(id);
      const expectedKeys = [
        pack.wallAutotile.textureKey,
        ...pack.floorPool.map((v) => v.textureKey),
        ...pack.corridorPool.map((v) => v.textureKey),
        ...Object.values(pack.doorSet).map((v) => v.textureKey),
        ...(pack.wallAccents ?? []).map((a) => a.textureKey),
      ];
      const actualKeys = entries.map((e) => e.textureKey);
      for (const key of expectedKeys) {
        expect(actualKeys).toContain(key);
      }
    }
  });

  it('wall-atlas entries (base atlas + accent atlases) carry the pack cellPx as frame dimensions', () => {
    for (const entry of entries) {
      if (entry.kind !== 'wall-atlas') continue;
      const pack = getAllRuntimeTerrainPackIds()
        .map((id) => getTerrainPack(id))
        .find(
          (p) =>
            p.wallAutotile.textureKey === entry.textureKey ||
            (p.wallAccents ?? []).some((a) => a.textureKey === entry.textureKey),
        )!;
      expect(entry.frameWidth).toBe(pack.wallAutotile.cellPx);
      expect(entry.frameHeight).toBe(pack.wallAutotile.cellPx);
    }
  });

  it('has no duplicate textureKeys across packs (each key uniquely identifies its asset)', () => {
    const keys = entries.map((e) => e.textureKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('preloadTerrainPacks', () => {
  it('queues a spritesheet load for every wall-atlas entry and image loads for pool/door entries', () => {
    const loader = new MockLoader();
    const queued = preloadTerrainPacks(loader);

    const entries = collectTerrainPackPreloadEntries();
    expect(queued).toHaveLength(entries.length);

    // Every framed kind loads as a spritesheet; only unframed pool/door art
    // loads as a plain image.
    const sheetCount = entries.filter(
      (e) => e.kind === 'wall-atlas' || e.kind === 'ground-decals' || e.kind === 'linework',
    ).length;
    const otherCount = entries.length - sheetCount;
    expect(loader.spritesheets).toHaveLength(sheetCount);
    expect(loader.images).toHaveLength(otherCount);
  });

  it('resolves every queued URL under the public asset base path (no unsafe absolute paths)', () => {
    const loader = new MockLoader();
    preloadTerrainPacks(loader);
    for (const { url } of [...loader.images, ...loader.spritesheets]) {
      expect(url).toMatch(/^\/.*assets\//);
    }
  });

  it('is idempotent in queued-key identity: calling twice queues the same textureKey set', () => {
    const loaderA = new MockLoader();
    const loaderB = new MockLoader();
    const queuedA = preloadTerrainPacks(loaderA).map((e) => e.textureKey);
    const queuedB = preloadTerrainPacks(loaderB).map((e) => e.textureKey);
    expect(queuedA).toEqual(queuedB);
  });
});
