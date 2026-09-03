import { hasComponent, query } from 'bitecs';
import { applyDamage } from '../../core/apply-damage.js';
import { Companion, DeathTimer, Enemy, Position, Team } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { STAT_BAND_SCALE, stylePersona } from '../../shared/data/floor3/styles.js';
import { speciesForToken } from '../../shared/data/floor3/species.js';
import { getCompanionAIDecision } from './companionAISystem.js';

const MELEE_RANGE_FT = 3;
const BASE_DAMAGE = 10;
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

/** Resolves the Floor 3 party's auto-attacks after companion targeting. */
export function companionCombatSystem(world: GameWorld): void {
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
    applyDamage(
      world,
      target,
      BASE_DAMAGE * STAT_BAND_SCALE[persona.dmgProfile],
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
