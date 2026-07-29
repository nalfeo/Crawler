import { hasComponent } from 'bitecs';
import npcSpriteMap from '../../shared/data/npc-sprite-map.json';
import {
  AoeOnImpact,
  AreaDamage,
  Enemy,
  EnemyProjectile,
  Gold,
  Harvestable,
  LineDamage,
  MeleeSwing,
  Npc,
  Player,
  Projectile,
  Returning,
  SpawnAnim,
  Spawner,
  Sprite,
  Team,
  Trap,
  XpGem,
} from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { TeamId } from '../../shared/constants.js';
import {
  generatedBriefIdForEnemy,
  type GeneratedSpriteRegistry,
} from '../../shared/generated-assets.js';
import { computeSpawnPopScale, spawnAnimProgress } from '../../shared/spawn-anim.js';
import type { EntitySpriteMappings } from '../../shared/data/entity-sprite-mappings.js';
import ENTITY_SPRITE_MAPPINGS from '../../shared/data/entity-sprite-mappings.json';

/**
 * Pure entity → render-kind resolution for {@link createPhaserBridge}.
 *
 * Extracted from `PhaserBridge.ts` (behavior-preserving) so the branchy
 * `hasComponent` dispatcher and the enemy texture-variant mapping can be
 * unit-tested directly with `createTestWorld()` — no Phaser scene required.
 */

/** `Sprite.textureId` value tagging the floor-1 welcome sign. */
const SPRITE_TEX_WELCOME_SIGN = 3;

/**
 * Sprite width (in FEET) of a full-grown slime. Baby slimes spawned by a split
 * carry a smaller `Sprite.width` (also in feet — the sim is feet-based per ADR
 * 0023), and we render them proportionally smaller than this reference. Keep in
 * sync with the `slime` archetype `spriteWidth` in
 * `src/shared/data/enemies.floor1.json` (currently 3.0 ft). This MUST be the
 * feet value, not its pixel equivalent: {@link computeEnemyScale} divides a
 * feet-based `Sprite.width` by it, so a pixel value here shrinks babies to the
 * 0.2 floor.
 */
export const SLIME_FULL_SPRITE_WIDTH = 3;

/**
 * Structural slice of {@link GameWorld} that {@link resolveRenderKind} reads:
 * the ECS handle (for `hasComponent`) plus the `team.id` and `sprite.textureId`
 * stores. A full `GameWorld` is assignable, so callers pass their world as-is
 * while tests can supply just these fields.
 */
export interface RenderKindWorld {
  readonly ecs: GameWorld['ecs'];
  readonly stores: {
    readonly team: { readonly id: ArrayLike<number> };
    readonly sprite: { readonly textureId: ArrayLike<number> };
  };
}

/**
 * Resolve the broad render kind for an entity from its components. Mirrors the
 * original `getEntityType`: the FIRST matching component wins, so the order of
 * checks is load-bearing (e.g. `AreaDamage` is split into `aoe`/`enemy_aoe` by
 * team, and `AoeOnImpact` into `aoe_proj`/`enemy_aoe_proj` by `EnemyProjectile`,
 * before the bare `EnemyProjectile`/`Projectile` fallbacks).
 */
export function resolveRenderKind(world: RenderKindWorld, eid: number): string {
  if (hasComponent(world.ecs, eid, Player)) return 'player';
  if (hasComponent(world.ecs, eid, Npc)) return 'npc';
  if (hasComponent(world.ecs, eid, Harvestable)) return 'harvestable';
  if (hasComponent(world.ecs, eid, Enemy)) return 'enemy';
  if (hasComponent(world.ecs, eid, XpGem)) return 'gem';
  if (hasComponent(world.ecs, eid, Gold)) return 'gold';
  if (hasComponent(world.ecs, eid, LineDamage)) return 'beam';
  if (hasComponent(world.ecs, eid, MeleeSwing)) return 'melee_swing';
  if (hasComponent(world.ecs, eid, Trap)) return 'trap';
  if (hasComponent(world.ecs, eid, AreaDamage)) {
    if (hasComponent(world.ecs, eid, Team) && world.stores.team.id[eid] === TeamId.ENEMY) {
      return 'enemy_aoe';
    }
    return 'aoe';
  }
  if (hasComponent(world.ecs, eid, Returning)) return 'returning';
  if (hasComponent(world.ecs, eid, AoeOnImpact)) {
    if (hasComponent(world.ecs, eid, EnemyProjectile)) {
      return 'enemy_aoe_proj';
    }
    return 'aoe_proj';
  }
  if (hasComponent(world.ecs, eid, EnemyProjectile)) return 'enemy_proj';
  if (hasComponent(world.ecs, eid, Projectile)) return 'proj';
  if (
    hasComponent(world.ecs, eid, Sprite) &&
    world.stores.sprite.textureId[eid] === SPRITE_TEX_WELCOME_SIGN
  )
    return 'welcome_sign';
  return 'default';
}

