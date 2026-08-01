/**
 * Generated sprite asset registry — engine-portable contract for the
 * approved-sprite manifest produced by the sprite-generation pipeline.
 *
 * The pipeline writes `public/assets/generated/manifest.json` whose schema
 * is owned by `scripts/sprites/approve.ts`. This module is the
 * engine-facing mirror: it parses the manifest, validates it, and exposes
 * a `lookup(briefId)` registry that game/engine code can consult to find
 * a generated sprite without touching files or Phaser directly.
 *
 * Layer rule: lives in `src/shared/` so engine and any future game-layer
 * consumer can import the types without pulling in Phaser. Phaser-side
 * loader glue lives in `src/engine/generatedAssets/`.
 */
import { z } from 'zod';
import { SeededRandom } from './random.js';
import { SPRITE_TYPES } from './sprite-types.js';

/**
 * Default anchor used when a manifest entry's `anchor` is `null` — i.e.
 * anchor derivation failed during approval but the variant shipped anyway.
 * Sprite center for the canonical 16×16 frame. Consumers that know the
 * sprite is hand-held should prefer `DEFAULT_HANDHELD_SPRITE_ANCHOR` from
 * `sprite-anchor.ts` (bottom-center). This default is the safer fallback
 * for arbitrary item icons.
 */
export const DEFAULT_GENERATED_ANCHOR: { readonly x: number; readonly y: number } = Object.freeze({
  x: 8,
  y: 8,
});

const anchorSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    source: z.enum(['manual', 'derived', 'brief']),
  })
  .strict();

const anchorsSchema = z
  .object({
    hold: anchorSchema.nullable(),
    centerOfGravity: anchorSchema.nullable(),
    /**
     * Optional weapon-attachment anchor. Present only for mob sprites where the
     * author has explicitly set a muzzle / weapon-grip point in the editor.
     * Absent entries fall back to the entity's ECS/visual pivot at runtime.
     */
    weapon: anchorSchema.nullable().optional(),
  })
  .strict();

/**
 * Bounding box of a sprite's non-transparent pixels, plus the canvas it was
 * measured against so a consumer can tell when it has gone stale.
 *
 * ## Why this is not `anchor`
 *
 * `anchor` is derived per-brief by whichever sensor mode that brief configured,
 * so it has no uniform meaning. Measured across the welcome room's 34 base
 * layers: 16 anchors sit at the opaque bottom, 18 sit at the opaque centre, and
 * one is `0,0`. A consumer asking "where does this object actually end" would
 * therefore be right on roughly half the corpus and silently wrong on the rest,
 * with no signal to tell the two apart. `opaqueBounds` has exactly one meaning
 * for every sprite, which is the whole point of it being separate.
 *
 * Backfilled by `sprites:derive-opaque-bounds` and written at approval time.
 */
const opaqueBoundsSchema = z
  .object({
    x: z.number().int(),
    y: z.number().int(),
    width: z.number().int(),
    height: z.number().int(),
    canvasWidth: z.number().int(),
    canvasHeight: z.number().int(),
  })
  .strict();

export type OpaqueBounds = z.infer<typeof opaqueBoundsSchema>;

/**
 * Manifest entry schema. Mirrors `ManifestEntry` from
 * `scripts/sprites/approve.ts`. Kept loose (`.passthrough()`) on unknown
 * fields so adding fields on the approve side does not require a coordinated
 * engine update.
 */
