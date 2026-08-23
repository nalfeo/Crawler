import { hasComponent, query } from 'bitecs';
import { Companion, DeathTimer, Enemy, Player, Position, Team } from '../../core/components.js';
import type { GameWorld } from '../../core/world.js';
import { TeamId } from '../../shared/constants.js';
import tuning from '../../shared/data/tuning.json';

export type CompanionTargetKind = 'rival-primary' | 'follow' | 'idle' | 'disabled';

export interface CompanionAIDecision {
  x: number;
  y: number;
  kind: CompanionTargetKind;
  targetEid: number | undefined;
  bypassPlayerDetection: true;
}

const decisionsByWorld = new WeakMap<GameWorld, Map<number, CompanionAIDecision>>();

/** Public read: the last companion AI decision computed for `eid`. */
export function getCompanionAIDecision(
  world: GameWorld,
  eid: number,
): CompanionAIDecision | undefined {
  return decisionsByWorld.get(world)?.get(eid);
}

/** Test/lab helper to clear cached companion decisions. */
export function resetCompanionAIState(world: GameWorld): void {
  decisionsByWorld.delete(world);
}

export function companionAISystem(world: GameWorld): void {
  const players = query(world.ecs, [Player, Position]);
  const playerEid = players[0];
  const decisions = decisionsByWorld.get(world) ?? new Map<number, CompanionAIDecision>();
  decisions.clear();
  decisionsByWorld.set(world, decisions);
  if (playerEid === undefined) return;

  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const leash = tuning.factionRelations.friendlyLeashTiles;
  const companions = query(world.ecs, [Enemy, Companion, Position]);
  const candidates = query(world.ecs, [Enemy, Position, Team]);

  for (const eid of companions) {
    if (hasComponent(world.ecs, eid, DeathTimer)) continue;
    if ((world.stores.companion.knockedOut[eid] ?? 0) === 1) {
      decisions.set(eid, {
        x: world.stores.position.x[eid] ?? 0,
        y: world.stores.position.y[eid] ?? 0,
        kind: 'disabled',
        targetEid: undefined,
        bypassPlayerDetection: true,
      });
      continue;
    }
    if (!hasComponent(world.ecs, eid, Team)) continue;

    const teamId = world.stores.team.id[eid] ?? 0;
    const x = world.stores.position.x[eid] ?? 0;
    const y = world.stores.position.y[eid] ?? 0;

    let nearestRival: { eid: number; x: number; y: number; d2: number } | null = null;
    for (const other of candidates) {
      if (other === eid) continue;
      if (hasComponent(world.ecs, other, DeathTimer)) continue;
      if ((world.stores.team.id[other] ?? 0) === teamId) continue;
      if (
        hasComponent(world.ecs, other, Companion) &&
        (world.stores.companion.knockedOut[other] ?? 0) === 1
      ) {
        continue;
      }
      const ox = world.stores.position.x[other] ?? 0;
      const oy = world.stores.position.y[other] ?? 0;
      const dx = ox - x;
      const dy = oy - y;
      const d2 = dx * dx + dy * dy;
      if (
        nearestRival === null ||
        d2 < nearestRival.d2 ||
        (d2 === nearestRival.d2 && other < nearestRival.eid)
      ) {
        nearestRival = { eid: other, x: ox, y: oy, d2 };
      }
    }

    if (nearestRival !== null) {
      decisions.set(eid, {
        x: nearestRival.x,
        y: nearestRival.y,
        kind: 'rival-primary',
        targetEid: nearestRival.eid,
        bypassPlayerDetection: true,
      });
      continue;
    }

    // Only the player's OWN party (Team.id === TeamId.PLAYER) follows the
    // player when idle — an NPC-owned roster (Studio/Final-Four Companion,
    // any other team) has no owner to follow and MUST hold its assigned
    // territory instead. Without this guard, every hostile roster on the
    // floor eventually converges on wherever the player currently stands
    // once it runs out of nearby rivals (plan-review finding, slice 8): the
    // 'follow' decision sets `bypassPlayerDetection: true`, which makes
    // `enemyAISystem` treat the Companion as permanently aggroed on the real
    // player regardless of range/line-of-sight/room gating.
    if (teamId === TeamId.PLAYER) {
      const dx = playerX - x;
      const dy = playerY - y;
      const dist = Math.hypot(dx, dy);
      if (dist > leash) {
        decisions.set(eid, {
          x: playerX,
          y: playerY,
          kind: 'follow',
          targetEid: playerEid,
          bypassPlayerDetection: true,
        });
        continue;
      }
    }
    decisions.set(eid, {
      x,
      y,
      kind: 'idle',
      targetEid: undefined,
      bypassPlayerDetection: true,
    });
  }
}
