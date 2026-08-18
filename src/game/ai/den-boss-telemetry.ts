/**
 * Den-boss telemetry collection — reads a `GameWorld` and produces the shared
 * Floor 2 den diagnostic contract defined in
 * `src/shared/den-boss-telemetry-types.ts`.
 *
 * The same collector feeds all three telemetry surfaces (headless `RunStats`,
 * AI Runner lab recordings, real player sessions), so every surface emits
 * byte-identical evidence for identical world state.
 *
 * Pure module: no Phaser, no `fs`, no `Math.random()`, no `Date.now()`. Safe to
 * import from labs, tests, the headless runner and the browser recorder.
 */
import { hasComponent } from 'bitecs';
import { DoorState, FamilyMembership, Health } from '../../core/components.js';
import type { Floor2FamilyBossEncounterState } from '../../core/faction-relations.js';
import type { GameWorld } from '../../core/world.js';
import {
  DEN_BOSS_ROLLUP_TRANSITION_LIMIT,
  DEN_BOSS_TELEMETRY_SCHEMA_VERSION,
  DEN_BOSS_TRANSITION_ORDER,
  type DenBossDiagnostics,
  type DenBossEventPayload,
  type DenBossFamilyDiagnostics,
  type DenBossSnapshot,
  type DenBossTransition,
  type DenBossTransitionKind,
  type DenBossTransitionRecord,
} from '../../shared/den-boss-telemetry-types.js';
import { denUnlockGoalId } from '../floor2Scenario.js';

export {
  DEN_BOSS_ROLLUP_TRANSITION_LIMIT,
  DEN_BOSS_TELEMETRY_SCHEMA_VERSION,
  DEN_BOSS_TRANSITION_ORDER,
} from '../../shared/den-boss-telemetry-types.js';
export type {
  DenBossDiagnostics,
  DenBossEventPayload,
  DenBossFamilyDiagnostics,
  DenBossSnapshot,
  DenBossTransition,
  DenBossTransitionKind,
  DenBossTransitionRecord,
} from '../../shared/den-boss-telemetry-types.js';

// ---------------------------------------------------------------------------
// Event payload builders
// ---------------------------------------------------------------------------

/** Build the event payload for a discrete transition. */
export function denBossTransitionPayload(transition: DenBossTransition): DenBossEventPayload {
  return {
    schemaVersion: transition.schemaVersion,
    kind: transition.kind,
    familyId: transition.familyId,
    before: transition.before,
    dens: [transition.after],
  };
}