export const manifestEntrySchema = z
  .object({
    briefId: z.string().min(1),
    spriteName: z.string().min(1),
    /** Path relative to `public/assets/`, forward-slashed. */
    assetPath: z.string().min(1),
    approvedAt: z.string().min(1),
    sourceRun: z.string().min(1),
    variantIndex: z.number().int().min(0),
    anchor: anchorSchema.nullable(),
    anchors: anchorsSchema.optional(),
    sensorScore: z.string().min(1),
    judgeScore: z.string().nullable(),
    sensorBreakdown: z
      .array(
        z
          .object({
            sensor: z.string().min(1),
            ok: z.boolean(),
          })
          .passthrough(),
      )
      .optional(),
    judgeScorecard: z.record(z.string(), z.unknown()).nullable().optional(),
    /**
     * Canonical sprite type (`weapon`/`enemy`/`item`/`tile`/`vfx`/`character`).
     * Optional + nullable so pre-`type` manifests still parse and so the
     * approve side can write an explicit `null` when a brief's type can't be
     * resolved. The reference selector uses this to favour same-type examples.
     */
    type: z.enum(SPRITE_TYPES).nullable().optional(),
    /**
     * SHA-256 of the approved PNG bytes. Present on entries approved after
     * content-hashing landed; used by the reference selector's run summary to
     * pin the exact bytes a reference was sampled from (rerun reproducibility).
     */
    contentHash: z.string().optional(),
    opaqueBounds: opaqueBoundsSchema.optional(),
    postprocessOverrideProfilePath: z.string().nullable().optional(),
    effectivePipelineSnapshotPath: z.string().nullable().optional(),
    effectivePipelineSnapshotYamlPath: z.string().nullable().optional(),
    effectiveAnchorSource: z.enum(['manual', 'derived', 'brief']).nullable().optional(),
    facingDirection: z.enum(['left', 'right']).optional(),
    /**
     * Optional multi-frame animation descriptor. Present only on entries whose
     * PNG is a horizontal spritesheet strip rather than a single frame. Absent
     * entries keep loading as a flat image (backward compatible) — see
     * `preloadGeneratedSprites` in `src/engine/generatedAssets/preload.ts`.
     *
     * CONTRACT (shared between the sprite-generation pipeline and the engine
     * consumer — see `registerGeneratedSpriteAnimations` in
     * `src/engine/generatedAssets/animations.ts`):
     * - The PNG at `assetPath` is a **single row**, laid out left-to-right,
     *   of `frameCount` frames each exactly `frameWidth` x `frameHeight` px,
     *   with no padding/margin between frames (standard Phaser `spritesheet`
     *   frame numbering: frame `0` is the leftmost cell, frame
     *   `frameCount - 1` the rightmost).
     * - **Frame `0` is the walk cycle's designated idle/resting pose.** When
     *   the entity stops moving, the engine snaps back to frame 0 rather than
     *   freezing on whatever mid-stride frame the loop was on — there is no
     *   separate "idle" field; frame 0 of this same strip doubles as idle.
     */
    animation: z
      .object({
        frameWidth: z.number().int().positive(),
        frameHeight: z.number().int().positive(),
        frameCount: z.number().int().min(2),
        frameRate: z.number().positive(),
        loop: z.boolean().default(true),
      })
      .optional(),
    /**
     * True when this entry is a placeholder stand-in (not real generated art).
     * Placeholder entries are excluded from the derived sprite-catalog rows.
     * Optional so pre-flag manifests still parse; the catalog composer falls
     * back to an `-placeholder` asset-path check when this is absent. See
     * `generated-catalog.ts#isPlaceholderManifestEntry`.
     */
    placeholder: z.boolean().optional(),
    /**
     * Optional per-asset catalog overrides. The sprite catalog's `generated:`
     * rows are DERIVED from this manifest (see `generated-catalog.ts`); this
     * field is the single home for the small set of hand-authored deviations
     * (rich descriptions, deliberate tag overrides) that derivation cannot
     * reconstruct. When absent, the composer derives description + tags from
     * `briefId`/`type`. The override shards with its asset, so it never
     * reintroduces a shared mega-file.
     */
    catalog: z
      .object({
        description: z.string().min(1).optional(),
        tags: z.array(z.string().min(1)).optional(),
      })
      .strict()
      .optional(),
  })
  .passthrough();

export const GENERATED_MANIFEST_VERSION = 1 as const;

const generatedManifestSchema = z
  .object({
    version: z.literal(GENERATED_MANIFEST_VERSION),
    entries: z.record(z.string(), manifestEntrySchema),
  })
  .strict();

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type GeneratedManifest = z.infer<typeof generatedManifestSchema>;

/**
 * Multi-frame animation descriptor for a generated spritesheet entry. The
 * shared contract between the sprite-generation pipeline (which produces
 * multi-frame sheets) and the engine (which plays them) — see
 * `registerGeneratedSpriteAnimations` in `src/engine/generatedAssets/animations.ts`.
 */
export type GeneratedSpriteAnimation = NonNullable<ManifestEntry['animation']>;

/**
 * Engine-facing view of one manifest entry. Resolves the anchor against
 * `DEFAULT_GENERATED_ANCHOR` when the manifest has none, and exposes the
 * Phaser texture key the loader should use (== `spriteName` by contract).
 */
