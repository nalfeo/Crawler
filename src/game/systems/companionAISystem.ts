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

/** Sets a floor-specific target override consumed by enemyAISystem this frame. */
export function setCompanionAIDecision(
  world: GameWorld,
  eid: number,
  decision: CompanionAIDecision,
): void {
  const decisions = decisionsByWorld.get(world) ?? new Map<number, CompanionAIDecision>();
  decisions.set(eid, decision);
  decisionsByWorld.set(world, decisions);
}

/** Test/lab helper to clear cached companion decisions. */
export function resetCompanionAIState(world: GameWorld): void {
  decisionsByWorld.delete(world);
}

export function companionAISystem(world: GameWorld): void {
  const players = query(world.ecs, [Player, Position]);
  const playerEid = players[0];
  const decisions = decisionsByWorld.get(world) ?? new Map<number, CompanionAIDecision>();
  const previousDecisions = new Map(decisions);
  decisions.clear();
  decisionsByWorld.set(world, decisions);
  if (playerEid === undefined) return;

  const playerX = world.stores.position.x[playerEid] ?? 0;
  const playerY = world.stores.position.y[playerEid] ?? 0;
  const leash = tuning.factionRelations.friendlyLeashTiles;
  const rivalRangeFt = tuning.factionRelations.feudEngagementRadiusTiles * 4;
  const rivalRangeSq = rivalRangeFt * rivalRangeFt;
  const companions = query(world.ecs, [Enemy, Companion, Position]);
  const candidates = query(world.ecs, [Enemy, Position, Team]);

  // Ranged/support archetypes are the only ones stamped with a positive
  // `attackRange` (see floor3Scenario.ts's recruit/spawn helpers) — they kite
  // away from anything inside their retreat band (buildRangedPathTarget /
  // buildSupportPathTarget in enemyAISystem.ts) rather than closing distance.
  // A melee attacker (attackRange <= 0) can never corner one of these on its
  // own, so it must not get target-locked onto an uncatchable kiter while a
  // catchable rival is available.
  const isEvasiveRival = (candidateEid: number): boolean =>
    (world.stores.enemyBehavior.attackRange[candidateEid] ?? 0) > 0;

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
    const isMeleeAttacker = (world.stores.enemyBehavior.attackRange[eid] ?? 0) <= 0;

    // Target-lock: a rival recomputed strictly-nearest every single frame
    // thrashes between several similarly-close mobs, spreading hits across
    // all of them instead of concentrating fire on one — the companion can
    // then chase forever without ever landing a kill. Keep the previous
    // frame's rival target as long as it is still alive, in range, and (for
    // a melee attacker) not an uncatchable kiter that a fresh scan would
    // otherwise avoid; only fall through to a new nearest-rival scan once it
    // dies, is knocked out, leaves engagement range, or is an evasive target
    // this attacker can never actually reach.
    const previous = previousDecisions.get(eid);
    if (previous?.kind === 'rival-primary' && previous.targetEid !== undefined) {
      const lockedEid = previous.targetEid;
      const stillValid =
        candidates.includes(lockedEid) &&
        !hasComponent(world.ecs, lockedEid, DeathTimer) &&
        (world.stores.team.id[lockedEid] ?? 0) !== teamId &&
        !(
          hasComponent(world.ecs, lockedEid, Companion) &&
          (world.stores.companion.knockedOut[lockedEid] ?? 0) === 1
        ) &&
        !(isMeleeAttacker && isEvasiveRival(lockedEid));
      if (stillValid) {
        const lx = world.stores.position.x[lockedEid] ?? 0;
        const ly = world.stores.position.y[lockedEid] ?? 0;
        const dx = lx - x;
        const dy = ly - y;
        if (dx * dx + dy * dy <= rivalRangeSq) {
          decisions.set(eid, {
            x: lx,
            y: ly,
            kind: 'rival-primary',
            targetEid: lockedEid,
            bypassPlayerDetection: true,
          });
          continue;
        }
      }
    }

    let nearestRival: { eid: number; x: number; y: number; d2: number } | null = null;
    let nearestEvasiveRival: { eid: number; x: number; y: number; d2: number } | null = null;
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
      if (d2 > rivalRangeSq) continue;
      // A melee attacker prefers any catchable (non-evasive) rival over an
      // evasive one, regardless of raw distance, since it can never close on
      // a kiter; keep the nearest evasive candidate only as a last resort.
      if (isMeleeAttacker && isEvasiveRival(other)) {
        if (
          nearestEvasiveRival === null ||
          d2 < nearestEvasiveRival.d2 ||
          (d2 === nearestEvasiveRival.d2 && other < nearestEvasiveRival.eid)
        ) {
          nearestEvasiveRival = { eid: other, x: ox, y: oy, d2 };
        }
        continue;
      }
      if (
        nearestRival === null ||
        d2 < nearestRival.d2 ||
        (d2 === nearestRival.d2 && other < nearestRival.eid)
      ) {
        nearestRival = { eid: other, x: ox, y: oy, d2 };
      }
    }

    const chosenRival = nearestRival ?? nearestEvasiveRival;
    if (chosenRival !== null) {
      decisions.set(eid, {
        x: chosenRival.x,
        y: chosenRival.y,
        kind: 'rival-primary',
        targetEid: chosenRival.eid,
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
