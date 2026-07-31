/**
 * Tests for the terrain-pack registry (`src/shared/terrain-pack-registry.ts`)
 * — the fail-fast, statically-parsed manifest loader that both the renderer
 * and the boot-time preload registry read from.
 */
import { describe, expect, it } from 'vitest';
import { getAllTerrainPackIds, getTerrainPack } from '../../src/shared/terrain-pack-registry.js';
import { TERRAIN_PACK_IDS } from '../../src/shared/terrain-pack-types.js';
import { BLOB47_CANONICAL_MASKS } from '../../src/shared/terrain-pack-mask.js';

describe('terrain-pack-registry', () => {
  it('getAllTerrainPackIds returns exactly TERRAIN_PACK_IDS', () => {
    expect(getAllTerrainPackIds()).toEqual(TERRAIN_PACK_IDS);
  });

  it('resolves every registered pack id to a schema-valid, already-parsed def', () => {
    for (const id of getAllTerrainPackIds()) {
      const pack = getTerrainPack(id);
      expect(pack.id).toBe(id);
      expect(pack.wallAutotile.masks).toHaveLength(47);
      expect(pack.floorPool.length).toBeGreaterThanOrEqual(3);
      expect(pack.corridorPool.length).toBeGreaterThanOrEqual(3);
      // INVERTED: packs used to be required to declare all four doorSet keys.
      // Door art is now owned by the one unified renderer, so a pack carrying
      // door art is a regression, not a requirement.
      expect(pack).not.toHaveProperty('doorSet');
    }
  });

  it("industrial-cave pack has 'authored' provenance", () => {
    expect(getTerrainPack('industrial-cave').provenance.kind).toBe('authored');
  });

  it("caeles-fixture pack has 'vendored' provenance with the verified fixture SHA-256", () => {
    const pack = getTerrainPack('caeles-fixture');
    expect(pack.provenance.kind).toBe('vendored');
    if (pack.provenance.kind === 'vendored') {
      expect(pack.provenance.sha256).toBe(
        '34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76',
      );
      expect(pack.provenance.license).toBe('CC0');
      expect(pack.provenance.sourceUrl).toBe(
        'https://opengameart.org/content/seamless-tileset-template-ii',
      );
    }
  });

  it('every registered pack maps every canonical blob47 mask to a distinct frame', () => {
    for (const id of getAllTerrainPackIds()) {
      const pack = getTerrainPack(id);
      const maskIds = pack.wallAutotile.masks.map((m) => m.maskId).sort((a, b) => a - b);
      expect(maskIds).toEqual([...BLOB47_CANONICAL_MASKS]);
      const frameIndices = new Set(pack.wallAutotile.masks.map((m) => m.frameIndex));
      expect(frameIndices.size).toBe(47);
    }
  });

  it('every registered pack uses the 64px terrain-pack cell size', () => {
    for (const id of getAllTerrainPackIds()) {
      expect(getTerrainPack(id).wallAutotile.cellPx).toBe(64);
    }
  });
});