export interface GeneratedSpriteEntry {
  readonly briefId: string;
  /**
   * Phaser texture key — unique per variant. Derived from the manifest entry's
   * own map key (e.g. `iron-sword-var-3`), NOT from `spriteName`. This keeps
   * every approved variant of a brief on its own texture even on legacy data
   * where an older `approve.ts` wrote a brief-wide `spriteName` (the historical
   * render-collision bug). Equals `spriteName` for entries written by current
   * `approve.ts`.
   */
  readonly textureKey: string;
  /** `public/`-relative asset path, forward-slashed. */
  readonly assetPath: string;
  readonly anchor: { readonly x: number; readonly y: number };
  readonly centerOfGravity: { readonly x: number; readonly y: number };
  /**
   * Optional weapon-attachment anchor in sprite-local pixel coordinates.
   * Present only when the editor has explicitly set a weapon anchor for this
   * variant. When `undefined` the runtime resolver falls back to the entity's
   * ECS/visual pivot (world-space position). Use {@link resolveWeaponAnchorWorldPos}
   * to get the final world-space coordinate.
   */
  readonly weaponAnchor?: { readonly x: number; readonly y: number };
  /** True when the original manifest entry's anchor was null. */
  readonly anchorIsDefault: boolean;
  /**
   * Bounding box of the sprite's visible pixels. Absent on legacy entries not
   * yet covered by `sprites:derive-opaque-bounds`; consumers must degrade to
   * whole-canvas behaviour rather than assuming a box.
   */
  readonly opaqueBounds?: OpaqueBounds;
  readonly approvedAt: string;
  readonly sourceRun: string;
  readonly variantIndex: number;
  readonly sensorScore: string;
  readonly judgeScore: string | null;
  readonly facingDirection: 'left' | 'right';
  /**
   * Present when this variant's PNG is a horizontal multi-frame walk/anim
   * strip rather than a single frame. See `GeneratedSpriteAnimation`.
   */
  readonly animation?: GeneratedSpriteAnimation;
}

/**
 * Engine-portable lookup view over a parsed manifest.
 *
 * A brief may have MULTIPLE approved variants. The registry groups entries by
 * `briefId`:
 *   - `variants(briefId)` returns every approved variant (sorted by
 *     `variantIndex`), so callers can pick one (see `pickGeneratedVariant`).
 *   - `lookup(briefId)` returns the first variant — a deterministic, back-compat
 *     convenience for callers that don't care which variant they get.
 *   - `entries()` is the flattened list of ALL variants across ALL briefs, so the
 *     preloader queues every variant's texture.
 */
export interface GeneratedSpriteRegistry {
  readonly version: typeof GENERATED_MANIFEST_VERSION;
  /** First approved variant for a brief (lowest `variantIndex`), or null. */
  lookup(briefId: string): GeneratedSpriteEntry | null;
  /** All approved variants for a brief, sorted by `variantIndex`. Empty if none. */
  variants(briefId: string): readonly GeneratedSpriteEntry[];
  /** Every variant across every brief, flattened (manifest insertion order). */
  entries(): readonly GeneratedSpriteEntry[];
  /** Distinct briefIds that have at least one approved variant. */
  briefIds(): readonly string[];
  has(briefId: string): boolean;
  /** Total number of variants across all briefs. */
  readonly size: number;
}

/**
 * Parse + validate a raw manifest payload. Throws ZodError on malformed
 * input. Callers that want soft-fail behaviour should catch and fall back
 * to an empty registry — see `tryLoadGeneratedManifest`.
 */
export function parseGeneratedManifest(raw: unknown): GeneratedManifest {
  return generatedManifestSchema.parse(raw);
}

/**
 * Build a registry over an already-parsed manifest. Pure: no IO, no
 * globals; safe to call from any layer.
 */
export function loadGeneratedManifest(manifest: GeneratedManifest): GeneratedSpriteRegistry {
  const byBrief = new Map<string, GeneratedSpriteEntry[]>();
  const flat: GeneratedSpriteEntry[] = [];
  for (const [manifestKey, entry] of Object.entries(manifest.entries)) {
    // textureKey comes from the manifest MAP KEY (unique per variant) so
    // variants never collide, even on legacy data where `spriteName` was
    // written brief-wide. `briefId` is the grouping key.
    const resolved = toRegistryEntry(entry, manifestKey);
    flat.push(resolved);
    const group = byBrief.get(resolved.briefId);
    if (group) {
      group.push(resolved);
    } else {
      byBrief.set(resolved.briefId, [resolved]);
    }
  }
  for (const group of byBrief.values()) {
    group.sort(compareVariants);
  }
  return {
    version: GENERATED_MANIFEST_VERSION,
    size: flat.length,
    has: (briefId) => byBrief.has(briefId),
    lookup: (briefId) => byBrief.get(briefId)?.[0] ?? null,
    variants: (briefId) => byBrief.get(briefId) ?? EMPTY_VARIANTS,
    entries: () => flat,
    briefIds: () => Array.from(byBrief.keys()),
  };
}

