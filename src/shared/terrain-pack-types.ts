/**
 * Terrain-pack schema — strict Zod contract for a "terrain pack": a per-surface
 * bundle of wall autotile atlas + floor/corridor variant pools + door art, with
 * immutable provenance.
 *
 * Registry-backed IDs: `TERRAIN_PACK_IDS` is the single source of truth for
 * valid `terrainPackId` values. Both the floor-manifest schema
 * (`floor-manifest.ts`) and every terrain-pack manifest validate against the
 * SAME `terrainPackIdSchema`, so a typo'd pack id fails Zod validation instead
 * of silently falling back at runtime (reviewed-design refinement #6).
 *
 * Per-surface contract (refinement #2): a pack does NOT have one coarse
 * "topology" mode — it separately declares `wallAutotile` (the 47-mask blob
 * atlas), `floorPool` (open-floor variants), `corridorPool` (corridor-floor
 * variants), and `doorSet` (open/closed × horizontal/vertical, refinement #5).
 */
import { z } from 'zod';
import { BLOB47_CANONICAL_MASKS, isCanonicalBlob47Mask } from './terrain-pack-mask.js';

/**
 * Runtime packs — preloadable at boot, valid in floor manifests.
 * Every id listed here MUST be registered in `terrain-pack-registry.ts`.
 */
export const RUNTIME_TERRAIN_PACK_IDS = ['industrial-cave'] as const;
export const runtimeTerrainPackIdSchema = z.enum(RUNTIME_TERRAIN_PACK_IDS);
export type RuntimeTerrainPackId = z.infer<typeof runtimeTerrainPackIdSchema>;

/**
 * Build-only / fixture packs — used only by tooling and tests.
 * MUST NOT appear in floor manifests and MUST NOT be preloaded at boot.
 */
const BUILD_ONLY_TERRAIN_PACK_IDS = ['caeles-fixture'] as const;

/**
 * Union of all registered pack IDs (runtime + build-only). Used only by the
 * pack registry and build tooling — callers that need only preloadable or
 * floor-manifest-valid IDs should use `RUNTIME_TERRAIN_PACK_IDS` /
 * `runtimeTerrainPackIdSchema`.
 */
export const TERRAIN_PACK_IDS = [
  ...RUNTIME_TERRAIN_PACK_IDS,
  ...BUILD_ONLY_TERRAIN_PACK_IDS,
] as const;

export const terrainPackIdSchema = z.enum(TERRAIN_PACK_IDS);
export type TerrainPackId = z.infer<typeof terrainPackIdSchema>;

/** Output cell size (px) every pack's wall atlas + pool/door images must use. */
export const TERRAIN_PACK_CELL_PX = 64;

/**
 * Immutable fixture provenance (refinement #7). `kind: 'vendored'` requires
 * every external-source field (source URL, license, hash); `kind: 'authored'`
 * is for original, project-authored art and only needs an author + note.
 */
export const provenanceSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('authored'),
      /** Human/agent credit for the original artwork. */
      author: z.string().min(1),
      /** Explanation of how the art was produced (e.g. deterministic script). */
      derivationNote: z.string().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal('vendored'),
      /** Filename exactly as published at the source. */
      originalFilename: z.string().min(1),
      /** Page the asset was found on (not necessarily the direct file URL). */
      sourceUrl: z.string().url(),
      /** Direct download URL for the vendored file. */
      fileUrl: z.string().url(),
      title: z.string().min(1),
      author: z.string().min(1),
      /** Must be an explicit CC0 declaration — this pipeline only vendors CC0. */
      license: z.literal('CC0'),
      licenseUrl: z.string().url(),
      /** SHA-256 of the vendored file's bytes, lowercase hex, verified at fetch time. */
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      /** How the vendored source was transformed into pack output (sliced, scaled, recolored...). */
      derivationNote: z.string().min(1),
    })
    .strict(),
]);
export type TerrainPackProvenance = z.infer<typeof provenanceSchema>;

/** One entry in the 47-mask wall autotile table: explicit maskId → frameIndex. */
const wallMaskEntrySchema = z
  .object({
    /** Canonical (already blob47-gated) mask value, 0–255. */
    maskId: z.number().int().min(0).max(255),
    /** Frame index into the wall atlas spritesheet (row-major grid). */
    frameIndex: z.number().int().min(0),
  })
  .strict();

