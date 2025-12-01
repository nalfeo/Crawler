/**
 * Door-aware navigation interface.
 *
 * The runtime auto-opens any closed door within one tile of the player
 * (see {@link doorSystem}), so a closed-but-unlocked door is *not* an
 * obstacle — the AI just has to walk up to it. Plain A* over
 * `tileMap.isPassable`, however, treats every closed door as a wall and
 * therefore refuses to plan any route that crosses a room connection.
 *
 * This module exposes a "proper interface" over the door/lock model so the
 * AI can plan routes through doors it will be able to open, while still
 * treating genuinely locked doors (unlock condition not yet met) as walls.
 * It is forward-looking: lock state is re-evaluated from live conditions,
 * so a door flips from blocked to passable the instant its unlock goal/item
 * is achieved — naturally satisfying "only route back through once the AI
 * believes it can unlock it".
 *
 * Pure query/derivation helpers — no mutation, no rendering imports.
 */

import { query } from 'bitecs';
import { DoorState } from './components.js';
import {
  evaluateDoorConditionGroup,
  getDoorLockConfig,
  type DoorConditionGroup,
  type DoorLockConfig,
} from './door-lock.js';
import type { GameWorld } from './world.js';

/** What a locked door needs before it will open, flattened for AI goal-setting. */
export interface DoorUnlockRequirement {
  goalIds: string[];
  itemIds: string[];
  timerMs: number[];
}

export interface DoorNavInfo {
  eid: number;
  tileX: number;
  tileY: number;
  /** Intended-open LATCH (doorState.logicalOpen). Introspection only — no
   * navigation decision reads this; A* uses `navigationBlocked`. */
  logicalOpen: boolean;
  /** Last-reconciled physical/tile snapshot (doorState.effectiveOpen), derived by
   * `doorSystem` as logicalOpen && !isLocked && !isForcedClosed. Introspection
   * only — NOT guaranteed live: a floor authority can open a door tile after the
   * frame's `doorSystem` pass, so this mirror lags live `tileMap.isPassable(...)`
   * until the next reconcile. Callers needing current passability must read the
   * tile, not this field (see `getDoorRevision`). */
  effectiveOpen: boolean;
  isLocked: boolean;
  /**
   * Forward-looking traversal verdict: `true` when A* should treat this door
   * tile as a wall because the player cannot currently get it open (unlock
   * condition unmet, or relock condition met). Recomputed from live lock
   * conditions every call, so it flips to `false` the moment the unlock
   * requirement is satisfied.
   */
  navigationBlocked: boolean;
  unlock?: DoorConditionGroup;
  relock?: DoorConditionGroup;
  unlockRequirement: DoorUnlockRequirement;
}

function tileKey(x: number, y: number): string {
  return `${x},${y}`;
}

/**
 * Flatten a door's unlock condition group into the goals/items/timers the AI
 * must satisfy. Returns empty lists when the door has no lock configuration.
 */
export function describeDoorUnlock(group: DoorConditionGroup | undefined): DoorUnlockRequirement {
  const requirement: DoorUnlockRequirement = { goalIds: [], itemIds: [], timerMs: [] };
  if (!group) {
    return requirement;
  }
  for (const condition of group.conditions) {
    switch (condition.type) {
      case 'goal':
        requirement.goalIds.push(condition.goalId);
        break;
      case 'inventory':
        requirement.itemIds.push(condition.itemId);
        break;
      case 'timer':
        requirement.timerMs.push(condition.elapsedMs);
        break;
    }
  }
  return requirement;
}

/**
 * Whether A* should currently treat a configured door as impassable. A door is
 * blocked when its unlock condition is not satisfied, or when its relock
 * condition is satisfied. Doors without a lock configuration always auto-open
 * on approach and are therefore never blocked. `goalOverrides`, when supplied,
 * lets planning code ask "would this door be open IF goal X were already
 * satisfied?" without mutating the world — see {@link evaluateDoorConditionGroup}.
 */