/** Shared empty result so `variants()` never allocates for a miss. */
const EMPTY_VARIANTS: readonly GeneratedSpriteEntry[] = Object.freeze([]);

/** Deterministic variant order: by `variantIndex`, then `textureKey`. */
function compareVariants(a: GeneratedSpriteEntry, b: GeneratedSpriteEntry): number {
  if (a.variantIndex !== b.variantIndex) {
    return a.variantIndex - b.variantIndex;
  }
  if (a.textureKey < b.textureKey) return -1;
  if (a.textureKey > b.textureKey) return 1;
  return 0;
}

/**
 * Convenience: parse-then-load. Throws on malformed input.
 */
export function buildGeneratedSpriteRegistry(raw: unknown): GeneratedSpriteRegistry {
  return loadGeneratedManifest(parseGeneratedManifest(raw));
}

/** Empty registry — handy for tests and the "manifest missing" boot path. */
export function emptyGeneratedSpriteRegistry(): GeneratedSpriteRegistry {
  return loadGeneratedManifest({ version: GENERATED_MANIFEST_VERSION, entries: {} });
}

function toRegistryEntry(entry: ManifestEntry, manifestKey: string): GeneratedSpriteEntry {
  const hold = entry.anchors?.hold ?? entry.anchor;
  const center = entry.anchors?.centerOfGravity ?? hold;
  const anchor = hold ? { x: hold.x, y: hold.y } : { ...DEFAULT_GENERATED_ANCHOR };
  const centerOfGravity = center ? { x: center.x, y: center.y } : { ...anchor };
  const weaponAnchorRaw = entry.anchors?.weapon;
  const weaponAnchor =
    weaponAnchorRaw != null ? { x: weaponAnchorRaw.x, y: weaponAnchorRaw.y } : undefined;
  return {
    briefId: entry.briefId,
    textureKey: manifestKey,
    assetPath: entry.assetPath,
    anchor,
    centerOfGravity,
    ...(weaponAnchor !== undefined ? { weaponAnchor } : {}),
    anchorIsDefault: hold === null,
    ...(entry.opaqueBounds !== undefined ? { opaqueBounds: entry.opaqueBounds } : {}),
    approvedAt: entry.approvedAt,
    sourceRun: entry.sourceRun,
    variantIndex: entry.variantIndex,
    sensorScore: entry.sensorScore,
    judgeScore: entry.judgeScore,
    facingDirection: entry.facingDirection ?? 'right',
    ...(entry.animation !== undefined ? { animation: entry.animation } : {}),
  };
}

/**
 * Pick one approved variant for a brief, deterministically for a given `seed`.
 *
 * Returns null when the brief has no approved variant. With a single variant it
 * returns that variant (no RNG draw). With multiple, it uses `SeededRandom` so
 * the choice is replay-safe — pass a seed derived from a stable per-context key
 * (e.g. `hashStringToSeed(itemId) ^ world.seed`) to keep the same item on the
 * same variant for a whole run while still varying across runs/items.
 *
 * NEVER uses `Math.random()` (Constitution: all randomness via `SeededRandom`).
 */
export function pickGeneratedVariant(
  registry: GeneratedSpriteRegistry,
  briefId: string,
  seed: number,
): GeneratedSpriteEntry | null {
  const variants = registry.variants(briefId);
  if (variants.length === 0) {
    return null;
  }
  if (variants.length === 1) {
    return variants[0] ?? null;
  }
  return new SeededRandom(seed).pick(variants);
}

/**
 * Default pixel frame size for generated enemy/NPC sprites produced by the
 * asset pipeline. Used when deriving normalized weapon-anchor offsets without
 * an actual loaded texture reference (e.g. in headless simulation or tests).
 */
export const DEFAULT_GENERATED_FRAME_SIZE_PX = 64;

/** Inputs for {@link resolveOpaqueFit}. */
export interface OpaqueFitInput {
  /** Opaque bounds from the manifest, or `undefined` for legacy entries. */
  readonly bounds: OpaqueBounds | undefined;
  /** Actual loaded texture size, used to validate the bounds and to fall back. */
  readonly canvasWidth: number;
  readonly canvasHeight: number;
  /** Declared size in pixels (feet already converted). */
  readonly targetWidthPx: number;
  readonly targetHeightPx: number;
  /** True when the prop stands on its position; false = centred on it. */
  readonly anchorBase: boolean;
  /**
   * True when both declared dimensions are real ground extents (rugs, decals),
   * so the art is contain-fitted instead of height-authoritative.
   */
  readonly floorPlane: boolean;
}

