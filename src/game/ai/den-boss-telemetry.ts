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

/**
 * Fill `target` with the current state of one den. Writing into a caller-owned
 * object keeps the per-frame diff allocation-free: the tracker reuses a single
 * scratch snapshot per den and only materializes a durable object when a
 * transition actually fires.
 */
function writeSnapshot(
  world: GameWorld,
  encounter: Floor2FamilyBossEncounterState,
  playerRoomId: number | null,
  lastKnownBossEid: number | null,
  target: DenBossSnapshot,
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

  // Field-by-field assignment, deliberately not `Object.assign(target, {...})`:
  // an object literal there would allocate and immediately discard a snapshot
  // on every frame, which is exactly what the scratch buffer exists to avoid.
  target.schemaVersion = DEN_BOSS_TELEMETRY_SCHEMA_VERSION;
  target.familyId = encounter.familyId;
  target.displayName = encounter.displayName;
  target.denRoomId = encounter.roomId;
  target.bossEid = bossEid ?? null;
  target.lastKnownBossEid = resolvedLastKnown;
  target.bossAlive = bossAlive;
  target.bossTileX = bossTile ? bossTile.x : null;
  target.bossTileY = bossTile ? bossTile.y : null;
  target.bossRoomId = bossRoomId;
  target.bossInDen = bossAlive && bossRoomId === encounter.roomId;
  target.bossVisible =
    bossAlive && world.floorMap !== null
      ? world.floorMap.isVisibleAt(
          world.stores.position.x[bossEid] ?? 0,
          world.stores.position.y[bossEid] ?? 0,
        )
      : false;
  target.bossHealthCurrent = hasHealth ? (world.stores.health.current[bossEid] ?? null) : null;
  target.bossHealthMax = hasHealth ? (world.stores.health.max[bossEid] ?? null) : null;
  target.denUnlocked = world.goalFlags.get(denUnlockGoalId(encounter.familyId)) === true;
  target.encounterStarted = encounter.started === true;
  target.encounterDefeated = encounter.defeated === true;
  target.encounterGoalActive = world.goalFlags.get(encounter.activeGoalId) === true;
  target.denDoorsTotal = denDoorsTotal;
  target.denDoorsLocked = denDoorsLocked;
  target.denDoorsOpen = denDoorsOpen;
  target.denSealed = denDoorsTotal > 0 && denDoorsLocked === denDoorsTotal;
  target.playerRoomId = playerRoomId;
  target.playerInDen = playerRoomId !== null && playerRoomId === encounter.roomId;
  return target;
}

/**
 * Blank snapshot with every field declared in contract order, so all snapshots
 * share one object shape regardless of how they were produced.
 */
function blankSnapshot(): DenBossSnapshot {
  return {
    schemaVersion: DEN_BOSS_TELEMETRY_SCHEMA_VERSION,
    familyId: '',
    displayName: '',
    denRoomId: -1,
    bossEid: null,
    lastKnownBossEid: null,
    bossAlive: false,
    bossTileX: null,
    bossTileY: null,
    bossRoomId: null,
    bossInDen: false,
    bossVisible: false,
    bossHealthCurrent: null,
    bossHealthMax: null,
    denUnlocked: false,
    encounterStarted: false,
    encounterDefeated: false,
    encounterGoalActive: false,
    denDoorsTotal: 0,
    denDoorsLocked: 0,
    denDoorsOpen: 0,
    denSealed: false,
    playerRoomId: null,
    playerInDen: false,
  };
}

/** Allocate a fresh snapshot for one den. */
function buildSnapshot(
  world: GameWorld,
  encounter: Floor2FamilyBossEncounterState,
  playerRoomId: number | null,
  lastKnownBossEid: number | null,
): DenBossSnapshot {
  return writeSnapshot(world, encounter, playerRoomId, lastKnownBossEid, blankSnapshot());
}

/**
 * Copy a snapshot. Emitted records must never alias the tracker's mutable
 * scratch/working objects, or a later frame would rewrite history.
 */
function cloneSnapshot(source: DenBossSnapshot): DenBossSnapshot {
  return { ...source };
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
  /** Last durable observation. Mutated in place on frames with no transition. */
  previous: DenBossSnapshot;
  /** Reused per-frame working buffer; never handed to a caller. */
  scratch: DenBossSnapshot;
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
const EMPTY_KINDS: DenBossTransitionKind[] = [];

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
    // The checks below are written in DEN_BOSS_TRANSITION_ORDER, so pushing as
    // we go yields the contract order without a Set or a per-frame filter pass.
    // `classify-emits-DEN_BOSS_TRANSITION_ORDER` in the unit tests pins this.
    let fired: DenBossTransitionKind[] | null = null;
    const push = (kind: DenBossTransitionKind): void => {
      fired ??= [];
      fired.push(kind);
    };
    if (!before.denUnlocked && after.denUnlocked) push('den-unlocked');
    if (before.denSealed && !after.denSealed) push('den-doors-unlocked');
    if (!before.denSealed && after.denSealed) push('den-doors-locked');
    if (!before.playerInDen && after.playerInDen) push('player-entered-den');
    if (before.playerInDen && !after.playerInDen) push('player-left-den');
    if (!before.encounterStarted && after.encounterStarted) push('encounter-started');
    if (before.bossAlive && after.bossAlive) {
      if (before.bossInDen && !after.bossInDen) push('boss-left-den');
      if (!before.bossInDen && after.bossInDen) push('boss-returned-to-den');
    }
    if (before.bossAlive && !after.bossAlive) push('boss-despawned');
    if (!before.encounterDefeated && after.encounterDefeated) push('encounter-defeated');
    if (!before.encounterGoalActive && after.encounterGoalActive) push('encounter-goal-set');
    if (before.encounterGoalActive && !after.encounterGoalActive) {
      push('encounter-goal-cleared');
    }
    return fired ?? EMPTY_KINDS;
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

      if (!entry) {
        const after = buildSnapshot(world, encounter, playerRoomId, null);
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
          previous: cloneSnapshot(after),
          scratch: cloneSnapshot(after),
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

      const scratch = writeSnapshot(
        world,
        encounter,
        playerRoomId,
        entry.lastKnownBossEid,
        entry.scratch,
      );
      const before = entry.previous;
      const kinds = classify(before, scratch);
      if (scratch.bossAlive) {
        entry.lastKnownBossEid = scratch.bossEid;
        entry.firstBossEid ??= scratch.bossEid;
      }
      if (kinds.length === 0) {
        // Nothing discrete happened: refresh the live state in place so the
        // rollup stays current without allocating on a quiet frame.
        Object.assign(before, scratch);
        continue;
      }
      // A transition fired, so `before` is now history and must never be
      // mutated again — emitted records hold it. Materialize two durable
      // objects: the one records carry, and a fresh working copy.
      const after = cloneSnapshot(scratch);
      entry.previous = cloneSnapshot(scratch);
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
    // Clone: `previous` is mutated in place on quiet frames, so handing it out
    // directly would let a later frame rewrite an already-recorded event.
    return [...history.values()].map((entry) => cloneSnapshot(entry.previous));
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
        final: cloneSnapshot(entry.previous),
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
