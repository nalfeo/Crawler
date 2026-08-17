/**
 * Emergent-event scheduler (Floor 2 · Slice 6).
 *
 * Watches for authored triggers on the Floor 2 emergent-event pack and, when
 * one matches, queues the event's faction-relation deltas on
 * `world.factionRelationDeltas` so `familyRelationshipSystem` applies them
 * next tick.
 *
 * Rules honored:
 *   - Deterministic: every decision reads `world.elapsedMs` and (indirectly)
 *     `world.rng`. No `Date.now()`, no `Math.random()`.
 *   - One-shot events fire at most once per world (default), enforced by an
 *     in-memory `firedEventIds` set held on a WeakMap keyed by world.
 *   - No-op unless `world.floorExtendedState?.familyState != null` and `world.state === 'playing'`.
 *   - Region-enter triggers check the player's current room role via
 *     `world.floorMap.roomGraph.getRoomAt` (pre-built spatial cache), not a
 *     global scan.
 *   - Threshold-cross triggers scan `world.factionRelationEvents` non-
 *     destructively; the HUD may also read the same buffer that same frame.
 *
 * Registered in Floor 2's scenario definition before `weaponSystem`; the
 * bootstrap assembles that slot after `familyRelationshipSystem` for both real
 * pipelines.
 */
import { query } from 'bitecs';
import type { GameWorld } from '../../core/world.js';
import { Player, Position } from '../../core/components.js';
import {
  queueFactionRelationDelta,
  RELATION_DELTAS,
  type FactionBand,
  type FamilyId,
} from '../../core/faction-relations.js';
import { RoomRole } from '../../shared/map-types.js';
import {
  loadEmergentEventPack,
  type EmergentEventDef,
  type EmergentEventPack,
} from '../../shared/data/emergent-events.js';
import tuning from '../../shared/data/tuning.json';

/** Runtime bookkeeping for the scheduler, held per-world. */
export interface EmergentEventSchedulerState {
  /** Event ids that have already fired at least once (one-shot enforcement). */
  firedEventIds: Set<string>;
  /**
   * For non-one-shot events, `elapsedMs` at which each event most recently
   * fired. Used to enforce the per-event cooldown from tuning.
   */
  lastFiredMsById: Map<string, number>;
  /**
   * Previous band we last observed for each family — kept so a same-frame
   * double-fire never happens when factionRelationEvents shows two
   * transitions to the same band.
   */
  previousBandByFamily: Map<FamilyId, FactionBand>;
  /**
   * Which room id we last saw the player inside — used to fire region-enter
   * triggers on the *edge* rather than every frame.
   */
  lastRoomId: number | null;
  /** Snapshot of the loaded event pack. */
  pack: EmergentEventPack | null;
}

const stateByWorld = new WeakMap<GameWorld, EmergentEventSchedulerState>();

function getState(world: GameWorld): EmergentEventSchedulerState {
  let state = stateByWorld.get(world);
  if (!state) {
    state = {
      firedEventIds: new Set(),
      lastFiredMsById: new Map(),
      previousBandByFamily: new Map(),
      lastRoomId: null,
      pack: null,
    };
    stateByWorld.set(world, state);
  }
  return state;
}

/** Cooldown for an event id (ms) — reads tuning; falls back to 0 when unset. */
function eventCooldownMs(eventId: string): number {
  const table = (tuning.factionRelations as { eventCooldownsMs?: Record<string, number> })
    .eventCooldownsMs;
  return table?.[eventId] ?? 0;
}

/**
 * Resolve the family id targeted by an effect. Effects reference families by
 * their index in `floor2State.presentFamilies`, so a pack can be authored
 * without knowing which families were seeded this run.
 */
function resolveFamilyId(world: GameWorld, familyIndex: number): FamilyId | null {
  const roster = world.floorExtendedState?.familyState?.presentFamilies;
  if (!roster || familyIndex < 0 || familyIndex >= roster.length) {
    return null;
  }
  return roster[familyIndex]!;
}

/** Apply an event's effects: push each into `factionRelationDeltas`. */
function fireEvent(world: GameWorld, event: EmergentEventDef): void {
  for (const effect of event.effects) {
    const familyId = resolveFamilyId(world, effect.familyIndex);
    if (familyId === null) continue;
    const magnitude = (RELATION_DELTAS as Record<string, number | undefined>)[effect.deltaKey];
    if (magnitude === undefined) continue;
    queueFactionRelationDelta(world, {
      familyId,
      delta: magnitude,
      reason: `${event.id}: ${effect.reason}`,
    });
  }
}

/** Should this event be considered on this tick? Enforces one-shot + cooldown. */
function eligible(
  state: EmergentEventSchedulerState,
  event: EmergentEventDef,
  nowMs: number,
): boolean {
  if (event.oneShot && state.firedEventIds.has(event.id)) return false;
  const lastMs = state.lastFiredMsById.get(event.id);
  if (lastMs !== undefined) {
    const cooldown = eventCooldownMs(event.id);
    if (cooldown > 0 && nowMs - lastMs < cooldown) return false;
  }
  return true;
}

function markFired(
  state: EmergentEventSchedulerState,
  event: EmergentEventDef,
  nowMs: number,
): void {
  if (event.oneShot) state.firedEventIds.add(event.id);
  state.lastFiredMsById.set(event.id, nowMs);
}

