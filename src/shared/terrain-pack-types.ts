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
import {
  BLOB47_CANONICAL_MASKS,
  EDGE_WANG_FRAME_COUNT,
  isCanonicalBlob47Mask,
} from './terrain-pack-mask.js';

/**
 * Runtime packs — preloadable at boot, valid in floor manifests.
 * Every id listed here MUST be registered in `terrain-pack-registry.ts`.
 */
export const RUNTIME_TERRAIN_PACK_IDS = [
  'industrial-cave',
  'floor1-dungeon',
  'floor1-cave',
] as const;
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
 * spanning `spanTiles`×`spanTiles` cells. Placement passes TWO gates: the decal's
 * center tile must be eligible ground, AND at least `DECAL_MIN_GROUND_FRACTION`
 * (0.35) of its rotated AABB must be eligible. A decal that clears both is
 * **clipped, not contained** — the surrounding wall tiles are overpainted on top,
 * so it fades into geometry and the whole footprint is NOT required to be ground.
 * A decal that fails either gate is rejected outright rather than clipped: the
 * fraction gate is what stops a large set from firing into a one-tile corridor
 * where nearly all of it would be clipped away and the slivers would read as
 * noise instead of a crack. Tuning `spanTiles` or `density` upward therefore has
 * a floor — large sets simply will not appear in narrow spaces.
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

/**
 * Optional prop overlay stamped ON TOP of a linework layer (switch levers,
 * parked mine carts). Frames are square and tile-sized; placement is restricted
 * to tiles whose edge-Wang mask gives the prop a direction to align with — see
 * `lineworkRunAxis` in `terrain-linework.ts`.
 */
const lineworkPropSetSchema = z
  .object({
    imagePath: z.string().min(1),
    textureKey: z.string().min(1),
    /** Source pixel size of one square prop frame. */
    cellPx: z.number().int().positive(),
    /**
     * First frame this layer may draw from. The prop sheet is shared, so a
     * layer selects the SEMANTIC subrange that belongs to it — a track layer
     * must never roll the pipe valve, and a pipe layer must never roll a cart.
     */
    frameStart: z.number().int().min(0).default(0),
    /** Number of consecutive frames from `frameStart` this layer may draw. */
    frames: z.number().int().positive(),
    /**
     * Turn the prop a quarter turn on an east-west run. Props are NOT Wang
     * tiles — they carry no edge signature — so rotating them is safe, and a
     * cart or lever that ignores the run axis sits across the rails.
     */
    orientToRun: z.boolean().default(false),
    /** Fraction of eligible linework tiles that receive a prop. */
    density: z.number().min(0).max(1),
  })
  .strict();
export type LineworkPropSetDef = z.infer<typeof lineworkPropSetSchema>;

/**
 * One INDUSTRIAL LINEWORK layer — a 2-edge Wang ("path") tileset routed over
 * the floor's walkable topology.
 *
 * This is the edge-matching counterpart of `wallAutotile`'s corner-matching
 * blob47 set. cr31's Wang-tile survey puts it plainly: corner-matching sets
 * produce terrain patches, edge-matching sets produce paths and mazes — and its
 * canonical worked example of a 2-edge set is a PIPE tileset. A complete 2-edge
 * set is 2^4 = 16 tiles, and the mask IS the frame index, so unlike
 * `wallAutotile` this needs no `masks` table.
 *
 * The atlas must satisfy the STUB CONTRACT (`stubOffsetPx` / `stubWidthPx`):
 * every frame that declares a connection on some edge presents exactly the same
 * opaque span on that edge, and nothing else on it. Two neighbouring tiles whose
 * masks agree therefore meet with no gap and no overlap, by construction. This
 * is what makes a run read as continuous rather than as a dashed line, and it is
 * checked pixel-for-pixel by the committed-art guard rather than by eye.
 *
 * Routing parameters live here rather than in code so a second pack can lay a
 * denser or sparser network without a renderer change.
 */
const lineworkLayerSchema = z
  .object({
    id: z.string().min(1),
    /**
     * Track never leaves the ground (a rail ending in rock reads as a bug);
     * pipe deliberately drives one cell into the wall so it enters and exits
     * the rock face.
     */
    kind: z.enum(['track', 'pipe']),
    imagePath: z.string().min(1),
    textureKey: z.string().min(1),
    /**
     * One frame covers exactly one tile. Pinned to the pack cell size because
     * the Wang contract requires a tile's art to stay inside its own square —
     * a frame that overhung its cell could not be edge-matched at all.
     */
    cellPx: z.literal(TERRAIN_PACK_CELL_PX),
    /** Exactly the complete 2-edge Wang set. */
    frames: z.literal(EDGE_WANG_FRAME_COUNT),
    /** First opaque pixel of the stub along any edge. */
    stubOffsetPx: z.number().int().min(0),
    /** Opaque width of the stub along any edge. */
    stubWidthPx: z.number().int().positive(),
    /** Short routes generated local to each hub room — these create density. */
    spursPerHub: z.number().int().min(0),
    /** Long routes connecting hub pairs — these create length. */
    trunkRoutes: z.number().int().min(0),
    /** Radius in tiles around a hub counted as "near" for spurs and metrics. */
    hubRadiusTiles: z.number().int().positive(),
    /** Extra A* step cost outside a hub radius (keeps the heuristic admissible). */
    awayFromHubCost: z.number().min(0),
    /** Extra A* cost for changing heading — higher means longer straight runs. */
    turnPenalty: z.number().min(0),
    /** Salt so two layers over the same map do not generate identical routes. */
    seedSalt: z.string().min(1),
    props: lineworkPropSetSchema.optional(),
  })
  .strict()
  .superRefine((val, ctx) => {
    if (val.stubOffsetPx + val.stubWidthPx > val.cellPx) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${val.id}: stub span [${val.stubOffsetPx}, ${
          val.stubOffsetPx + val.stubWidthPx
        }) exceeds cellPx ${val.cellPx}`,
      });
    }
  });
export type LineworkLayerDef = z.infer<typeof lineworkLayerSchema>;

export const terrainPackDefSchema = z
  .object({
    id: terrainPackIdSchema,
    name: z.string().min(1),
    provenance: provenanceSchema,
    wallAutotile: wallAutotileSchema,
    floorPool: variantPoolSchema,
    corridorPool: variantPoolSchema,
    /**
     * NOTE — there is deliberately no `doorSet`. Terrain packs used to carry their
     * own door art, which won precedence over the shared door renderer and was
     * drawn at a pack-specific scale. That made a door's size and projection depend
     * on which pack happened to ship art rather than on one design rule. Doors are
     * now owned end-to-end by `src/engine/sprites/door-visuals.ts` for every floor;
     * per-tileset door LOOKS re-enter there, through the same selection and fit.
     * `.strict()` below means a manifest that still declares `doorSet` fails
     * validation loudly instead of being silently ignored.
     */
    /** Optional set of exactly `WALL_ACCENT_COUNT` mask-aware accent atlases. */
    wallAccents: z.array(wallAccentSchema).length(WALL_ACCENT_COUNT).optional(),
    specialFloorPools: specialFloorPoolsSchema.optional(),
    groundDecals: z.array(groundDecalSetSchema).min(1).optional(),
    /** Optional edge-Wang linework layers (mine-cart track, pipe runs). */
    linework: z.array(lineworkLayerSchema).min(1).optional(),
  })
  .strict();
export type TerrainPackDef = z.infer<typeof terrainPackDefSchema>;

/** Door state × orientation — see `resolveDoorPoolVariant` in `terrain-pack-variants.ts`. */
export type DoorOrientation = 'horizontal' | 'vertical';
