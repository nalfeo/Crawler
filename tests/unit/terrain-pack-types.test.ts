/**
 * Strict Zod schema tests for `src/shared/terrain-pack-types.ts` — the
 * registry-backed terrain-pack contract (reviewed-design refinements #2, #6, #7).
 *
 * Covers: registry-backed id enum (typo fails), per-surface contract shape
 * (wallAutotile/floorPool/corridorPool/doorSet as separate required fields,
 * not one coarse mode), explicit 47-entry mask table validation (missing,
 * duplicate maskId, duplicate frameIndex, non-canonical maskId, frame
 * capacity overflow), door set exactly open/closed x horizontal/vertical
 * (no locked variant), and both provenance kinds (authored vs vendored, with
 * vendored requiring the full immutable-provenance field set).
 */
import { describe, expect, it } from 'vitest';
import {
  TERRAIN_PACK_CELL_PX,
  TERRAIN_PACK_IDS,
  RUNTIME_TERRAIN_PACK_IDS,
  WALL_ACCENT_COUNT,
  provenanceSchema,
  terrainPackDefSchema,
  terrainPackIdSchema,
  runtimeTerrainPackIdSchema,
  transformIdSchema,
} from '../../src/shared/terrain-pack-types.js';
import { BLOB47_CANONICAL_MASKS } from '../../src/shared/terrain-pack-mask.js';

/** A minimal, schema-valid terrain pack def used as a base for mutation tests. */
function buildValidPackDef(overrides: Partial<Record<string, unknown>> = {}) {
  const masks = BLOB47_CANONICAL_MASKS.map((maskId, frameIndex) => ({ maskId, frameIndex }));
  const doorVariant = (name: string) => ({
    imagePath: `assets/terrain-packs/test/${name}.png`,
    textureKey: `terrain-pack-test-${name}`,
  });
  const poolVariant = (name: string) => ({
    id: name,
    imagePath: `assets/terrain-packs/test/${name}.png`,
    textureKey: `terrain-pack-test-${name}`,
    allowedTransforms: ['none', 'flipH', 'flipV', 'flipHV'],
  });
  const accentVariant = (name: string) => ({
    id: name,
    imagePath: `assets/terrain-packs/test/${name}.png`,
    textureKey: `terrain-pack-test-${name}`,
  });
  return {
    id: 'industrial-cave',
    name: 'Test Pack',
    provenance: {
      kind: 'authored' as const,
      author: 'test',
      derivationNote: 'deterministic test fixture',
    },
    wallAutotile: {
      imagePath: 'assets/terrain-packs/test/wall-atlas.png',
      textureKey: 'terrain-pack-test-walls',
      cellPx: TERRAIN_PACK_CELL_PX,
      gridCols: 8,
      gridRows: 6,
      masks,
    },
    floorPool: [poolVariant('floor-0'), poolVariant('floor-1'), poolVariant('floor-2')],
    corridorPool: [poolVariant('corridor-0'), poolVariant('corridor-1'), poolVariant('corridor-2')],
    doorSet: {
      openHorizontal: doorVariant('door-open-horizontal'),
      openVertical: doorVariant('door-open-vertical'),
      closedHorizontal: doorVariant('door-closed-horizontal'),
      closedVertical: doorVariant('door-closed-vertical'),
    },
    wallAccents: [
      accentVariant('accent-crack'),
      accentVariant('accent-mineral-vein'),
      accentVariant('accent-rust-brace'),
      accentVariant('accent-damp-stain'),
    ],
    ...overrides,
  };
}