/** Build the periodic aggregate payload covering every den on the floor. */
export function denBossSnapshotPayload(snapshots: readonly DenBossSnapshot[]): DenBossEventPayload {
  return {
    schemaVersion: DEN_BOSS_TELEMETRY_SCHEMA_VERSION,
    kind: 'snapshot',
    familyId: null,
    before: null,
    dens: [...snapshots],
  };
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** True when this world currently has Floor 2 den encounters to report on. */
export function hasDenBossTelemetry(world: GameWorld): boolean {
  const familyState = world.floorExtendedState?.familyState;
  return (
    familyState !== undefined &&
    familyState !== null &&
    familyState.bossEncounters !== undefined &&
    familyState.bossEncounters.size > 0
  );
}

function tileOf(world: GameWorld, eid: number): { x: number; y: number } | null {
  const floorMap = world.floorMap;
  if (!floorMap) return null;
  return floorMap.worldToTile(world.stores.position.x[eid] ?? 0, world.stores.position.y[eid] ?? 0);
}

function roomAt(world: GameWorld, tile: { x: number; y: number } | null): number | null {
  const floorMap = world.floorMap;
  if (!floorMap || !tile) return null;
  // `getRoomAt` returns -1 for a tile that belongs to no room (corridor, wall,
  // open cavern), which must read as "no room" rather than as room id -1.
  const roomId = floorMap.roomGraph.getRoomAt(tile.x, tile.y);
  return roomId === undefined || roomId < 0 ? null : roomId;
}

/**
 * Whether `eid` is still a live boss entity. Guards against entity-id reuse:
 * typed-array slots keep their values after an entity is removed, so a stored
 * eid must be re-validated by component membership before it is trusted.
 */
function isLiveBoss(world: GameWorld, eid: number | null): eid is number {
  return (
    eid !== null &&
    eid >= 0 &&
    hasComponent(world.ecs, eid, FamilyMembership) &&
    world.stores.familyMembership.isBoss[eid] === 1
  );
}

function buildSnapshot(
  world: GameWorld,
  encounter: Floor2FamilyBossEncounterState,
  playerRoomId: number | null,
  lastKnownBossEid: number | null,
): DenBossSnapshot {
  const bossEid = encounter.bossEid;
  const bossAlive = isLiveBoss(world, bossEid);
  const bossTile = bossAlive ? tileOf(world, bossEid) : null;
  const bossRoomId = bossAlive ? roomAt(world, bossTile) : null;
  const hasHealth = bossAlive && hasComponent(world.ecs, bossEid, Health);

  let denDoorsTotal = 0;
  let denDoorsLocked = 0;
  let denDoorsOpen = 0;
  for (const doorEid of encounter.doorEids) {
    if (!hasComponent(world.ecs, doorEid, DoorState)) continue;
    denDoorsTotal += 1;
    if (world.stores.doorState.isLocked[doorEid] === 1) denDoorsLocked += 1;
    if (world.stores.doorState.effectiveOpen[doorEid] === 1) denDoorsOpen += 1;
  }

  const resolvedLastKnown = bossAlive ? bossEid : lastKnownBossEid;

  return {
    schemaVersion: DEN_BOSS_TELEMETRY_SCHEMA_VERSION,
    familyId: encounter.familyId,
    displayName: encounter.displayName,
    denRoomId: encounter.roomId,
    bossEid: bossEid ?? null,
    lastKnownBossEid: resolvedLastKnown,
    bossAlive,
    bossTileX: bossTile ? bossTile.x : null,
    bossTileY: bossTile ? bossTile.y : null,
    bossRoomId,
    bossInDen: bossAlive && bossRoomId === encounter.roomId,
    bossVisible:
      bossAlive && world.floorMap !== null
        ? world.floorMap.isVisibleAt(
            world.stores.position.x[bossEid] ?? 0,
            world.stores.position.y[bossEid] ?? 0,
          )
        : false,
    bossHealthCurrent: hasHealth ? (world.stores.health.current[bossEid] ?? null) : null,
    bossHealthMax: hasHealth ? (world.stores.health.max[bossEid] ?? null) : null,
    denUnlocked: world.goalFlags.get(denUnlockGoalId(encounter.familyId)) === true,
    encounterStarted: encounter.started === true,
    encounterDefeated: encounter.defeated === true,
    encounterGoalActive: world.goalFlags.get(encounter.activeGoalId) === true,
    denDoorsTotal,
    denDoorsLocked,
    denDoorsOpen,
    denSealed: denDoorsTotal > 0 && denDoorsLocked === denDoorsTotal,
    playerRoomId,
    playerInDen: playerRoomId !== null && playerRoomId === encounter.roomId,
  };
}

/**
 * Collect one {@link DenBossSnapshot} per Floor 2 den, in `presentFamilies`
 * order (never `Map` insertion order) so the stream is deterministic.
 *
 * Returns `[]` on any floor without den encounters, so non-Floor-2 callers pay
 * only a map lookup.
 */
export function collectDenBossSnapshots(
  world: GameWorld,
  playerEid: number | null = null,
): DenBossSnapshot[] {
  const familyState = world.floorExtendedState?.familyState;
  const encounters = familyState?.bossEncounters;
  if (!familyState || !encounters || encounters.size === 0) {
    return [];
  }
  const playerRoomId = playerEid === null ? null : roomAt(world, tileOf(world, playerEid));
  const snapshots: DenBossSnapshot[] = [];
  for (const familyId of familyState.presentFamilies) {
    const encounter = encounters.get(familyId);
    if (!encounter) continue;
    snapshots.push(buildSnapshot(world, encounter, playerRoomId, null));
  }
  return snapshots;
}

// ---------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------

interface FamilyHistory {
  firstBossEid: number | null;
  lastKnownBossEid: number | null;
  denUnlockedFrame: number | null;
  denUnlockedMs: number | null;
  encounterStartedFrame: number | null;
  encounterStartedMs: number | null;
  encounterDefeatedFrame: number | null;
  encounterDefeatedMs: number | null;
  bossLeftDenCount: number;
  bossReturnedToDenCount: number;
  firstBossLeftDenMs: number | null;
  previous: DenBossSnapshot;
}

/**
 * Stateful den-boss observer. Poll it once per simulation frame; it diffs
 * against the previous observation and returns only the discrete transitions
 * that fired, and separately accumulates the {@link DenBossDiagnostics} rollup.
 *
 * The rollup is accumulated regardless of whether the caller does anything with
 * the returned transitions, so `RunStats` carries the evidence even when no
 * event sink is wired.
 */
export interface DenBossTransitionTracker {
  /**
   * Observe the world for `frame`. Returns the transitions that fired this
   * frame, ordered by family (`presentFamilies` order) then by the fixed
   * {@link TRANSITION_ORDER}. Allocates nothing when nothing changed.
   */
  poll(world: GameWorld, frame: number, playerEid?: number | null): DenBossTransition[];
  /** Snapshot of every den as of the last poll, in `presentFamilies` order. */
  getSnapshots(): DenBossSnapshot[];
  /** The accumulated rollup for `RunStats`. */
  getDiagnostics(): DenBossDiagnostics | undefined;
  /** Total transitions observed since creation/reset. */
  getTransitionCount(): number;
  /** Drop all history so the next poll re-emits `baseline` for every den. */
  reset(): void;
}

const EMPTY_TRANSITIONS: DenBossTransition[] = [];

function toTransitionRecord(transition: DenBossTransition): DenBossTransitionRecord {
  const after = transition.after;
  return {
    kind: transition.kind,
    familyId: transition.familyId,
    frame: transition.frame,
    gameMs: transition.gameMs,
    bossEid: after.bossEid ?? after.lastKnownBossEid,
    bossTileX: after.bossTileX,
    bossTileY: after.bossTileY,
    bossInDen: after.bossInDen,
    bossVisible: after.bossVisible,
    bossHealthCurrent: after.bossHealthCurrent,
    denSealed: after.denSealed,
    encounterGoalActive: after.encounterGoalActive,
    playerInDen: after.playerInDen,
  };
}

/** Create a {@link DenBossTransitionTracker}. */
export function createDenBossTransitionTracker(): DenBossTransitionTracker {
  /** Insertion order mirrors `presentFamilies`, so iteration stays deterministic. */
  let history = new Map<string, FamilyHistory>();
  let transitionCount = 0;
  let transitionLog: DenBossTransitionRecord[] = [];

  function classify(before: DenBossSnapshot, after: DenBossSnapshot): DenBossTransitionKind[] {
    const fired = new Set<DenBossTransitionKind>();
    if (!before.denUnlocked && after.denUnlocked) fired.add('den-unlocked');
    if (before.denSealed && !after.denSealed) fired.add('den-doors-unlocked');
    if (!before.denSealed && after.denSealed) fired.add('den-doors-locked');
    if (!before.playerInDen && after.playerInDen) fired.add('player-entered-den');
    if (before.playerInDen && !after.playerInDen) fired.add('player-left-den');
    if (!before.encounterStarted && after.encounterStarted) fired.add('encounter-started');
    if (before.bossAlive && after.bossAlive) {
      if (before.bossInDen && !after.bossInDen) fired.add('boss-left-den');
      if (!before.bossInDen && after.bossInDen) fired.add('boss-returned-to-den');
    }
    if (before.bossAlive && !after.bossAlive) fired.add('boss-despawned');
    if (!before.encounterDefeated && after.encounterDefeated) fired.add('encounter-defeated');
    if (!before.encounterGoalActive && after.encounterGoalActive) fired.add('encounter-goal-set');
    if (before.encounterGoalActive && !after.encounterGoalActive) {
      fired.add('encounter-goal-cleared');
    }
    if (fired.size === 0) return [];
    return DEN_BOSS_TRANSITION_ORDER.filter((kind) => fired.has(kind));
  }

  function record(
    entry: FamilyHistory,
    kind: DenBossTransitionKind,
    frame: number,
    gameMs: number,
    after: DenBossSnapshot,
  ): void {
    switch (kind) {
      case 'den-unlocked':
        entry.denUnlockedFrame ??= frame;
        entry.denUnlockedMs ??= gameMs;
        break;
      case 'encounter-started':
        entry.encounterStartedFrame ??= frame;
        entry.encounterStartedMs ??= gameMs;
        break;
      case 'encounter-defeated':
        entry.encounterDefeatedFrame ??= frame;
        entry.encounterDefeatedMs ??= gameMs;
        break;
      case 'boss-left-den':
        entry.bossLeftDenCount += 1;
        entry.firstBossLeftDenMs ??= gameMs;
        break;
      case 'boss-returned-to-den':
        entry.bossReturnedToDenCount += 1;
        break;
      default:
        break;
    }
    if (after.bossAlive) {
      entry.firstBossEid ??= after.bossEid;
      entry.lastKnownBossEid = after.bossEid;
    }
  }

  function poll(
    world: GameWorld,
    frame: number,
    playerEid: number | null = null,
  ): DenBossTransition[] {
    const familyState = world.floorExtendedState?.familyState;
    const encounters = familyState?.bossEncounters;
    if (!familyState || !encounters || encounters.size === 0) {
      return EMPTY_TRANSITIONS;
    }
    const gameMs = world.elapsedMs;
    const playerRoomId = playerEid === null ? null : roomAt(world, tileOf(world, playerEid));
    let transitions: DenBossTransition[] | null = null;

    for (const familyId of familyState.presentFamilies) {
      const encounter = encounters.get(familyId);
      if (!encounter) continue;
      const entry = history.get(familyId);
      const after = buildSnapshot(world, encounter, playerRoomId, entry?.lastKnownBossEid ?? null);

      if (!entry) {
        const created: FamilyHistory = {
          firstBossEid: after.bossAlive ? after.bossEid : null,
          lastKnownBossEid: after.lastKnownBossEid,
          denUnlockedFrame: after.denUnlocked ? frame : null,
          denUnlockedMs: after.denUnlocked ? gameMs : null,
          encounterStartedFrame: after.encounterStarted ? frame : null,
          encounterStartedMs: after.encounterStarted ? gameMs : null,
          encounterDefeatedFrame: after.encounterDefeated ? frame : null,
          encounterDefeatedMs: after.encounterDefeated ? gameMs : null,
          bossLeftDenCount: 0,
          bossReturnedToDenCount: 0,
          firstBossLeftDenMs: null,
          previous: after,
        };
        history.set(familyId, created);
        const baseline: DenBossTransition = {
          schemaVersion: DEN_BOSS_TELEMETRY_SCHEMA_VERSION,
          kind: 'baseline',
          familyId,
          frame,
          gameMs,
          before: null,
          after,
        };
        transitions ??= [];
        transitions.push(baseline);
        transitionCount += 1;
        if (transitionLog.length < DEN_BOSS_ROLLUP_TRANSITION_LIMIT) {
          transitionLog.push(toTransitionRecord(baseline));
        }
        continue;
      }

      const before = entry.previous;
      const kinds = classify(before, after);
      entry.previous = after;
      if (after.bossAlive) {
        entry.lastKnownBossEid = after.bossEid;
        entry.firstBossEid ??= after.bossEid;
      }
      if (kinds.length === 0) continue;
      for (const kind of kinds) {
        record(entry, kind, frame, gameMs, after);
        const transition: DenBossTransition = {
          schemaVersion: DEN_BOSS_TELEMETRY_SCHEMA_VERSION,
          kind,
          familyId,
          frame,
          gameMs,
          before,
          after,
        };
        transitions ??= [];
        transitions.push(transition);
        transitionCount += 1;
        if (transitionLog.length < DEN_BOSS_ROLLUP_TRANSITION_LIMIT) {
          transitionLog.push(toTransitionRecord(transition));
        }
      }
    }

    return transitions ?? EMPTY_TRANSITIONS;
  }

  function getSnapshots(): DenBossSnapshot[] {
    return [...history.values()].map((entry) => entry.previous);
  }

  function getDiagnostics(): DenBossDiagnostics | undefined {
    if (history.size === 0) return undefined;
    const families: Record<string, DenBossFamilyDiagnostics> = {};
    for (const [familyId, entry] of history) {
      families[familyId] = {
        familyId,
        displayName: entry.previous.displayName,
        denRoomId: entry.previous.denRoomId,
        firstBossEid: entry.firstBossEid,
        lastKnownBossEid: entry.lastKnownBossEid,
        denUnlockedFrame: entry.denUnlockedFrame,
        denUnlockedMs: entry.denUnlockedMs,
        encounterStartedFrame: entry.encounterStartedFrame,
        encounterStartedMs: entry.encounterStartedMs,
        encounterDefeatedFrame: entry.encounterDefeatedFrame,
        encounterDefeatedMs: entry.encounterDefeatedMs,
        bossLeftDenCount: entry.bossLeftDenCount,
        bossReturnedToDenCount: entry.bossReturnedToDenCount,
        firstBossLeftDenMs: entry.firstBossLeftDenMs,
        final: entry.previous,
      };
    }
    return {
      schemaVersion: DEN_BOSS_TELEMETRY_SCHEMA_VERSION,
      eventStreamType: 'den',
      families,
      transitions: [...transitionLog],
      transitionCount,
      transitionsTruncated: transitionCount > transitionLog.length,
    };
  }

  function reset(): void {
    history = new Map();
    transitionLog = [];
    transitionCount = 0;
  }

  return {
    poll,
    getSnapshots,
    getDiagnostics,
    getTransitionCount: () => transitionCount,
    reset,
  };
}
