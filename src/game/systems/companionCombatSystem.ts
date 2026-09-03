import { hasComponent, query } from 'bitecs';
import { applyDamage } from '../../core/apply-damage.js';
import { Companion, DeathTimer, Enemy, Position, Team } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { STAT_BAND_SCALE, stylePersona } from '../../shared/data/floor3/styles.js';
import { speciesForToken } from '../../shared/data/floor3/species.js';
import { TeamId } from '../../shared/constants.js';
import tuning from '../../shared/data/tuning.json';
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
interface CompanionAttackState {
  generation: number;
  lastAttackMs: number;
}

const lastAttackByWorld = new WeakMap<GameWorld, Map<number, CompanionAttackState>>();

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
      (world.stores.companion.knockedOut[eid] ?? 0) === 1
    ) {
      continue;
    }
    const target = getCompanionAIDecision(world, eid)?.targetEid;
    if (
      target === undefined ||
      !hasComponent(world.ecs, target, Enemy) ||
      hasComponent(world.ecs, target, DeathTimer) ||
      (hasComponent(world.ecs, target, Team) &&
        (world.stores.team.id[target] ?? 0) === (world.stores.team.id[eid] ?? 0))
    ) {
      continue;
    }

    const species = speciesForToken(world.stores.companion.speciesToken[eid] ?? 0);
    if (species === undefined) continue;
    const persona = stylePersona(species.fightingStyle);
    const storedAttackRange = world.stores.enemyBehavior.attackRange[eid] ?? 0;
    const attackRange = storedAttackRange > 0 ? storedAttackRange : MELEE_RANGE_FT;
    const dx = (world.stores.position.x[target] ?? 0) - (world.stores.position.x[eid] ?? 0);
    const dy = (world.stores.position.y[target] ?? 0) - (world.stores.position.y[eid] ?? 0);
    if (dx * dx + dy * dy > attackRange * attackRange) continue;

    const cooldownMs = 1000 / persona.cadence;
    const generation = world.entityRenderGeneration[eid] ?? 0;
    const previous = attacks.get(eid);
    const lastAttack = previous?.generation === generation ? previous.lastAttackMs : -cooldownMs;
    if (world.elapsedMs - lastAttack < cooldownMs) continue;

    const defender = hasComponent(world.ecs, target, Companion)
      ? speciesForToken(world.stores.companion.speciesToken[target] ?? 0)
      : undefined;
    const attackerBuffMultiplier =
      world.floorId === 'floor3' && (world.stores.team.id[eid] ?? -1) === TeamId.PLAYER
        ? playerCompanionDamageMultiplier
        : 1;
    applyDamage(
      world,
      target,
      BASE_DAMAGE * STAT_BAND_SCALE[persona.dmgProfile] * attackerBuffMultiplier,
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
    attacks.set(eid, { generation, lastAttackMs: world.elapsedMs });
  }

  for (const eid of attacks.keys()) {
    if (!liveCompanions.has(eid)) attacks.delete(eid);
  }
}