/** Origin (0..1 of the frame) plus the uniform scale to apply. */
export interface OpaqueFit {
  readonly originX: number;
  readonly originY: number;
  readonly scale: number;
}

/**
 * Resolve the origin + scale that make a prop's DECLARED feet describe its
 * VISIBLE pixels rather than its canvas.
 *
 * Without this, both numbers are measured against the raw canvas, which
 * includes the pipeline's standardized ~5%-per-side transparent safety margin.
 * Two consequences, both measured in the welcome room:
 *
 *   1. A base-anchored prop is pinned by the canvas bottom rather than the
 *      object's feet, so it floats above its floor line by the bottom margin —
 *      up to 0.42 ft on `laundry-line`.
 *   2. `heightFt` scales the canvas, so a prop declared 6 ft tall renders its
 *      visible art ~10% shorter than 6 ft.
 *
 * Anchoring and scaling on the opaque bounds fixes both from data derived out
 * of the shipped PNG, so it survives art regeneration — unlike hand-trimming
 * the margin out of the file, which would break the manifest `contentHash`
 * integrity check that `reconcile-queue` relies on and be undone by the next
 * regeneration anyway.
 *
 * Falls back to whole-canvas behaviour when bounds are absent (legacy entries)
 * or disagree with the loaded texture (art replaced without a re-derive), so a
 * stale manifest degrades to the previous rendering rather than to garbage.
 */
/**
 * The rectangle a sprite should actually be fitted/anchored on: its opaque
 * bounds when they are present and consistent with the loaded texture,
 * otherwise the whole canvas.
 *
 * Shared with `resolveOpaqueFit` and `door-visuals.ts` resolve helpers; kept
 * internal now that `MainGameScene` uses `resolveGeneratedDoorContainFit`
 * instead of calling this directly.
 */
function resolveOpaqueBox(
  bounds: OpaqueBounds | undefined,
  canvasWidth: number,
  canvasHeight: number,
): { x: number; y: number; width: number; height: number } {
  const usable =
    bounds !== undefined &&
    bounds.canvasWidth === canvasWidth &&
    bounds.canvasHeight === canvasHeight &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= canvasWidth &&
    bounds.y + bounds.height <= canvasHeight;
  return usable ? bounds : { x: 0, y: 0, width: canvasWidth, height: canvasHeight };
}

export function resolveOpaqueFit(input: OpaqueFitInput): OpaqueFit {
  const { bounds, canvasWidth, canvasHeight, targetWidthPx, targetHeightPx } = input;
  if (canvasWidth <= 0 || canvasHeight <= 0) {
    return { originX: 0.5, originY: input.anchorBase ? 1 : 0.5, scale: 1 };
  }
  const box = resolveOpaqueBox(bounds, canvasWidth, canvasHeight);
  return {
    originX: (box.x + box.width / 2) / canvasWidth,
    originY: input.anchorBase
      ? (box.y + box.height) / canvasHeight
      : (box.y + box.height / 2) / canvasHeight,
    scale: input.floorPlane
      ? Math.min(targetWidthPx / box.width, targetHeightPx / box.height)
      : targetHeightPx / box.height,
  };
}

/**
 * Default visual width (and height) in world feet for a generated enemy sprite
 * rendered at the canonical 0.4 render scale: 64 px × 0.4 / 8 px-per-ft = 3.2 ft.
 *
 * Use this constant — not ECS physics-body dimensions — when converting a
 * {@link NormalizedWeaponAnchor} fractional offset into a world-space foot
 * displacement in game-layer consumers. It is correct for all standard enemies
 * (sizeScale = 1); for rare scaled-up variants the offset will be proportionally
 * approximate but still directionally correct.
 */
export const DEFAULT_GENERATED_VISUAL_WIDTH_FT = 3.2;

/**
 * Normalized weapon-anchor offset for an entity's generated sprite.
 *
 * `relX` / `relY` are dimensionless fractions of the sprite frame: positive X
 * is toward the right of the canonical art, positive Y is downward.
 * `artFacing` records whether the authored art faces right or left so
 * consumers can mirror the sign of `relX` when the entity's current facing
 * differs from the authored direction.
 */