/** Map a room role string from the event to the enum used by the roomGraph. */
function roleFromString(role: string): RoomRole | null {
  switch (role) {
    case 'settlement':
      return RoomRole.SETTLEMENT;
    case 'territory':
      return RoomRole.TERRITORY;
    case 'resource_heart':
      return RoomRole.RESOURCE_HEART;
    case 'boss_den':
      return RoomRole.BOSS_DEN;
    default:
      return null;
  }
}

/**
 * Determine the room id + role containing the player. Uses the room graph's
 * pre-built spatial cache (`roomGraph.getRoomAt`) — spec-required for perf.
 */
function playerRoom(world: GameWorld): { roomId: number; role: RoomRole } | null {
  const floorMap = world.floorMap;
  if (!floorMap) return null;
  const players = query(world.ecs, [Player, Position]);
  const eid = players[0];
  if (eid === undefined) return null;
  const x = world.stores.position.x[eid];
  const y = world.stores.position.y[eid];
  if (x === undefined || y === undefined) return null;
  const tile = floorMap.worldToTile(x, y);
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  if (roomId < 0) return null;
  const room = floorMap.roomGraph.get(roomId);
  if (!room) return null;
  return { roomId: room.id, role: room.role };
}

/**
 * ECS system — main scheduler entry point. Deterministic, no random draws,
 * no side effects beyond queuing faction-relation deltas + updating the
 * per-world state.
 */
export function emergentEventSystem(world: GameWorld): void {
  if (world.state !== 'playing') return;
  const familyState = world.floorExtendedState?.familyState;
  if (familyState == null) return;
  // While the Floor 2 reputation system is locked, pause the scheduler so
  // one-shot events are not consumed before their deltas can ever apply.
  if (familyState.reputationSystemActive === false) return;

  const state = getState(world);
  if (state.pack === null) state.pack = loadEmergentEventPack();

  // Region-enter tracking (updated once per tick regardless of triggers).
  const roomInfo = playerRoom(world);
  const enteredRoomThisFrame = roomInfo !== null && roomInfo.roomId !== state.lastRoomId;
  state.lastRoomId = roomInfo?.roomId ?? null;

  // Threshold-cross tracking: snapshot band-cross transitions this frame.
  const crossedThisFrame: Map<FamilyId, FactionBand> = new Map();
  for (const change of world.factionRelationEvents) {
    if (change.band !== change.previousBand) {
      const already = state.previousBandByFamily.get(change.familyId);
      if (already !== change.band) {
        crossedThisFrame.set(change.familyId, change.band);
      }
    }
    state.previousBandByFamily.set(change.familyId, change.band);
  }

  const nowMs = world.elapsedMs;
  const pack = state.pack;

  // Fire events deterministically, in authored order.
  for (const event of pack.events) {
    if (!eligible(state, event, nowMs)) continue;

    const trigger = event.trigger;
    let shouldFire = false;

    if (trigger.type === 'timer') {
      if (nowMs >= trigger.atMs) shouldFire = true;
    } else if (trigger.type === 'regionEnter') {
      const expectedRole = roleFromString(trigger.roomRole);
      if (
        expectedRole !== null &&
        enteredRoomThisFrame &&
        roomInfo !== null &&
        roomInfo.role === expectedRole
      ) {
        shouldFire = true;
      }
    } else if (trigger.type === 'threshold') {
      const familyId = resolveFamilyId(world, trigger.familyIndex);
      if (familyId !== null) {
        const crossed = crossedThisFrame.get(familyId);
        if (crossed === trigger.crosses) {
          shouldFire = true;
        }
      }
    }

    if (shouldFire) {
      fireEvent(world, event);
      markFired(state, event, nowMs);
    }
  }
}

// --- Test / lab helpers -----------------------------------------------------

/** Read the set of fired event ids for a world (test/lab only). */
export function getFiredEmergentEvents(world: GameWorld): ReadonlySet<string> {
  return getState(world).firedEventIds;
}

/**
 * Force-fire an emergent event, bypassing its trigger. Used by the lab's
 * "trigger event N" buttons and by integration tests. Still honors one-shot
 * bookkeeping and cooldown accounting so subsequent scheduler ticks stay
 * deterministic.
 */
export function forceFireEmergentEvent(world: GameWorld, eventId: string): boolean {
  const pack = loadEmergentEventPack();
  const event = pack.events.find((e) => e.id === eventId);
  if (!event) return false;
  fireEvent(world, event);
  markFired(getState(world), event, world.elapsedMs);
  return true;
}

/** Test-only: reset a world's scheduler state. */
export function _resetEmergentEventScheduler(world?: GameWorld): void {
  if (world) {
    stateByWorld.delete(world);
  }
}

/**
 * Introspection helper used by the lab to render "next timer event in Xs".
 * Returns undefined for non-timer events.
 */
export function nextTimerEventEta(world: GameWorld, eventId: string): number | undefined {
  const pack = loadEmergentEventPack();
  const event = pack.events.find((e) => e.id === eventId);
  if (!event || event.trigger.type !== 'timer') return undefined;
  return Math.max(0, event.trigger.atMs - world.elapsedMs);
}
