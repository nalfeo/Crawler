import { hasComponent, query } from 'bitecs';
import { applyDamage } from '../../core/apply-damage.js';
import {
  Companion,
  DeathTimer,
  Enemy,
  Position,
  ProjectileVisualKind,
  Team,
} from '../../core/components.js';
import { tagDamageMeta } from '../../core/damage-meta.js';
import { spawnEnemyProjectile } from '../../core/helpers.js';
import type { GameWorld } from '../../core/world.js';
import { STAT_BAND_SCALE, stylePersona } from '../../shared/data/floor3/styles.js';
import { speciesForToken } from '../../shared/data/floor3/species.js';
import { companionGrowthScales } from '../../shared/data/floor3/growth.js';
import { learnedCompanionAttacks } from '../../shared/data/floor3/combat-abilities.js';
import { TeamId, ENEMY_PROJECTILE } from '../../shared/constants.js';
import tuning from '../../shared/data/tuning.json';
import { normalize } from '../../shared/vec.js';
import { getCompanionAIDecision } from './companionAISystem.js';

const MELEE_RANGE_FT = 3;
const BASE_DAMAGE = 10;
/**
 * Floor-3-ONLY companion buff (human-authorized, session 2026-09-03):
 * outgoing damage multiplier applied only to the player's own party
 * Companions (`TeamId.PLAYER`), compensating for the party's structural
 * numbers disadvantage against multi-Companion Studio/Final-Four rosters.
 * Wild and rival roster Companions deal unmodified damage. Tunable via
 * `tuning.floor3Companion.playerCompanionDamageMultiplier`; see
 * `floor3-companion-lab` for the explorable knob.
 */
const PLAYER_COMPANION_DAMAGE_MULTIPLIER = tuning.floor3Companion.playerCompanionDamageMultiplier;
export interface CompanionAttackState {
  readonly generation: number;
  readonly lastAttackMs: number;
  readonly cooldownMs: number;
  readonly successfulAttacks: number;
  readonly lastAbilityId: string | undefined;
}

const lastAttackByWorld = new WeakMap<GameWorld, Map<number, CompanionAttackState>>();

/** Read-only combat observation for the production lab; never creates state. */
export function _getCompanionAttackState(
  world: GameWorld,
  eid: number,
): CompanionAttackState | undefined {
  const state = lastAttackByWorld.get(world)?.get(eid);
  return hasComponent(world.ecs, eid, Companion) &&
    state?.generation === (world.entityRenderGeneration[eid] ?? 0)
    ? state
    : undefined;
}

function lastAttacks(world: GameWorld): Map<number, CompanionAttackState> {
  let attacks = lastAttackByWorld.get(world);
  if (attacks === undefined) {
    attacks = new Map();
    lastAttackByWorld.set(world, attacks);
  }
  return attacks;
}

/**
 * Resolves the Floor 3 party's auto-attacks after companion targeting.
 *
 * The optional multiplier is a designer-lab seam: production callers omit it
 * and therefore use tuning.json, while the Floor 3 companion lab can exercise
 * this exact system with an interactive lil-gui value.
 */