/**
 * Build a reverse lookup of textureId → variant from the config.
 * Cached at module load so lookups remain O(1).
 */
const textureIdToVariant = (() => {
  const map = new Map<number, string>();
  for (const [variant, mapping] of Object.entries(
    (ENTITY_SPRITE_MAPPINGS as EntitySpriteMappings).enemies,
  )) {
    map.set(mapping.textureId, variant);
  }
  return map;
})();

/**
 * Map a `Sprite.textureId` variant to the enemy visual type understood by the
 * texture resolver. Used both to refine a live `'enemy'` into its rat/slime
 * variant and as the corpse-explosion texture fallback when the dying enemy's
 * on-screen visual is no longer available.
 */
export function enemyVariantFromTextureId(textureId: number | undefined): string {
  if (textureId === undefined) return 'enemy';
  const variant = textureIdToVariant.get(textureId);
  return variant ?? 'enemy';
}

/**
 * Refine a non-boss enemy entity's render kind: if the entity carries a
 * {@link Spawner} component and its texture maps to a rat or slime variant,
 * return the dedicated spawner visual kind (`'enemy_spawner_rats_nest'` /
 * `'enemy_spawner_slime_pool'`) so the engine resolves dedicated nest/pool art
 * instead of reusing the mob's own sprite. For all other enemies the broad
 * variant from {@link enemyVariantFromTextureId} is returned unchanged.
 *
 * Pure — only reads ECS component presence and the `sprite.textureId` store —
 * so it can be unit-tested directly with `createTestWorld()`, no Phaser scene
 * required (mirrors the design of {@link resolveRenderKind}).
 */
export function refineEnemyVisualKind(world: RenderKindWorld, eid: number): string {
  const enemyVariant = enemyVariantFromTextureId(world.stores.sprite.textureId[eid]);
  if (hasComponent(world.ecs, eid, Spawner)) {
    if (enemyVariant === 'enemy_rat') return 'enemy_spawner_rats_nest';
    if (enemyVariant === 'enemy_slime') return 'enemy_spawner_slime_pool';
  }
  return enemyVariant;
}

/**
 * Bright-red multiply tint painted over *placeholder* spawner structures.
 * Spawners without dedicated nest/pool art reuse enemy sprites, so this red wash
 * keeps them visually distinct from the mobs they emit.
 */
export const PLACEHOLDER_SPAWNER_TINT = 0xff3030;
/** Multiply tint for Rat Brute variants (darker than baseline rats). */
export const RAT_BRUTE_TINT = 0x666666;

/**
 * Resolve the placeholder tint for an entity: {@link PLACEHOLDER_SPAWNER_TINT}
 * for a {@link Spawner} structure (no dedicated art yet), or `null` for
 * everything else. Pure — takes only the ECS handle — so it is unit-testable
 * without a Phaser scene; the caller applies the result via
 * `img.setTint` / `img.clearTint`.
 */
export function placeholderSpawnerTint(ecs: GameWorld['ecs'], eid: number): number | null {
  return hasComponent(ecs, eid, Spawner) ? PLACEHOLDER_SPAWNER_TINT : null;
}

/**
 * Resolve per-enemy tint from live state + appearance identity.
 *
 * Priority is load-bearing:
 * 1) spawner placeholder red wins over everything else,
 * 2) Rat Brute receives a darker-grey tint,
 * 3) all other enemies are un-tinted (`null`).
 */
export function enemyAppearanceTint(
  ecs: GameWorld['ecs'],
  eid: number,
  appearanceKey?: string,
  visualType?: string,
): number | null {
  const hasDedicatedSpawnerArt =
    visualType === 'enemy_spawner_rats_nest' || visualType === 'enemy_spawner_slime_pool';
  if (hasDedicatedSpawnerArt) {
    return appearanceKey === 'rat-brute' ? RAT_BRUTE_TINT : null;
  }
  const spawnerTint = placeholderSpawnerTint(ecs, eid);
  if (spawnerTint !== null) return spawnerTint;
  return appearanceKey === 'rat-brute' ? RAT_BRUTE_TINT : null;
}

