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
 * Manifest entry schema. Mirrors `ManifestEntry` from
 * `scripts/sprites/approve.ts`. Kept loose (`.passthrough()`) on unknown
 * fields so adding fields on the approve side does not require a coordinated
 * engine update.
 */
const manifestEntrySchema = z
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
    postprocessOverrideProfilePath: z.string().nullable().optional(),
    effectivePipelineSnapshotPath: z.string().nullable().optional(),
    effectivePipelineSnapshotYamlPath: z.string().nullable().optional(),
    effectiveAnchorSource: z.enum(['manual', 'derived', 'brief']).nullable().optional(),
    facingDirection: z.enum(['left', 'right']).optional(),
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
  readonly approvedAt: string;
  readonly sourceRun: string;
  readonly variantIndex: number;
  readonly sensorScore: string;
  readonly judgeScore: string | null;
  readonly facingDirection: 'left' | 'right';
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
    approvedAt: entry.approvedAt,
    sourceRun: entry.sourceRun,
    variantIndex: entry.variantIndex,
    sensorScore: entry.sensorScore,
    judgeScore: entry.judgeScore,
    facingDirection: entry.facingDirection ?? 'right',
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
 * Resolve the world-space weapon-origin for an entity.
 *
 * When the registry entry has an explicit `weaponAnchor`, this converts the
 * pixel coordinate to world-space using the sprite's known world dimensions and
 * frame pixel dimensions. The weapon anchor pixel offset is computed relative to
 * the sprite's `centerOfGravity` (= the entity's ECS position in world-space),
 * then converted to feet and added to the entity position.
 *
 * **Facing:** Generated mob art defaults to right-facing (`facingDirection:
 * 'right'`). When `facingRight` is false and `entry.facingDirection` is
 * `'right'`, the anchor's X coordinate is mirrored: `framePixelWidth - 1 - wpX`.
 * This matches the render layer's horizontal-flip behavior for left-moving enemies.
 *
 * **Fallback:** When `entry` is absent or has no `weaponAnchor`, returns the
 * entity's ECS position unchanged — identical to pre-feature behavior.
 *
 * @param entry           Registry entry for the entity's current sprite variant.
 * @param entityX         Entity world position X (feet).
 * @param entityY         Entity world position Y (feet).
 * @param spriteWidthFt   Entity sprite width in world feet (from `sprite.width`).
 * @param spriteHeightFt  Entity sprite height in world feet (from `sprite.height`).
 * @param framePixelWidth Width of the sprite frame in pixels (e.g. 64 for enemy sprites).
 * @param framePixelHeight Height of the sprite frame in pixels.
 * @param facingRight     True when the entity is facing / moving right.
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
  let wpX = entry.weaponAnchor.x;
  const wpY = entry.weaponAnchor.y;
  // Mirror X when the canonical art faces right but the entity currently faces left.
  if (entry.facingDirection === 'right' && !facingRight) {
    wpX = framePixelWidth - 1 - wpX;
  }
  const offsetX = ((wpX - cogX) / framePixelWidth) * spriteWidthFt;
  const offsetY = ((wpY - cogY) / framePixelHeight) * spriteHeightFt;
  return { x: entityX + offsetX, y: entityY + offsetY };
}
