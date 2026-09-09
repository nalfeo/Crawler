import { hasComponent, query } from 'bitecs';
import { Companion, DeathTimer, Enemy, Position, Team } from '../../core/components.js';
import { isFloor3WildEnemyHostile } from '../../core/enemy-targeting.js';
import type { GameWorld } from '../../core/world.js';
import { TeamId } from '../../shared/constants.js';
import { setCompanionAIDecision } from './companionAISystem.js';
import { FLOOR3_WILD_AGGRO_RANGE_FT, updateFloor3WildHostility } from './floor3WildHostility.js';

/** Makes Floor 3 wilds engage the player's Companions instead of the Wrangler. */
export function floor3WildTargetRedirectSystem(world: GameWorld): void {
  updateFloor3WildHostility(world);
  const party = query(world.ecs, [Companion, Enemy, Position, Team]).filter(
    (eid) =>
      !hasComponent(world.ecs, eid, DeathTimer) &&
      (world.stores.companion.knockedOut[eid] ?? 0) === 0 &&
      (world.stores.team.id[eid] ?? 0) === TeamId.PLAYER,
  );
  if (party.length === 0) return;
  const companionEngagementRangeSq = FLOOR3_WILD_AGGRO_RANGE_FT * FLOOR3_WILD_AGGRO_RANGE_FT;

  for (const eid of query(world.ecs, [Enemy, Position, Team])) {
    if (
      hasComponent(world.ecs, eid, Companion) ||
      hasComponent(world.ecs, eid, DeathTimer) ||
      (world.stores.team.id[eid] ?? 0) !== TeamId.ENEMY ||
      !isFloor3WildEnemyHostile(world, eid)
    ) {
      continue;
    }
    const x = world.stores.position.x[eid] ?? 0;
    const y = world.stores.position.y[eid] ?? 0;
    let targetEid = party[0]!;
    let bestDistanceSq = Number.POSITIVE_INFINITY;
    for (const companion of party) {
      const dx = (world.stores.position.x[companion] ?? 0) - x;
      const dy = (world.stores.position.y[companion] ?? 0) - y;
      const distanceSq = dx * dx + dy * dy;
      if (distanceSq < bestDistanceSq || (distanceSq === bestDistanceSq && companion < targetEid)) {
        targetEid = companion;
        bestDistanceSq = distanceSq;
      }
    }
    // Do not make a wild chase a party member that is off-screen or otherwise
    // far away. Leaving the decision unset preserves the normal hostile
    // player target, while nearby companions still absorb the engagement as
    // intended. This also prevents a wild encounter from pulling the party
    // across the overworld toward a lagging companion.
    if (bestDistanceSq > companionEngagementRangeSq) continue;
    setCompanionAIDecision(world, eid, {
      x: world.stores.position.x[targetEid] ?? 0,
      y: world.stores.position.y[targetEid] ?? 0,
      kind: 'rival-primary',
      targetEid,
      bypassPlayerDetection: true,
    });
  }
}
