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
export const BUILD_ONLY_TERRAIN_PACK_IDS = ['caeles-fixture'] as const;

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

/** One floor/corridor pool variant — a standalone `TERRAIN_PACK_CELL_PX` image. */
const poolVariantSchema = z
  .object({
    id: z.string().min(1),
    imagePath: z.string().min(1),
    textureKey: z.string().min(1),
  })
  .strict();

/** 3–5 variants per pool (reviewed-design build target). */
const variantPoolSchema = z.array(poolVariantSchema).min(3).max(5);
export type PoolVariantDef = z.infer<typeof poolVariantSchema>;

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

export const terrainPackDefSchema = z
  .object({
    id: terrainPackIdSchema,
    name: z.string().min(1),
    provenance: provenanceSchema,
    wallAutotile: wallAutotileSchema,
    floorPool: variantPoolSchema,
    corridorPool: variantPoolSchema,
    doorSet: doorSetSchema,
  })
  .strict();
export type TerrainPackDef = z.infer<typeof terrainPackDefSchema>;

/** Door state × orientation — see `resolveDoorPoolVariant` in `terrain-pack-variants.ts`. */
export type DoorOrientation = 'horizontal' | 'vertical';
