import { hasComponent, query } from 'bitecs';
import {
  DeathTimer,
  Enemy,
  EnemyBehavior,
  Health,
  Player,
  Position,
} from '../../core/components.js';
import { isEnemyHostileToPlayer } from '../../core/enemy-targeting.js';
import { bandFor, getRelation } from '../../core/faction-relations.js';
import { isPointInSafeSpace } from '../../core/safe-space.js';
import type { GameWorld } from '../../core/world.js';
import { getCompanionAIDecision } from '../systems/companionAISystem.js';
import { getFamilyAIDecision, getMobFamilyId } from '../systems/familyFeudSystem.js';
import type { CombatPressureObservation } from '../../shared/combat-pressure-types.js';

/**
 * Descriptive spatial hypothesis: an active player-hostile mob with direct LOS
 * within max(12 ft, min(authored attack range, 32 ft)) is locally actionable.
 * This is not a damage forecast: cooldowns, stun, support abilities, projectiles
 * already in flight, environmental hazards and indirect/path-around threats
 * are not modeled. A missing map means an open arena (the AI's own convention).
 * Call after the simulation's faction/companion AI prepasses. No world mutation.
 */
export function observeCombatPressure(
  world: GameWorld,
  playerEid: number,
  safeOverride = false,
): CombatPressureObservation {
  const { position, health, enemyBehavior } = world.stores;
  const x = position.x[playerEid]!;
  const y = position.y[playerEid]!;
  const currentHealth = health.current[playerEid]!;
  const maxHealth = health.max[playerEid]!;
  const valid =
    hasComponent(world.ecs, playerEid, Player) &&
    hasComponent(world.ecs, playerEid, Position) &&
    hasComponent(world.ecs, playerEid, Health) &&
    [x, y, currentHealth, maxHealth, world.elapsedMs].every(Number.isFinite) &&
    currentHealth >= 0 &&
    maxHealth > 0 &&
    world.elapsedMs >= 0;
  const safe =
    safeOverride ||
    world.playerInSafeRoom ||
    world.state === 'safe_room' ||
    (world.floorId === 'floor4' &&
      world.floorExtendedState?.floor4Arena?.phase.kind === 'COUNTDOWN') ||
    (valid && isPointInSafeSpace(world, x, y));
  const observation: CombatPressureObservation = {
    elapsedMs: world.elapsedMs,
    safe,
    valid,
    localThreatCount: 0,
    health: currentHealth,
    maxHealth,
  };
  if (!valid || safe) return observation;

  const encounters = world.floorExtendedState?.familyState?.bossEncounters;
  const inactiveBosses = new Set(
    [...(encounters?.values() ?? [])]
      .filter((encounter) => !encounter.started)
      .map((encounter) => encounter.bossEid),
  );
  for (const eid of query(world.ecs, [Enemy, EnemyBehavior, Position, Health])) {
    if (
      hasComponent(world.ecs, eid, DeathTimer) ||
      health.current[eid]! <= 0 ||
      !isEnemyHostileToPlayer(world, eid) ||
      inactiveBosses.has(eid)
    )
      continue;
    const companion = getCompanionAIDecision(world, eid);
    const family = getFamilyAIDecision(world, eid);
    if (companion?.bypassPlayerDetection || family?.bypassPlayerDetection) continue;
    const familyId = getMobFamilyId(world, eid);
    if (familyId !== undefined) {
      const encounter = encounters?.get(familyId);
      const activeBoss = encounter?.bossEid === eid && encounter.started && !encounter.defeated;
      const band = bandFor(getRelation(world, familyId));
      if (!activeBoss && band !== 'hate' && band !== 'hostile') continue;
    }
    const enemyX = position.x[eid]!;
    const enemyY = position.y[eid]!;
    const attackRange = enemyBehavior.attackRange[eid]!;
    const aggroRange = enemyBehavior.aggroRange[eid]!;
    const enableAt = enemyBehavior.aggroEnableAtMs[eid] ?? 0;
    if (
      ![enemyX, enemyY, health.current[eid], attackRange, aggroRange, enableAt].every(
        Number.isFinite,
      )
    ) {
      observation.valid = false;
      continue;
    }
    if (world.elapsedMs < enableAt) continue;
    const distance = Math.hypot(enemyX - x, enemyY - y);
    if (distance > Math.max(12, Math.min(32, attackRange))) continue;
    if (aggroRange > 0 && distance > aggroRange && enemyBehavior.aggroedPermanently[eid] !== 1)
      continue;
    if (world.floorMap && !world.floorMap.hasLineOfSight(enemyX, enemyY, x, y)) continue;
    observation.localThreatCount += 1;
  }
  return observation;
}