export function companionCombatSystem(
  world: GameWorld,
  playerCompanionDamageMultiplier = PLAYER_COMPANION_DAMAGE_MULTIPLIER,
): void {
  const attacks = lastAttacks(world);
  const companions = query(world.ecs, [Companion, Enemy, Position, Team]);
  const liveCompanions = new Set(companions);

  for (const eid of companions) {
    if (
      hasComponent(world.ecs, eid, DeathTimer) ||
      (world.stores.health.current[eid] ?? 0) <= 0 ||
      (world.stores.companion.knockedOut[eid] ?? 0) === 1
    ) {
      continue;
    }
    const target = getCompanionAIDecision(world, eid)?.targetEid;
    if (
      target === undefined ||
      !hasComponent(world.ecs, target, Enemy) ||
      hasComponent(world.ecs, target, DeathTimer) ||
      (world.stores.health.current[target] ?? 0) <= 0 ||
      (hasComponent(world.ecs, target, Companion) &&
        (world.stores.companion.knockedOut[target] ?? 0) === 1) ||
      (hasComponent(world.ecs, target, Team) &&
        (world.stores.team.id[target] ?? 0) === (world.stores.team.id[eid] ?? 0))
    ) {
      continue;
    }

    const species = speciesForToken(world.stores.companion.speciesToken[eid] ?? 0);
    if (species === undefined) continue;
    const persona = stylePersona(species.fightingStyle);
    const floor3 = world.floorId === 'floor3';
    const level = world.stores.companion.level[eid] ?? 1;
    const growth = floor3 ? companionGrowthScales(species, level) : undefined;
    const storedAttackRange = world.stores.enemyBehavior.attackRange[eid] ?? 0;
    const rangedAttack = storedAttackRange > 0;
    // Ranged reach is already scaled in the spawn/progression pipeline. Keep
    // the melee store at zero: the targeting AI uses it to identify kiters.
    const attackRange = rangedAttack
      ? storedAttackRange
      : MELEE_RANGE_FT * (growth?.rangeScale ?? 1);
    const dx = (world.stores.position.x[target] ?? 0) - (world.stores.position.x[eid] ?? 0);
    const dy = (world.stores.position.y[target] ?? 0) - (world.stores.position.y[eid] ?? 0);
    if (dx * dx + dy * dy > attackRange * attackRange) continue;

    const generation = world.entityRenderGeneration[eid] ?? 0;
    const storedPrevious = attacks.get(eid);
    const previous = storedPrevious?.generation === generation ? storedPrevious : undefined;
    if (previous && world.elapsedMs - previous.lastAttackMs < previous.cooldownMs) continue;
    const successfulAttacks = previous?.successfulAttacks ?? 0;
    const learned = floor3 ? learnedCompanionAttacks(species, level) : [];
    const ability = learned[successfulAttacks % learned.length];
    const cooldownMs = (1000 / persona.cadence) * (ability?.cooldownMultiplier ?? 1);
    const nextAttackState: CompanionAttackState = {
      generation,
      lastAttackMs: world.elapsedMs,
      cooldownMs,
      successfulAttacks: successfulAttacks + 1,
      lastAbilityId: ability?.abilityId,
    };

    const defender = hasComponent(world.ecs, target, Companion)
      ? speciesForToken(world.stores.companion.speciesToken[target] ?? 0)
      : undefined;
    const attackerBuffMultiplier =
      world.floorId === 'floor3' && (world.stores.team.id[eid] ?? -1) === TeamId.PLAYER
        ? playerCompanionDamageMultiplier
        : 1;
    const projectileDamage =
      BASE_DAMAGE *
      STAT_BAND_SCALE[persona.dmgProfile] *
      attackerBuffMultiplier *
      (growth?.statScale ?? 1) *
      (ability?.damageMultiplier ?? 1);

    if (rangedAttack) {
      const sourceX = world.stores.position.x[eid] ?? 0;
      const sourceY = world.stores.position.y[eid] ?? 0;
      const dir = normalize(dx, dy);
      const targetX = world.stores.position.x[target] ?? 0;
      const targetY = world.stores.position.y[target] ?? 0;
      // A ranged shot only becomes a real flying projectile when there is
      // both (a) a direction to fire along — a point-blank target (dir.length
      // === 0, e.g. the AI catch-up fix walking a companion on top of its
      // target) has none — and (b) an unobstructed line of sight, since
      // Studio arenas can hold a companion and its locked rival within
      // Euclidean attack range but on opposite sides of a wall/ring boundary
      // while their positioning AI orbits at that range. Either case falls
      // through to the instant melee-style hit below instead of silently
      // dropping the attack forever: a companion that cannot draw a clean
      // shot must still be able to land a hit, and the cooldown is only ever
      // committed once an attack (projectile OR instant hit) actually
      // resolves.
      const hasLineOfSight =
        world.floorMap?.hasLineOfSight(sourceX, sourceY, targetX, targetY) ?? true;
      if (dir.length > 0 && hasLineOfSight) {
        const projectileEid = spawnEnemyProjectile(
          world,
          sourceX,
          sourceY,
          dir.x * ENEMY_PROJECTILE.SPEED,
          dir.y * ENEMY_PROJECTILE.SPEED,
          projectileDamage,
          eid,
          ProjectileVisualKind.BULLET,
        );
        // spawnEnemyProjectile already tags fail-closed enemy/unscaled damage
        // meta; re-tag with the Floor 3 Temperament pair so damageSystem's
        // delayed `applyProjectileHit` replays the same matchup multiplier
        // the instant melee path below applies immediately.
        tagDamageMeta(world, projectileEid, {
          origin: 'enemy',
          affinity: 'unscaled',
          scaleWithPrimary: false,
          canCrit: false,
          attackerTemperament: species.affinity,
          defenderTemperament: defender?.affinity,
        });
        attacks.set(eid, nextAttackState);
        continue;
      }
    }

    applyDamage(
      world,
      target,
      projectileDamage,
      world.stores.position.x[target] ?? 0,
      world.stores.position.y[target] ?? 0,
      {
        origin: 'enemy',
        affinity: 'physical',
        scaleWithPrimary: false,
        canCrit: false,
        sourceEid: eid,
        attackerTemperament: species.affinity,
        defenderTemperament: defender?.affinity,
      },
    );
    attacks.set(eid, nextAttackState);
  }

  for (const eid of attacks.keys()) {
    if (!liveCompanions.has(eid)) attacks.delete(eid);
  }
}
