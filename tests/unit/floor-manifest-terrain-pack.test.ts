/**
 * Tests for the `terrainPackId` field on the floor manifest schema
 * (`src/shared/floor-manifest.ts`) — reviewed-design refinement #6: a
 * registry-backed enum, not a free string, so a typo'd id fails validation
 * instead of silently falling back to legacy rendering at runtime.
 */
import { describe, expect, it } from 'vitest';
import {
  floorManifestDefSchema,
  floor1Manifest,
  floor2Manifest,
} from '../../src/shared/floor-manifest.js';

/** A minimal, schema-valid floor manifest object used as a mutation base. */
function buildValidManifest(overrides: Record<string, unknown> = {}) {
  return {
    id: 'floor-test',
    name: 'Test Floor',
    protagonist: 'test-protagonist',
    starterWeapons: ['sword'],
    timer: { durationMs: 60000, stairSpawnCountdownMs: 0 },
    objectives: {
      requiredRats: 0,
      requiredSlimes: 0,
      requiredTotalKills: 0,
      requiredGold: 0,
      requiredJunk: 0,
      markerRadiusFt: 0,
    },
    map: {
      widthTiles: 10,
      heightTiles: 10,
      tileSizeFt: 4,
      seed: 1,
      roomWidthRange: [4, 8] as [number, number],
      roomHeightRange: [4, 8] as [number, number],
      maxRooms: 4,
      floorDensity: 0.5,
    },
    enemyPackId: 'test-pack',
    player: { hpBonus: 0, moveSpeedBonus: 0, pickupRangeBonus: 0 },
    camera: { zoom: 1 },
    lighting: { ambient: 0.2 },
    ...overrides,
  };
}

describe('floorManifestDefSchema — terrainPackId (refinement #6)', () => {
  it('accepts a manifest that omits terrainPackId entirely (legacy path, e.g. Floor 1)', () => {
    const result = floorManifestDefSchema.safeParse(buildValidManifest());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.terrainPackId).toBeUndefined();
    }
  });

  it('accepts a manifest with a valid registry-backed terrainPackId', () => {
    const result = floorManifestDefSchema.safeParse(
      buildValidManifest({ terrainPackId: 'industrial-cave' }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.terrainPackId).toBe('industrial-cave');
    }
  });

  it("rejects a typo'd terrainPackId instead of silently ignoring it", () => {
    const result = floorManifestDefSchema.safeParse(
      buildValidManifest({ terrainPackId: 'industrial-caves' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a terrainPackId that is not one of the two currently registered packs', () => {
    const result = floorManifestDefSchema.safeParse(
      buildValidManifest({ terrainPackId: 'some-other-pack' }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects caeles-fixture as a floor manifest terrainPackId (build-only, not a runtime pack)', () => {
    const result = floorManifestDefSchema.safeParse(
      buildValidManifest({ terrainPackId: 'caeles-fixture' }),
    );
    expect(result.success).toBe(false);
  });

  it('accepts optional per-family pack selection with legacy fallback still available', () => {
    const result = floorManifestDefSchema.safeParse(
      buildValidManifest({
        terrainPackId: 'industrial-cave',
        terrainPacks: { cave: 'industrial-cave' },
      }),
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.terrainPacks).toEqual({ cave: 'industrial-cave' });
    }
  });

  it('rejects build-only or unknown ids in per-family pack selection', () => {
    expect(
      floorManifestDefSchema.safeParse(
        buildValidManifest({ terrainPacks: { stone: 'caeles-fixture' } }),
      ).success,
    ).toBe(false);
    expect(
      floorManifestDefSchema.safeParse(
        buildValidManifest({ terrainPacks: { cave: 'industrial-caves' } }),
      ).success,
    ).toBe(false);
  });
});

describe('Floor 1 / Floor 2 manifest wiring', () => {
  it('Floor 1 manifest omits terrainPackId (stays on the legacy 16-mask + generated-single path)', () => {
    expect(floor1Manifest.terrainPackId).toBeUndefined();
  });

  it('Floor 2 manifest wires the industrial-cave terrain pack', () => {
    expect(floor2Manifest.terrainPackId).toBe('industrial-cave');
  });
});
