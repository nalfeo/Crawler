import { hasComponent } from 'bitecs';
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
import type { GeneratedSpriteRegistry } from '../../shared/generated-assets.js';
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
 * Bright-red multiply tint painted over placeholder spawner structures (Rats
 * Nest / Slime Pool). Spawners currently reuse their child mob's sprite
 * (`enemy_rat` / `enemy_slime`) because no dedicated nest/pool art exists yet,
 * so without a wash they are indistinguishable from the very mobs they emit.
 * The red makes them read as obviously-different placeholders in-world. Kept
 * slightly off pure red (a little green/blue survives the multiply) so dark
 * source pixels still read as *bright* red rather than near-black.
 *
 * Retire this once real spawner art lands (see {@link generatedBriefIdForEnemy}).
 */
export const PLACEHOLDER_SPAWNER_TINT = 0xff3030;

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

const GENERATED_BRIEF_BY_TYPE: Readonly<Record<string, string>> = {
  enemy_rat: 'rat-v1',
  enemy_slime: 'slime-v1',
  enemy_boss_ratslime: 'rat-slime-v1',
};

const GENERATED_BRIEF_BY_APPEARANCE_KEY: Readonly<Record<string, string>> = {
  rat: 'rat-v1',
  slime: 'slime-v1',
  'slime-mini': 'baby-slime-v1',
  'rat-slime': 'rat-slime-v1',
};

function normalizeVariantRoll(variantRoll: number | undefined): number {
  if (variantRoll === undefined || !Number.isFinite(variantRoll)) {
    return 0;
  }
  return Math.min(0.999999, Math.max(0, variantRoll));
}

export function generatedBriefIdForEnemy(type: string, appearanceKey?: string): string | undefined {
  if (appearanceKey !== undefined) {
    const byAppearance = GENERATED_BRIEF_BY_APPEARANCE_KEY[appearanceKey];
    if (byAppearance !== undefined) {
      return byAppearance;
    }
  }
  return GENERATED_BRIEF_BY_TYPE[type];
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