const wallAutotileSchema = z
  .object({
    /** Path under `public/`, forward-slashed, to the assembled atlas PNG. */
    imagePath: z.string().min(1),
    /** Phaser texture key the atlas is registered under. */
    textureKey: z.string().min(1),
    /** Output cell size in px — MUST be `TERRAIN_PACK_CELL_PX` (64). */
    cellPx: z.literal(TERRAIN_PACK_CELL_PX),
    /** Atlas grid columns (frameIndex % gridCols). */
    gridCols: z.number().int().positive(),
    /** Atlas grid rows. */
    gridRows: z.number().int().positive(),
    /** Explicit mask→frame table — exactly 47 entries, validated below. */
    masks: z.array(wallMaskEntrySchema).length(47),
  })
  .strict()
  .superRefine((val, ctx) => {
    const seenMaskIds = new Set<number>();
    const seenFrameIndices = new Set<number>();
    for (const entry of val.masks) {
      if (seenMaskIds.has(entry.maskId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate maskId ${entry.maskId} in wallAutotile.masks`,
        });
      }
      seenMaskIds.add(entry.maskId);
      if (seenFrameIndices.has(entry.frameIndex)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate frameIndex ${entry.frameIndex} in wallAutotile.masks`,
        });
      }
      seenFrameIndices.add(entry.frameIndex);
      if (!isCanonicalBlob47Mask(entry.maskId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `maskId ${entry.maskId} is not a canonical blob47 mask`,
        });
      }
      const maxFrame = val.gridCols * val.gridRows - 1;
      if (entry.frameIndex > maxFrame) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `frameIndex ${entry.frameIndex} exceeds grid capacity (${val.gridCols}x${val.gridRows})`,
        });
      }
    }
    for (const canonical of BLOB47_CANONICAL_MASKS) {
      if (!seenMaskIds.has(canonical)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Missing canonical maskId ${canonical} in wallAutotile.masks`,
        });
      }
    }
  });
export type WallAutotileDef = z.infer<typeof wallAutotileSchema>;

/**
 * Deterministic geometric transforms a floor/corridor pool variant's texture
 * MAY be stamped with (2026-07-25 terrain-variance refinement #2/#5). Applied
 * at RUNTIME via Phaser `RenderTexture.stamp()` center-origin + signed scale
 * (never pre-baked, never an implicit resize) — see
 * `terrain-pack-variants.ts`'s `buildPoolStampConfig`.
 *
 * Fixed enumeration ORDER matters: `buildWeightedCombos` walks a variant's
 * `allowedTransforms` in this exact order (not array declaration order, not
 * `Array.sort()`) so the weighted combo table — and therefore every tile's
 * deterministic pick — is stable across manifest edits that only reorder a
 * variant's declared transforms.
 */
export const TRANSFORM_IDS = ['none', 'flipH', 'flipV', 'flipHV'] as const;
export const transformIdSchema = z.enum(TRANSFORM_IDS);
export type TransformId = (typeof TRANSFORM_IDS)[number];

/** One floor/corridor pool variant — a standalone `TERRAIN_PACK_CELL_PX` image. */
const poolVariantSchema = z
  .object({
    id: z.string().min(1),
    imagePath: z.string().min(1),
    textureKey: z.string().min(1),
    /**
     * Optional transform-eligibility metadata (refinement #2): which of the
     * deterministic transforms this source's art tolerates without breaking
     * seam/edge closure or implying a false direction (e.g. gravity-fed
     * stains, directional grates). ALWAYS includes `'none'` (the identity
     * transform is always safe). Build tooling derives this list by
     * rendering every candidate transform and validating edge-closure before
     * writing it — see `scripts/sprites/terrain-packs/transform-eligibility.ts`.
     *
     * Omission preserves the legacy identity-only behavior for packs authored
     * before runtime transforms were introduced.
     */
    allowedTransforms: z.array(transformIdSchema).min(1).optional(),

    /**
     * Relative selection weight (2026-07-25 shared-base redesign). Pool draws
     * are weighted, not uniform: a pack declares ONE dominant plain base
     * (large weight) and several sparse detail variants (small weights), so
     * ground reads as continuous ground with occasional features rather than
     * a patchwork of equally-likely textures.
     *
     * Omission defaults to 1, which reproduces the legacy uniform draw exactly
     * when no variant in the pool declares a weight.
     */
    weight: z.number().positive().finite().optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.allowedTransforms && !val.allowedTransforms.includes('none')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${val.id}: allowedTransforms must include 'none' (the identity transform is always safe)`,
      });
    }
    const seen = new Set<TransformId>();
    for (const t of val.allowedTransforms ?? []) {
      if (seen.has(t)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${val.id}: duplicate transform '${t}' in allowedTransforms`,
        });
      }
      seen.add(t);
    }
  });

/**
 * 3–12 variants per pool. Widened from the original 3–5 build target (see
 * `git log` on this file) to accommodate the 8-source floor/corridor
 * contract adopted 2026-07-25 (terrain-variance reviewed design) while
 * leaving headroom above 8 for future growth without another schema bump.
 */
const variantPoolSchema = z.array(poolVariantSchema).min(3).max(12);
export type PoolVariantDef = z.infer<typeof poolVariantSchema>;

/** Target floor/corridor pool size adopted 2026-07-25 (grown from 4). */
export const TERRAIN_PACK_POOL_TARGET_SIZE = 8;

/**
 * One wall-accent overlay atlas (refinement #3): a MASK-AWARE, transparent
 * 8×6 (same grid as `wallAutotile`) atlas sharing the wall atlas's
 * maskId→frameIndex table — frame N of an accent atlas overlays frame N of
 * `wallAutotile` for the SAME canonical mask, so the accent motif is
 * guaranteed to respect that mask's wall silhouette (never spills onto
 * floor). Packs may omit accents; packs that opt in ship exactly
 * `WALL_ACCENT_COUNT` (4) atlases.
 */
const wallAccentSchema = z
  .object({
    id: z.string().min(1),
    imagePath: z.string().min(1),
    textureKey: z.string().min(1),
  })
  .strict();
export type WallAccentDef = z.infer<typeof wallAccentSchema>;

/** Number of wall-accent overlay atlases for packs that opt in. */
export const WALL_ACCENT_COUNT = 4;

/** One door texture (a single open/closed × horizontal/vertical combination). */
const doorVariantSchema = z
  .object({
    imagePath: z.string().min(1),
    textureKey: z.string().min(1),
  })
  .strict();

/**
 * Door contract: EXACTLY open/closed × horizontal/vertical (refinement #5).
 * Locked-door art is explicitly out of scope — no `locked` variants here.
 */
const doorSetSchema = z
  .object({
    openHorizontal: doorVariantSchema,
    openVertical: doorVariantSchema,
    closedHorizontal: doorVariantSchema,
    closedVertical: doorVariantSchema,
  })
  .strict();
export type DoorSetDef = z.infer<typeof doorSetSchema>;

/**
 * Optional floor pools for rooms whose role — not terrain family — should look
 * distinct. Walls, corridors, and doors remain owned by the surrounding pack.
 */
const specialFloorPoolsSchema = z
  .object({
    welcome: variantPoolSchema.optional(),
    safe: variantPoolSchema.optional(),
    bossStair: variantPoolSchema.optional(),
  })
  .strict();
export type SpecialFloorPoolsDef = z.infer<typeof specialFloorPoolsSchema>;

/**
 * Optional cross-tile ground decal atlas. Every floor/corridor pool tile has its
 * BORDER byte-restored from the shared base so neighbours tile seamlessly — which
 * also means no feature in a pool tile can ever cross a tile edge. Long cracks
 * therefore cannot be expressed by the pool at all; they need a motif that is
 * larger than one cell and is positioned independently of the tile grid.
 *
 * Decals are stamped into the SAME terrain RenderTexture after the per-tile pass,
 * spanning `spanTiles`×`spanTiles` cells. The renderer **clips** rather than
 * rejects: it stamps any decal whose center tile is eligible ground, then
 * overpaints the surrounding wall tiles so the decal fades into geometry.
 * Decals whose rotated AABB is only partially covered by eligible ground are
 * therefore accepted and their out-of-bounds pixels are covered by the wall
 * overpaint pass — the whole footprint is NOT required to be eligible ground.
 * Being an overlay they never modify a pool tile's border, so the seamlessness
 * contract is untouched.
 */
const groundDecalSetSchema = z
  .object({
    imagePath: z.string().min(1),
    textureKey: z.string().min(1),
    /** Source pixel size of one square decal frame. */
    cellPx: z.number().int().positive(),
    /** How many tiles wide/tall one decal covers when stamped. */
    spanTiles: z.number().int().min(2),
    /** Number of horizontally-packed frames in the atlas. */
    frames: z.number().int().positive(),
    /**
     * Tile pitch of this set's anchor lattice. Each set carries its own stride
     * so a small set can fill the gaps a large set leaves; a single shared
     * stride produces visible bands of untouched ground where the lattice
     * misses line up across the map.
     */
    strideTiles: z.number().int().min(1),
    /** Fraction of this set's anchors that receive a stamp. */
    density: z.number().min(0).max(1),
  })
  .strict();
export type GroundDecalSetDef = z.infer<typeof groundDecalSetSchema>;

export const terrainPackDefSchema = z
  .object({
    id: terrainPackIdSchema,
    name: z.string().min(1),
    provenance: provenanceSchema,
    wallAutotile: wallAutotileSchema,
    floorPool: variantPoolSchema,
    corridorPool: variantPoolSchema,
    doorSet: doorSetSchema,
    /** Optional set of exactly `WALL_ACCENT_COUNT` mask-aware accent atlases. */
    wallAccents: z.array(wallAccentSchema).length(WALL_ACCENT_COUNT).optional(),
    specialFloorPools: specialFloorPoolsSchema.optional(),
    groundDecals: z.array(groundDecalSetSchema).min(1).optional(),
  })
  .strict();
export type TerrainPackDef = z.infer<typeof terrainPackDefSchema>;

/** Door state × orientation — see `resolveDoorPoolVariant` in `terrain-pack-variants.ts`. */
export type DoorOrientation = 'horizontal' | 'vertical';