/** Result of {@link computeEnemyScale}: the live X/Y render scale for an enemy. */
export interface EnemyScale {
  readonly scaleX: number;
  readonly scaleY: number;
}

/**
 * Structural slice of {@link GameWorld} that {@link computeEnemyScale} reads:
 * the ECS handle (for the `SpawnAnim` probe), the floor archetype map (for the
 * `slime-mini` size class), and the `sprite.width` / `spawnAnim` stores.
 */
export interface EnemyScaleWorld {
  readonly ecs: GameWorld['ecs'];
  readonly floorScenario: { readonly enemyArchetypes: ReadonlyMap<number, string> } | null;
  readonly stores: {
    readonly sprite: {
      readonly width: ArrayLike<number>;
      readonly sizeScale: ArrayLike<number>;
    };
    readonly spawnAnim: {
      readonly remainingMs: ArrayLike<number>;
      readonly totalMs: ArrayLike<number>;
    };
  };
}

/**
 * Compute the live render scale for an enemy: baby slimes render proportionally
 * smaller than a full slime, and any enemy mid-spawn plays the "pop out +
 * wiggle" animation (smaller → overshoot → settle) on top of that. Pure mirror
 * of the original `applyEnemyScale` math (the caller applies the result via
 * `img.setScale`).
 */
export function computeEnemyScale(
  world: EnemyScaleWorld,
  eid: number,
  baseScale: number,
): EnemyScale {
  let scaleX = baseScale;
  let scaleY = baseScale;
  const sizeScale = world.stores.sprite.sizeScale[eid] || 1;
  scaleX *= sizeScale;
  scaleY *= sizeScale;

  // Baby slimes carry a shrunken Sprite.width; render them at the matching
  // fraction of a full slime. Scoped to the 'slime-mini' archetype so full
  // slimes, rats, and slime-textured bosses are untouched.
  if (world.floorScenario?.enemyArchetypes.get(eid) === 'slime-mini') {
    const width = world.stores.sprite.width[eid] ?? SLIME_FULL_SPRITE_WIDTH;
    const sizeMul = Math.max(0.2, Math.min(1, width / SLIME_FULL_SPRITE_WIDTH));
    scaleX *= sizeMul;
    scaleY *= sizeMul;
  }

  // Spawn-in pop + jelly wiggle while the SpawnAnim timer is running.
  if (hasComponent(world.ecs, eid, SpawnAnim)) {
    const progress = spawnAnimProgress(
      world.stores.spawnAnim.remainingMs[eid] ?? 0,
      world.stores.spawnAnim.totalMs[eid] ?? 0,
    );
    const pop = computeSpawnPopScale(progress);
    scaleX *= pop.x;
    scaleY *= pop.y;
  }

  return { scaleX, scaleY };
}

function normalizeVariantRoll(variantRoll: number | undefined): number {
  if (variantRoll === undefined || !Number.isFinite(variantRoll)) {
    return 0;
  }
  return Math.min(0.999999, Math.max(0, variantRoll));
}

// generatedBriefIdForEnemy is re-exported from src/shared/generated-assets.ts.
export { generatedBriefIdForEnemy };

/**
 * Generated-sprite briefId for each Floor 1 harvestable node def id.
 *
 * On-floor harvestable *world nodes* resolve their art through this explicit
 * map — mirroring {@link GENERATED_BRIEF_BY_TYPE} for enemies — rather than by
 * the bare item id. The `-v1` namespace deliberately keeps node art in its own
 * lane, separate from the inventory *item icon* surface (which resolves by bare
 * `itemId === briefId`): the two surfaces are authored and wired independently,
 * and a bare-id key here would additionally collide with the reusable
 * `azure-mushroom-v1` brief. Keys are `HarvestableDef.id` values from
 * `src/shared/harvestableDefs.ts`.
 */