export interface NormalizedWeaponAnchor {
  /** (wpX − cogX) / frameWidth — dimensionless, canonical art orientation. */
  readonly relX: number;
  /** (wpY − cogY) / frameHeight — dimensionless. */
  readonly relY: number;
  /** Canonical art facing direction stored in the manifest entry. */
  readonly artFacing: 'left' | 'right';
}

/**
 * Compute a {@link NormalizedWeaponAnchor} from a manifest entry.
 *
 * Returns `null` when the entry is absent or has no explicit weapon anchor.
 * Uses {@link DEFAULT_GENERATED_FRAME_SIZE_PX} as the denominator when no
 * explicit frame size is supplied.
 */
export function computeNormalizedWeaponAnchor(
  entry: GeneratedSpriteEntry | null | undefined,
  frameW = DEFAULT_GENERATED_FRAME_SIZE_PX,
  frameH = DEFAULT_GENERATED_FRAME_SIZE_PX,
): NormalizedWeaponAnchor | null {
  if (!entry?.weaponAnchor) return null;
  return {
    relX: (entry.weaponAnchor.x - entry.centerOfGravity.x) / frameW,
    relY: (entry.weaponAnchor.y - entry.centerOfGravity.y) / frameH,
    artFacing: entry.facingDirection,
  };
}

// ─── Brief-ID lookup tables (engine-portable pure data) ─────────────────────

/**
 * Maps the renderer's canonical visual type key for each enemy to the
 * generated-sprite brief that provides its art. Used internally by
 * projectile-origin helpers to resolve briefs without a Phaser scene reference.
 */
const GENERATED_BRIEF_BY_TYPE: Readonly<Record<string, string>> = {
  enemy_rat: 'rat-v1',
  enemy_slime: 'slime-v1',
  enemy_spawner_rats_nest: 'rat-nest-v2',
  enemy_spawner_slime_pool: 'slime-pool-v1',
  enemy_boss_ratslime: 'rat-slime-v1',
  enemy_boss_slimerat: 'slime-rat-boss',
  enemy_family_boss: 'goblin-boss',
};

/**
 * Maps per-enemy `appearanceKey` strings (set by spawners via
 * `world.enemyAppearanceKeys`) to their generated-sprite brief IDs. Takes
 * priority over {@link GENERATED_BRIEF_BY_TYPE}.
 */