describe('terrainPackIdSchema — registry-backed enum (refinement #6)', () => {
  it('accepts every id in TERRAIN_PACK_IDS', () => {
    for (const id of TERRAIN_PACK_IDS) {
      expect(terrainPackIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it("rejects a typo'd pack id instead of silently falling back", () => {
    const result = terrainPackIdSchema.safeParse('industrial-caves');
    expect(result.success).toBe(false);
  });

  it('rejects an empty string and a non-string value', () => {
    expect(terrainPackIdSchema.safeParse('').success).toBe(false);
    expect(terrainPackIdSchema.safeParse(123).success).toBe(false);
  });
});

describe('runtimeTerrainPackIdSchema — runtime-only subset (Fix 5)', () => {
  it('accepts every id in RUNTIME_TERRAIN_PACK_IDS', () => {
    for (const id of RUNTIME_TERRAIN_PACK_IDS) {
      expect(runtimeTerrainPackIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it('accepts industrial-cave (a registered runtime pack)', () => {
    expect(runtimeTerrainPackIdSchema.safeParse('industrial-cave').success).toBe(true);
  });

  it('rejects caeles-fixture (build-only — must not appear in floor manifests or boot preloads)', () => {
    expect(runtimeTerrainPackIdSchema.safeParse('caeles-fixture').success).toBe(false);
  });

  it("rejects a typo'd id", () => {
    expect(runtimeTerrainPackIdSchema.safeParse('industrial-caves').success).toBe(false);
  });

  it('rejects an empty string and a non-string value', () => {
    expect(runtimeTerrainPackIdSchema.safeParse('').success).toBe(false);
    expect(runtimeTerrainPackIdSchema.safeParse(null).success).toBe(false);
  });
});

describe('terrainPackDefSchema — per-surface contract (refinement #2)', () => {
  it('accepts a well-formed pack def with all four surfaces present', () => {
    const result = terrainPackDefSchema.safeParse(buildValidPackDef());
    expect(result.success).toBe(true);
  });

  it('rejects a def missing the wallAutotile surface entirely', () => {
    const def = buildValidPackDef();
    const { wallAutotile: _drop, ...rest } = def;
    expect(terrainPackDefSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a def missing the doorSet surface entirely', () => {
    const def = buildValidPackDef();
    const { doorSet: _drop, ...rest } = def;
    expect(terrainPackDefSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects unknown extra top-level fields (strict schema, no coarse "topology" field)', () => {
    const def = { ...buildValidPackDef(), topology: 'blob47' };
    expect(terrainPackDefSchema.safeParse(def).success).toBe(false);
  });

  it('rejects an invalid (typo) terrainPackId on the pack def itself', () => {
    const def = buildValidPackDef({ id: 'industrial-caves' });
    expect(terrainPackDefSchema.safeParse(def).success).toBe(false);
  });
});

describe('terrainPackDefSchema — wallAutotile 47-mask table validation', () => {
  it('rejects a table with fewer than 47 entries (missing mask)', () => {
    const def = buildValidPackDef();
    const wallAutotile = {
      ...def.wallAutotile,
      masks: def.wallAutotile.masks.slice(0, 46),
    };
    const result = terrainPackDefSchema.safeParse({ ...def, wallAutotile });
    expect(result.success).toBe(false);
  });

  it('rejects a table with a duplicate maskId (even at exactly 47 entries)', () => {
    const def = buildValidPackDef();
    const masks = def.wallAutotile.masks.slice(0, 46);
    // Duplicate the first mask's maskId instead of the true 47th, so the
    // array length stays 47 but one canonical mask is missing + one is doubled.
    masks.push({ maskId: masks[0]!.maskId, frameIndex: 46 });
    const result = terrainPackDefSchema.safeParse({
      ...def,
      wallAutotile: { ...def.wallAutotile, masks },
    });
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message.includes('Duplicate maskId'))).toBe(true);
    expect(issues.some((i) => i.message.includes('Missing canonical maskId'))).toBe(true);
  });

  it('rejects a table with a duplicate frameIndex', () => {
    const def = buildValidPackDef();
    const masks = def.wallAutotile.masks.map((m, i) => (i === 46 ? { ...m, frameIndex: 0 } : m));
    const result = terrainPackDefSchema.safeParse({
      ...def,
      wallAutotile: { ...def.wallAutotile, masks },
    });
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message.includes('Duplicate frameIndex'))).toBe(true);
  });

  it('rejects a maskId that is not one of the 47 canonical blob47 masks', () => {
    const def = buildValidPackDef();
    // 128 (lone NW) never survives blob47 gating, so it is not canonical.
    const masks = def.wallAutotile.masks.map((m, i) => (i === 0 ? { ...m, maskId: 128 } : m));
    const result = terrainPackDefSchema.safeParse({
      ...def,
      wallAutotile: { ...def.wallAutotile, masks },
    });
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message.includes('not a canonical blob47 mask'))).toBe(true);
  });

  it('rejects a frameIndex that exceeds the grid capacity', () => {
    const def = buildValidPackDef();
    const masks = def.wallAutotile.masks.map((m, i) => (i === 0 ? { ...m, frameIndex: 999 } : m));
    const result = terrainPackDefSchema.safeParse({
      ...def,
      wallAutotile: { ...def.wallAutotile, masks },
    });
    expect(result.success).toBe(false);
    const issues = !result.success ? result.error.issues : [];
    expect(issues.some((i) => i.message.includes('exceeds grid capacity'))).toBe(true);
  });

  it('rejects a cellPx other than TERRAIN_PACK_CELL_PX (64)', () => {
    const def = buildValidPackDef();
    const wallAutotile = { ...def.wallAutotile, cellPx: 32 };
    expect(terrainPackDefSchema.safeParse({ ...def, wallAutotile }).success).toBe(false);
  });
});

describe('terrainPackDefSchema — floor/corridor pool size bounds (widened 2026-07-25)', () => {
  it('rejects a pool with fewer than 3 variants', () => {
    const def = buildValidPackDef();
    const floorPool = def.floorPool.slice(0, 2);
    expect(terrainPackDefSchema.safeParse({ ...def, floorPool }).success).toBe(false);
  });

  it('rejects a pool with more than 12 variants', () => {
    const def = buildValidPackDef();
    const extra = {
      id: 'floor-extra',
      imagePath: 'x.png',
      textureKey: 'x',
      allowedTransforms: ['none'],
    };
    const floorPool = [...def.floorPool, ...Array.from({ length: 10 }, () => extra)];
    expect(terrainPackDefSchema.safeParse({ ...def, floorPool }).success).toBe(false);
  });

  it('accepts pools at the 3, 8 (target), and 12 variant boundaries', () => {
    const def = buildValidPackDef();
    const makeN = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `floor-${i}`,
        imagePath: `f${i}.png`,
        textureKey: `f${i}`,
        allowedTransforms: ['none'],
      }));
    expect(
      terrainPackDefSchema.safeParse({ ...def, floorPool: def.floorPool.slice(0, 3) }).success,
    ).toBe(true);
    expect(terrainPackDefSchema.safeParse({ ...def, floorPool: makeN(8) }).success).toBe(true);
    expect(terrainPackDefSchema.safeParse({ ...def, floorPool: makeN(12) }).success).toBe(true);
  });
});

describe('terrainPackDefSchema — poolVariant.allowedTransforms (2026-07-25 refinement #2)', () => {
  it('accepts omitted transform metadata as an identity-only legacy variant', () => {
    const def = buildValidPackDef();
    const floorPool = def.floorPool.map(({ allowedTransforms: _drop, ...variant }) => variant);
    expect(terrainPackDefSchema.safeParse({ ...def, floorPool }).success).toBe(true);
  });

  it('rejects a variant whose allowedTransforms omits "none"', () => {
    const def = buildValidPackDef();
    const floorPool = [
      { ...def.floorPool[0]!, allowedTransforms: ['flipH'] },
      ...def.floorPool.slice(1),
    ];
    const result = terrainPackDefSchema.safeParse({ ...def, floorPool });
    expect(result.success).toBe(false);
  });

  it('rejects a variant with a duplicate transform entry', () => {
    const def = buildValidPackDef();
    const floorPool = [
      { ...def.floorPool[0]!, allowedTransforms: ['none', 'flipH', 'flipH'] },
      ...def.floorPool.slice(1),
    ];
    const result = terrainPackDefSchema.safeParse({ ...def, floorPool });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized transform id', () => {
    const def = buildValidPackDef();
    const floorPool = [
      { ...def.floorPool[0]!, allowedTransforms: ['none', 'rotate90'] },
      ...def.floorPool.slice(1),
    ];
    const result = terrainPackDefSchema.safeParse({ ...def, floorPool });
    expect(result.success).toBe(false);
  });

  it('accepts a variant that only allows "none" (fully directional/unsafe art)', () => {
    const def = buildValidPackDef();
    const floorPool = [
      { ...def.floorPool[0]!, allowedTransforms: ['none'] },
      ...def.floorPool.slice(1),
    ];
    expect(terrainPackDefSchema.safeParse({ ...def, floorPool }).success).toBe(true);
  });

  it('transformIdSchema accepts exactly the 4 defined transforms', () => {
    for (const t of ['none', 'flipH', 'flipV', 'flipHV']) {
      expect(transformIdSchema.safeParse(t).success).toBe(true);
    }
    expect(transformIdSchema.safeParse('rotate90').success).toBe(false);
  });
});

describe('terrainPackDefSchema — wallAccents (2026-07-25 refinement #3)', () => {
  it(`requires exactly WALL_ACCENT_COUNT (${WALL_ACCENT_COUNT}) accent atlases`, () => {
    const def = buildValidPackDef();
    expect(
      terrainPackDefSchema.safeParse({ ...def, wallAccents: def.wallAccents.slice(0, 3) }).success,
    ).toBe(false);
    expect(
      terrainPackDefSchema.safeParse({
        ...def,
        wallAccents: [...def.wallAccents, def.wallAccents[0]],
      }).success,
    ).toBe(false);
  });

  it('accepts a def missing optional wallAccents', () => {
    const def = buildValidPackDef();
    const { wallAccents: _drop, ...rest } = def;
    expect(terrainPackDefSchema.safeParse(rest).success).toBe(true);
  });

  it('rejects a wallAccents entry with unknown extra fields (strict schema)', () => {
    const def = buildValidPackDef();
    const wallAccents = [{ ...def.wallAccents[0]!, gridCols: 8 }, ...def.wallAccents.slice(1)];
    expect(terrainPackDefSchema.safeParse({ ...def, wallAccents }).success).toBe(false);
  });
});

describe('terrainPackDefSchema — doorSet is exactly open/closed x horizontal/vertical', () => {
  it('rejects a doorSet with a "locked" variant added (explicitly out of scope)', () => {
    const def = buildValidPackDef();
    const doorSet = {
      ...def.doorSet,
      lockedHorizontal: { imagePath: 'locked.png', textureKey: 'locked' },
    };
    expect(terrainPackDefSchema.safeParse({ ...def, doorSet }).success).toBe(false);
  });

  it('rejects a doorSet missing one of the four required combinations', () => {
    const def = buildValidPackDef();
    const { closedVertical: _drop, ...doorSet } = def.doorSet;
    expect(terrainPackDefSchema.safeParse({ ...def, doorSet }).success).toBe(false);
  });
});

describe('provenanceSchema — immutable fixture provenance (refinement #7)', () => {
  it('accepts a minimal "authored" provenance (author + derivationNote only)', () => {
    const result = provenanceSchema.safeParse({
      kind: 'authored',
      author: 'agent',
      derivationNote: 'deterministic script',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a fully-populated "vendored" provenance', () => {
    const result = provenanceSchema.safeParse({
      kind: 'vendored',
      originalFilename: 'template8x6.png',
      sourceUrl: 'https://opengameart.org/content/seamless-tileset-template-ii',
      fileUrl: 'https://opengameart.org/sites/default/files/template8x6.png',
      title: 'Seamless Tileset Template II',
      author: 'caeles',
      license: 'CC0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      sha256: '34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76',
      derivationNote: 'sliced + upscaled',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a vendored provenance missing sha256', () => {
    const { sha256: _drop, ...rest } = {
      kind: 'vendored' as const,
      originalFilename: 'template8x6.png',
      sourceUrl: 'https://opengameart.org/content/seamless-tileset-template-ii',
      fileUrl: 'https://opengameart.org/sites/default/files/template8x6.png',
      title: 'Seamless Tileset Template II',
      author: 'caeles',
      license: 'CC0' as const,
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      sha256: '34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76',
      derivationNote: 'sliced + upscaled',
    };
    expect(provenanceSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects a vendored provenance with a malformed sha256 (wrong length/charset)', () => {
    const result = provenanceSchema.safeParse({
      kind: 'vendored',
      originalFilename: 'template8x6.png',
      sourceUrl: 'https://opengameart.org/content/seamless-tileset-template-ii',
      fileUrl: 'https://opengameart.org/sites/default/files/template8x6.png',
      title: 'Seamless Tileset Template II',
      author: 'caeles',
      license: 'CC0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      sha256: 'not-a-real-hash',
      derivationNote: 'sliced + upscaled',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a vendored provenance whose license is not the literal "CC0"', () => {
    const result = provenanceSchema.safeParse({
      kind: 'vendored',
      originalFilename: 'template8x6.png',
      sourceUrl: 'https://opengameart.org/content/seamless-tileset-template-ii',
      fileUrl: 'https://opengameart.org/sites/default/files/template8x6.png',
      title: 'Seamless Tileset Template II',
      author: 'caeles',
      license: 'CC-BY-4.0',
      licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      sha256: '34f07db7bb4872406f35507c515e2fca78bbabbf5a112a20c995bcf554992d76',
      derivationNote: 'sliced + upscaled',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unrecognized provenance "kind"', () => {
    const result = provenanceSchema.safeParse({ kind: 'scraped', author: 'x' });
    expect(result.success).toBe(false);
  });
});
