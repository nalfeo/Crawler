/**
 * Floor-collapse deadline resolution — the single place that turns a floor's
 * static manifest duration into the deadline the run is actually judged against.
 *
 * Floors whose timer lives on the manifest (`timer.durationMs`) used to compare
 * raw `world.elapsedMs` against it, which meant their safe rooms stopped nothing:
 * the entrance room on Floor 2/3 is a safe room, yet the countdown kept running
 * inside it. The deadline is now `durationMs + world.safeRoomTimerCreditMs`, the
 * credit banked by `safeRoomSystem` while the player stands in a time-stopping
 * safe room.
 *
 * Every collapse consumer (floor scenarios, the HUD countdown, the AI's collapse
 * planning) resolves through this helper so they can never disagree about when
 * the floor ends. Floors whose timer is a deliberate raw wall-clock stall
 * backstop opt out via `behavior.safeRoomPausesFloorTimer: false`, which keeps
 * their credit at 0 and leaves this helper equal to the raw duration.
 *
 * Pure and deterministic: reads world state and the static floor manifest only.
 */
import type { GameWorld } from './world.js';
import { getFloorManifest } from '../shared/floor-registry.js';
import { getWorldFloorBehavior, getWorldFloorManifest } from './floor-behavior.js';

/**
 * True when the active floor's collapse timer is currently paused: the player
 * stands in a time-stopping safe room and the floor opted into safe-room timer
 * credit.
 *
 * The one predicate both timer shapes obey — `safeRoomSystem` banks credit for
 * manifest-timer floors under it, and Floor 1 extends its own mutable
 * `objective.deadlineMs` under it — so the two can never drift apart.
 */
export function isFloorTimerPaused(world: GameWorld): boolean {
  return (
    world.playerInTimeStoppingSafeRoom && getWorldFloorBehavior(world).safeRoomPausesFloorTimer
  );
}

/**
 * Absolute elapsed-time threshold (ms, same base as `world.elapsedMs`) at which
 * the floor collapses, or `null` when the floor declares no manifest timer.
 *
 * @param floorId Explicit floor id to resolve; defaults to the world's floor.
 */
export function resolveFloorTimerDeadlineMs(world: GameWorld, floorId?: string): number | null {
  const manifest = floorId === undefined ? getWorldFloorManifest(world) : getFloorManifest(floorId);
  const durationMs = manifest?.timer?.durationMs;
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return durationMs + world.safeRoomTimerCreditMs;
}

/**
 * True when the manifest-timer floor identified by `floorId` (default: the
 * world's floor) has run out of time.
 */
export function hasFloorTimerExpired(world: GameWorld, floorId?: string): boolean {
  const deadlineMs = resolveFloorTimerDeadlineMs(world, floorId);
  return deadlineMs !== null && world.elapsedMs >= deadlineMs;
}