const GENERATED_BRIEF_BY_HARVESTABLE: Readonly<Record<string, string>> = {
  'crimson-mushroom': 'crimson-mushroom-v1',
  'azure-mushroom': 'azure-mushroom-v1',
  'sunpetal-flower': 'sunpetal-flower-v1',
  'moonbloom-flower': 'moonbloom-flower-v1',
  'frost-lichen': 'frost-lichen-v1',
  'shadow-lichen': 'shadow-lichen-v1',
  // Floor 2: industrial-cave ore / gem nodes (indices 6–8).
  'iron-vein': 'iron-vein-v1',
  'copper-seam': 'copper-seam-v1',
  'gem-cluster': 'gem-cluster-v1',
};

/**
 * Resolve the generated-sprite briefId for a harvestable node def id, or
 * `undefined` when the node type has no wired art (the renderer then falls back
 * to the procedural tinted circle). Pure — reads only the static map — so it is
 * unit-testable without a Phaser scene, mirroring {@link generatedBriefIdForEnemy}.
 */
export function generatedBriefIdForHarvestable(defId: string): string | undefined {
  return GENERATED_BRIEF_BY_HARVESTABLE[defId];
}

export function pickGeneratedEnemyTextureKey(
  registry: GeneratedSpriteRegistry | null | undefined,
  type: string,
  variantRoll: number | undefined,
  appearanceKey?: string,
): string | null {
  if (registry === null || registry === undefined) {
    return null;
  }
  const briefId = generatedBriefIdForEnemy(type, appearanceKey);
  if (briefId === undefined) {
    return null;
  }
  const variants = registry.variants(briefId);
  if (variants.length === 0) {
    return null;
  }
  const index = Math.floor(normalizeVariantRoll(variantRoll) * variants.length);
  return variants[index]?.textureKey ?? null;
}

/**
 * Pinned generated texture key per welcome-room NPC def id ({@link NpcDef.id}).
 *
 * NPCs resolve their generated art def-aware — by NPC def id — rather than via
 * a variant roll like enemies, because the shipped variants differ per NPC: the
 * approved variants are `var-1` for the Goon and Spell Broker and `var-3` for
 * the Merchant. Computing a variant index from a roll would therefore mis-pick
 * every one of them. Values are the BARE manifest keys, which preload as
 * individual Phaser textures (verified for the welcome-room set-piece props in
 * PR #905) — so a caller only needs `scene.textures.exists(key)` to gate on
 * availability.
 *
 * The Goon and Merchant point at `-v3-` regenerations: their `npc-*-var-0`
 * predecessors shipped skin painted in the palette's saturated warm accent
 * (see `docs/agent-os/sprite-style.md`).
 *
 * The mapping itself lives in `src/shared/data/npc-sprite-map.json` because the
 * Set Piece Editor extension (standalone `.mjs`, cannot import TypeScript) has
 * to resolve the same NPC art. It previously kept its own copy, which went stale
 * the moment these two were repointed at `-v3-` — so the editor rendered
 * already-replaced sprites and every screenshot taken from it was wrong.
 */
export const GENERATED_KEY_BY_NPC_DEF: Readonly<Record<string, string>> = npcSpriteMap.byNpcDefId;

/**
 * Resolve the pinned generated texture key for an NPC def id, or `null` when
 * the def has no dedicated generated art (the caller then falls back to the
 * shared Kenney villager). Pure — no Phaser scene, no registry — so it is
 * unit-testable in isolation (mirrors {@link enemyVariantFromTextureId}).
 */
export function pickGeneratedNpcTextureKey(defId: string | undefined): string | null {
  if (defId === undefined) {
    return null;
  }
  return GENERATED_KEY_BY_NPC_DEF[defId] ?? null;
}

/**
 * Resolve the generated-sprite `textureKey` for a harvestable node def id, or
 * `null` when there is no registry, no wired briefId, or no approved variant
 * (the renderer then falls back to the procedural tinted circle). Deterministic
 * for a given `variantRoll` and pure (no Phaser scene) — mirrors
 * {@link pickGeneratedEnemyTextureKey} so it is unit-testable in isolation.
 */
export function pickGeneratedHarvestableTextureKey(
  registry: GeneratedSpriteRegistry | null | undefined,
  defId: string | undefined,
  variantRoll: number | undefined,
): string | null {
  if (registry === null || registry === undefined || defId === undefined) {
    return null;
  }
  const briefId = generatedBriefIdForHarvestable(defId);
  if (briefId === undefined) {
    return null;
  }
  const variants = registry.variants(briefId);
  if (variants.length === 0) {
    return null;
  }
  const index = Math.floor(normalizeVariantRoll(variantRoll) * variants.length);
  return variants[index]?.textureKey ?? null;
}