function isDoorNavigationBlocked(
  world: GameWorld,
  config: DoorLockConfig | undefined,
  goalOverrides?: ReadonlyMap<string, boolean> | null,
): boolean {
  if (!config) {
    return false;
  }
  const unlockSatisfied = evaluateDoorConditionGroup(world, config.unlock, goalOverrides);
  const relockSatisfied = config.relock
    ? evaluateDoorConditionGroup(world, config.relock, goalOverrides)
    : false;
  return !(unlockSatisfied && !relockSatisfied);
}

/**
 * Enumerate every {@link DoorState} door with its live lock status and
 * forward-looking navigation verdict. This is the canonical interface the AI
 * consumes to "see" the doors the UX shows. Pass `goalOverrides` to evaluate
 * hypothetical door state (e.g. "as if goal X were already complete") for
 * planning purposes — every existing caller omits it and sees identical,
 * live-world-only behavior.
 */
export function getDoorNavInfos(
  world: GameWorld,
  goalOverrides?: ReadonlyMap<string, boolean> | null,
): DoorNavInfo[] {
  const { doorState } = world.stores;
  const infos: DoorNavInfo[] = [];
  for (const eid of query(world.ecs, [DoorState])) {
    const config = getDoorLockConfig(world, eid);
    infos.push({
      eid,
      tileX: doorState.tileX[eid] ?? 0,
      tileY: doorState.tileY[eid] ?? 0,
      logicalOpen: (doorState.logicalOpen[eid] ?? 0) !== 0,
      effectiveOpen: (doorState.effectiveOpen[eid] ?? 0) !== 0,
      isLocked: (doorState.isLocked[eid] ?? 0) !== 0,
      navigationBlocked: isDoorNavigationBlocked(world, config, goalOverrides),
      unlock: config?.unlock,
      relock: config?.relock,
      unlockRequirement: describeDoorUnlock(config?.unlock),
    });
  }
  return infos;
}

/** The subset of {@link getDoorNavInfos} that A* must currently treat as walls. */
export function getNavigationBlockedDoors(
  world: GameWorld,
  goalOverrides?: ReadonlyMap<string, boolean> | null,
): DoorNavInfo[] {
  return getDoorNavInfos(world, goalOverrides).filter((info) => info.navigationBlocked);
}

/**
 * Build a passability predicate for door-aware A* (`PathfindingOptions.isTilePassable`).
 *
 * A tile is passable when it is already walkable (floor or an open door), or
 * when it is a door tile that is not a currently-blocked locked door. Plain
 * closed doors (no lock entity) and unlocked/satisfied configured doors are
 * passable because the runtime auto-opens them on approach; locked-unsatisfied
 * doors are treated as walls so the AI never plans into — and wiggles against —
 * a door it cannot open.
 *
 * The blocked-door set is snapshotted once per call, so rebuild the predicate
 * each AI poll to pick up freshly-satisfied unlock conditions. Pass
 * `goalOverrides` to build a HYPOTHETICAL predicate (e.g. "as if goal X were
 * already satisfied") for planning code that must ask what would be reachable
 * after a not-yet-completed goal unlocks a door — see `floor1-travel-oracle.ts`.
 * Every existing caller omits it and gets the exact live-world predicate.
 */
export function buildDoorAwarePassable(
  world: GameWorld,
  goalOverrides?: ReadonlyMap<string, boolean> | null,
): (x: number, y: number) => boolean {
  const floorMap = world.floorMap;
  const blockedDoorTiles = new Set<string>();
  if (floorMap) {
    for (const info of getDoorNavInfos(world, goalOverrides)) {
      if (info.navigationBlocked) {
        blockedDoorTiles.add(tileKey(info.tileX, info.tileY));
      }
    }
  }

  return (x: number, y: number): boolean => {
    if (!floorMap) {
      return false;
    }
    const tileMap = floorMap.tileMap;
    if (tileMap.isPassable(x, y)) {
      return true;
    }
    if (tileMap.isDoor(x, y) && !blockedDoorTiles.has(tileKey(x, y))) {
      return true;
    }
    return false;
  };
}
