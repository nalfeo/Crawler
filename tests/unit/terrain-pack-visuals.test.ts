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

  it('includes exactly one wall-atlas entry per RUNTIME pack (caeles-fixture is build-only)', () => {
    const wallEntries = entries.filter((e) => e.kind === 'wall-atlas');
    expect(wallEntries).toHaveLength(getAllRuntimeTerrainPackIds().length);
  });

  it('does not include any caeles-fixture assets (build-only pack, not preloaded at boot)', () => {
    expect(entries.every((e) => !e.textureKey.includes('caeles-fixture'))).toBe(true);
  });

  it('includes every floorPool + corridorPool + doorSet asset for every RUNTIME pack', () => {
    for (const id of getAllRuntimeTerrainPackIds()) {
      const pack = getTerrainPack(id);
      const expectedKeys = [
        pack.wallAutotile.textureKey,
        ...pack.floorPool.map((v) => v.textureKey),
        ...pack.corridorPool.map((v) => v.textureKey),
        ...Object.values(pack.doorSet).map((v) => v.textureKey),
      ];
      const actualKeys = entries.map((e) => e.textureKey);
      for (const key of expectedKeys) {
        expect(actualKeys).toContain(key);
      }
    }
  });

  it('wall-atlas entries carry the pack cellPx as frame dimensions', () => {
    for (const entry of entries) {
      if (entry.kind !== 'wall-atlas') continue;
      const pack = getAllRuntimeTerrainPackIds()
        .map((id) => getTerrainPack(id))
        .find((p) => p.wallAutotile.textureKey === entry.textureKey)!;
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

    const wallCount = entries.filter((e) => e.kind === 'wall-atlas').length;
    const otherCount = entries.length - wallCount;
    expect(loader.spritesheets).toHaveLength(wallCount);
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