const GENERATED_BRIEF_BY_APPEARANCE_KEY: Readonly<Record<string, string>> = {
  rat: 'rat-v1',
  'rat-brute': 'rat-v1',
  'rat-king': 'rat-king-v1',
  'rat-queen': 'rat-queen-v1',
  'rats-nest': 'rats-nest-v1',
  slime: 'slime-v1',
  'slime-pool': 'slime-pool-v1',
  'slime-mini': 'baby-slime-v1',
  'rat-slime': 'rat-slime-v1',
  'goblin-boss': 'goblin-boss',
  'goblin-grunt': 'goblin-grunt',
  'goblin-elite-joyrider': 'goblin-grunt',
  'goblin-junkshot': 'goblin-grunt',
  'llama-boss': 'llama-boss',
  'llama-spitter': 'llama-spitter',
  'llama-elite-backlot-capo': 'llama-spitter',
  'llama-curb-stomper': 'llama-spitter',
  'panda-boss': 'panda-boss',
  'panda-bruiser': 'panda-bruiser',
  'panda-elite-red-envelope': 'panda-bruiser',
  'panda-boba-sniper': 'panda-bruiser',
  'faerie-boss': 'faerie-boss',
  'faerie-blink': 'faerie-blink',
  'faerie-elite-fae-driveby': 'faerie-blink',
  'faerie-spark-caster': 'faerie-blink',
  'kobold-boss': 'kobold-boss',
  'kobold-torch': 'kobold-torch',
  'kobold-elite-dragon-capo': 'kobold-torch',
  'kobold-roman-candle': 'kobold-roman-candle-v1',
  'myconid-boss': 'myconid-boss',
  'myconid-spore': 'myconid-spore',
  'myconid-elite-don-agaric': 'myconid-spore',
  'myconid-clubcap': 'myconid-spore',
  'toadkin-boss': 'toadkin-boss',
  'toadkin-tongue': 'toadkin-tongue',
  'toadkin-elite-swamp-consigliere': 'toadkin-tongue',
  'toadkin-bouncer': 'toadkin-tongue',
  'gnome-boss': 'gnome-boss',
  'gnome-tinker': 'gnome-tinker',
  'gnome-elite-pinstripe-artillerist': 'gnome-tinker',
  'gnome-wheelman': 'gnome-tinker',
  'ratfolk-boss': 'ratfolk-boss',
  'ratfolk-plague': 'ratfolk-plague',
  'ratfolk-elite-underboss': 'ratfolk-plague',
  'ratfolk-sewer-sniper': 'ratfolk-plague',
  'cactusfolk-boss': 'cactusfolk-boss',
  'cactusfolk-spiny': 'cactusfolk-spiny',
  'cactusfolk-elite-desert-capo': 'cactusfolk-spiny',
  'cactusfolk-needle-gunner': 'cactusfolk-spiny',
  'batfolk-boss': 'batfolk-boss',
  'batfolk-diver': 'batfolk-diver',
  'batfolk-elite-rave-don': 'batfolk-diver',
  'batfolk-sonic-shooter': 'batfolk-diver',
  'crabfolk-boss': 'crabfolk-boss',
  'crabfolk-armored': 'crabfolk-armored',
  'crabfolk-elite-shell-capo': 'crabfolk-armored',
  'crabfolk-claw-gunner': 'crabfolk-armored',
  'beetlefolk-boss': 'beetlefolk-boss',
  'beetlefolk-charger': 'beetlefolk-charger',
  'beetlefolk-elite-bugatti': 'beetlefolk-charger',
  'beetlefolk-resin-gunner': 'beetlefolk-charger',
  'molefolk-boss': 'molefolk-boss',
  'molefolk-burrower': 'molefolk-burrower',
  'molefolk-elite-pit-boss': 'molefolk-burrower',
  'molefolk-gravel-slinger': 'molefolk-burrower',
  'raccoon-boss': 'raccoons-boss',
  'raccoon-thief': 'raccoon-thief',
  'raccoon-elite-heist-capo': 'raccoon-thief',
  'raccoon-bottle-rocketeer': 'raccoon-thief',
  'geese-boss': 'geese-boss',
  'geese-honker': 'geese-honker',
  'geese-elite-goosefather': 'geese-honker',
  'geese-gatling-gander': 'geese-honker',
  'imp-boss': 'imps-boss',
  'imp-flinger': 'imp-flinger',
  'imp-elite-hellfire-capo': 'imp-flinger',
  'imp-chain-brawler': 'imp-flinger',
  'snailfolk-boss': 'snailfolk-boss',
  'snailfolk-slimer': 'snailfolk-slimer',
  'snailfolk-elite-slick-don': 'snailfolk-slimer',
  'snailfolk-sludge-artillery': 'snailfolk-slimer',
  'cave-slime': 'cave-slime',
  'giant-cave-rat': 'giant-cave-rat',
  'cave-bat-swarm': 'cave-bat-swarm',
  'rock-lice': 'rock-lice',
  'blind-cave-newt': 'blind-cave-newt',
  'glow-worm': 'glow-worm',
  'fungal-husk': 'fungal-husk',
  'crystal-scuttler': 'crystal-scuttler',
};

/**
 * Resolve the generated-sprite brief ID for an enemy entity given its
 * renderer visual type and optional appearance key. Returns `undefined` when
 * no generated brief is registered for the type/appearance combination —
 * the entity uses placeholder art.
 *
 * Lives in `src/shared/` (no Phaser dep) so both the engine renderer and
 * game-layer projectile-origin helpers can use it.
 */
export function generatedBriefIdForEnemy(type: string, appearanceKey?: string): string | undefined {
  if (appearanceKey !== undefined) {
    const byAppearance = GENERATED_BRIEF_BY_APPEARANCE_KEY[appearanceKey];
    if (byAppearance !== undefined) {
      return byAppearance;
    }
  }
  return GENERATED_BRIEF_BY_TYPE[type];
}

/**
 * Minimal world slice required by {@link getEntityNormalizedWeaponAnchor}.
 * Structural so core and shared helpers can stay free of the full `GameWorld`
 * import cycle.
 */
export interface WeaponAnchorWorld {
  readonly generatedSpriteRegistry: GeneratedSpriteRegistry | null;
  readonly enemyAppearanceKeys: ReadonlyMap<number, string>;
  readonly stores: {
    readonly sprite: { readonly variantRoll: ArrayLike<number> };
  };
  readonly entityWeaponAnchors: Map<number, NormalizedWeaponAnchor>;
}

/**
 * Return the cached {@link NormalizedWeaponAnchor} for `eid`, or compute and
 * cache it on the first call.
 *
 * Resolution order:
 *  1. Cache hit in `world.entityWeaponAnchors`.
 *  2. Look up the entity's generated-sprite registry entry via
 *     `world.generatedSpriteRegistry`, `world.enemyAppearanceKeys`, and the
 *     entity's `variantRoll`. Store the result in the cache for future frames.
 *  3. Return `null` when the registry is absent (headless) or the entity has
 *     no weapon anchor authored in the manifest.
 *
 * Callers must apply mirroring themselves:
 *   `const needsMirror = anchor.artFacing !== (facingRight ? 'right' : 'left');`
 *   `const offsetX = (needsMirror ? -anchor.relX : anchor.relX) * spriteWidthFt;`
 */
export function getEntityNormalizedWeaponAnchor(
  world: WeaponAnchorWorld,
  eid: number,
): NormalizedWeaponAnchor | null {
  const cached = world.entityWeaponAnchors.get(eid);
  if (cached !== undefined) return cached;

  const registry = world.generatedSpriteRegistry;
  if (!registry) return null;

  const appearanceKey = world.enemyAppearanceKeys.get(eid);
  // Resolve brief via appearance key only; GENERATED_BRIEF_BY_TYPE is not
  // available here (entity kind string is outside the WeaponAnchorWorld
  // contract) and all generated-sprite entities always carry an appearance key.
  const briefId =
    appearanceKey !== undefined ? GENERATED_BRIEF_BY_APPEARANCE_KEY[appearanceKey] : undefined;
  if (!briefId) return null;

  const variantRoll = (world.stores.sprite.variantRoll as ArrayLike<number>)[eid] ?? eid;
  const entry = pickGeneratedVariant(registry, briefId, variantRoll as number);
  const anchor = computeNormalizedWeaponAnchor(entry);
  if (!anchor) return null;

  world.entityWeaponAnchors.set(eid, anchor);
  return anchor;
}

/**
 * Resolve the world-space weapon-origin for an entity.
 *
 * When the registry entry has an explicit `weaponAnchor`, this converts the
 * pixel coordinate to world-space using the sprite's known world dimensions and
 * frame pixel dimensions. The weapon anchor pixel offset is computed relative to
 * the sprite's `centerOfGravity` (= the entity's ECS position in world-space),
 * then converted to feet and added to the entity position.
 *
 * **Facing:** The offset is mirrored whenever the art's canonical facing
 * (`entry.facingDirection`) differs from `facingRight`. Specifically the
 * *relative* pixel offset `(wpX − cogX)` is negated — preserving the exact
 * COG-relative magnitude while flipping the side. This handles all four
 * combinations: right-art/right-entity, right-art/left-entity,
 * left-art/right-entity, and left-art/left-entity.
 *
 * **Fallback:** When `entry` is absent or has no `weaponAnchor`, returns the
 * entity's ECS position unchanged — identical to pre-feature behavior.
 *
 * @param entry           Registry entry for the entity's current sprite variant.
 * @param entityX         Entity world position X (feet).
 * @param entityY         Entity world position Y (feet).
 * @param spriteWidthFt   Entity sprite width in world feet.
 * @param spriteHeightFt  Entity sprite height in world feet.
 * @param framePixelWidth Width of the sprite frame in pixels (e.g. 64).
 * @param framePixelHeight Height of the sprite frame in pixels.
 * @param facingRight     True when the entity is currently facing / moving right.
 */
export function resolveWeaponAnchorWorldPos(
  entry: GeneratedSpriteEntry | null | undefined,
  entityX: number,
  entityY: number,
  spriteWidthFt: number,
  spriteHeightFt: number,
  framePixelWidth: number,
  framePixelHeight: number,
  facingRight: boolean,
): { readonly x: number; readonly y: number } {
  if (!entry?.weaponAnchor) {
    return { x: entityX, y: entityY };
  }
  const cogX = entry.centerOfGravity.x;
  const cogY = entry.centerOfGravity.y;
  const relX = entry.weaponAnchor.x - cogX;
  const relY = entry.weaponAnchor.y - cogY;
  // Mirror whenever the canonical art facing differs from the entity's current
  // facing. We negate the *relative* offset (weapon − COG) rather than the
  // absolute pixel coordinate so the magnitude is preserved symmetrically.
  const needsMirror = entry.facingDirection !== (facingRight ? 'right' : 'left');
  const offsetX = ((needsMirror ? -relX : relX) / framePixelWidth) * spriteWidthFt;
  const offsetY = (relY / framePixelHeight) * spriteHeightFt;
  return { x: entityX + offsetX, y: entityY + offsetY };
}
