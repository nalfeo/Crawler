/**
 * Pure data shapes for the Floor 2 den-boss diagnostic contract — the ONE
 * telemetry schema shared by every collection surface in the project.
 *
 * Before this contract the three collection paths disagreed: the headless
 * runner's `RunStats.floor2Progression` carried lifecycle latches only, while
 * the interactive player / AI Runner recordings carried player state, kills and
 * quests and nothing about the den at all. A sealed-den softlock (Floor 2 seed
 * 42, Queen Mab) therefore could not be diagnosed from a session recording
 * without tracing source.
 *
 * | Surface            | How it collects                                                |
 * | ------------------ | -------------------------------------------------------------- |
 * | `runHeadless`      | polls the tracker each frame -> `den` SimEvents + RunStats rollup |
 * | AI Runner lab      | `createPlayerSessionRecorder` -> `den` records in the JSONL       |
 * | Real game (player) | the same recorder via `sessionRecorderFactory`                    |
 *
 * These interfaces live in `src/shared/` — the leaf layer — because
 * `src/shared/session-recorder-types.ts` must reference the rollup without
 * `src/shared/` importing from `src/core/` or `src/game/` (which the layer
 * rules forbid). The collector and tracker that read `GameWorld` live in
 * `src/game/ai/den-boss-telemetry.ts`.
 *
 * Pure data only: no Phaser, no bitecs, no RNG, no wall-clock time.
 *
 * See `docs/knowledge/telemetry/den-boss-telemetry-contract.md`.
 */

/**
 * Version of the den-boss diagnostic contract. Bump on any breaking field
 * change so recordings can be interpreted against the schema that produced
 * them. Every emitted payload and rollup stamps this value.
 */
export const DEN_BOSS_TELEMETRY_SCHEMA_VERSION = 1;

/**
 * Maximum number of discrete transitions retained in the {@link RunStats}
 * rollup. The full stream always lives in the `den` telemetry events; the
 * rollup keeps a bounded prefix so a `RunStats` JSON stays small on a
 * pathological run. `transitionsTruncated` says whether anything was dropped.
 */
export const DEN_BOSS_ROLLUP_TRANSITION_LIMIT = 200;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Complete diagnostic state of one Floor 2 den encounter at a single frame.
 *
 * Every field is a plain JSON scalar so a snapshot survives JSONL round-trips
 * and is directly queryable (e.g. `jq 'select(.denBoss.dens[].bossInDen ==
 * false)'`) without any source tracing.
 */
export interface DenBossSnapshot {
  /** Contract version that produced this record. */
  schemaVersion: number;
  /** Family that owns the den. */
  familyId: string;
  /** Boss display name (e.g. `Queen Mab`). */
  displayName: string;
  /** Room id of the den this boss belongs to. */
  denRoomId: number;
  /** Live boss entity id, or null once the encounter clears it. */
  bossEid: number | null;
  /**
   * Last boss entity id observed alive, retained after the encounter nulls
   * `bossEid` on defeat so defeat records still identify the boss.
   */
  lastKnownBossEid: number | null;
  /** Whether a boss entity for this den is currently alive in the world. */
  bossAlive: boolean;
  /** Boss tile X, or null when no boss entity is alive. */
  bossTileX: number | null;
  /** Boss tile Y, or null when no boss entity is alive. */
  bossTileY: number | null;
  /** Room the boss is standing in, or null when no boss entity is alive. */
  bossRoomId: number | null;
  /** Whether the live boss is inside its own den room. */
  bossInDen: boolean;
  /** Whether the boss tile is currently lit by the FOV system. */
  bossVisible: boolean;
  /** Boss current health, or null when no boss entity is alive. */
  bossHealthCurrent: number | null;
  /** Boss max health, or null when no boss entity is alive. */
  bossHealthMax: number | null;
  /** Whether the den-unlock goal flag is set. */
  denUnlocked: boolean;
  /** Whether the production encounter latched `started`. */
  encounterStarted: boolean;
  /** Whether the production encounter latched `defeated`. */
  encounterDefeated: boolean;
  /** Whether the encounter's active goal flag (den relock condition) is set. */
  encounterGoalActive: boolean;
  /** Number of den door entities installed for this den. */
  denDoorsTotal: number;
  /** Number of those doors currently locked. */
  denDoorsLocked: number;
  /** Number of those doors currently passable. */
  denDoorsOpen: number;
  /** True when the den has doors and every one of them is locked. */
  denSealed: boolean;
  /** Room the player is standing in, or null when unknown. */
  playerRoomId: number | null;
  /** Whether the player is inside this den room. */
  playerInDen: boolean;
}

// ---------------------------------------------------------------------------
// Transitions
// ---------------------------------------------------------------------------

/**
 * Discrete den-boss state changes. `baseline` is emitted once per den the first
 * time it is observed (and again after a tracker reset) so every recording
 * starts from a known state instead of waiting for the first periodic sample.
 */
export type DenBossTransitionKind =
  | 'baseline'
  | 'den-unlocked'
  | 'den-doors-unlocked'
  | 'den-doors-locked'
  | 'player-entered-den'
  | 'player-left-den'
  | 'encounter-started'
  | 'boss-left-den'
  | 'boss-returned-to-den'
  | 'boss-despawned'
  | 'encounter-defeated'
  | 'encounter-goal-set'
  | 'encounter-goal-cleared';

/**
 * Fixed evaluation order for simultaneous transitions. Emission order is part
 * of the contract so the three surfaces produce identical streams for identical
 * world states.
 */
export const DEN_BOSS_TRANSITION_ORDER: readonly DenBossTransitionKind[] = [
  'den-unlocked',
  'den-doors-unlocked',
  'den-doors-locked',
  'player-entered-den',
  'player-left-den',
  'encounter-started',
  'boss-left-den',
  'boss-returned-to-den',
  'boss-despawned',
  'encounter-defeated',
  'encounter-goal-set',
  'encounter-goal-cleared',
];

/** One discrete den-boss state change with full before/after context. */
export interface DenBossTransition {
  /** Contract version that produced this record. */
  schemaVersion: number;
  /** What changed. */
  kind: DenBossTransitionKind;
  /** Family whose den changed. */
  familyId: string;
  /** Simulation frame the change was observed on. */
  frame: number;
  /** Simulated game time (ms) the change was observed at. */
  gameMs: number;
  /** State on the previous poll; null for `baseline`. */
  before: DenBossSnapshot | null;
  /** State on this poll. */
  after: DenBossSnapshot;
}

/** Compact transition record retained in the {@link RunStats} rollup. */
export interface DenBossTransitionRecord {
  kind: DenBossTransitionKind;
  familyId: string;
  frame: number;
  gameMs: number;
  bossEid: number | null;
  bossTileX: number | null;
  bossTileY: number | null;
  bossInDen: boolean;
  bossVisible: boolean;
  bossHealthCurrent: number | null;
  denSealed: boolean;
  encounterGoalActive: boolean;
  playerInDen: boolean;
}

// ---------------------------------------------------------------------------
// Rollup
// ---------------------------------------------------------------------------

/** Per-family den lifecycle rollup carried by `RunStats.denBoss`. */
export interface DenBossFamilyDiagnostics {
  familyId: string;
  displayName: string;
  denRoomId: number;
  /** First boss entity id observed for this den. */
  firstBossEid: number | null;
  /** Last boss entity id observed alive — survives the defeat-time null. */
  lastKnownBossEid: number | null;
  denUnlockedFrame: number | null;
  denUnlockedMs: number | null;
  encounterStartedFrame: number | null;
  encounterStartedMs: number | null;
  encounterDefeatedFrame: number | null;
  encounterDefeatedMs: number | null;
  /** Times the boss was observed leaving its den room. */
  bossLeftDenCount: number;
  /** Times the boss was observed re-entering its den room. */
  bossReturnedToDenCount: number;
  /** Simulated time the boss first left its den, if ever. */
  firstBossLeftDenMs: number | null;
  /** Final observed state of this den. */
  final: DenBossSnapshot;
}

/**
 * Complete den-boss diagnostic rollup. Accumulated by the tracker itself, so it
 * is present on `RunStats` whether or not a caller wired the optional `den`
 * event sink.
 */
export interface DenBossDiagnostics {
  schemaVersion: number;
  /**
   * `SimEvent.type` that carries the matching per-frame stream. Recordings that
   * include the event stream can be joined to this rollup on `familyId`+`frame`.
   */
  eventStreamType: 'den';
  families: Record<string, DenBossFamilyDiagnostics>;
  /** Bounded transition log — see {@link DEN_BOSS_ROLLUP_TRANSITION_LIMIT}. */
  transitions: DenBossTransitionRecord[];
  /** Total transitions observed, including any dropped from `transitions`. */
  transitionCount: number;
  /** Whether `transitions` dropped records because of the cap. */
  transitionsTruncated: boolean;
}

// ---------------------------------------------------------------------------
// Event payload
// ---------------------------------------------------------------------------

/** Payload attached to a `den` {@link SimEvent} on every telemetry surface. */
export interface DenBossEventPayload {
  schemaVersion: number;
  /** `'snapshot'` for the periodic aggregate record, else the transition kind. */
  kind: 'snapshot' | DenBossTransitionKind;
  /** Family for a transition record; null for the periodic aggregate. */
  familyId: string | null;
  /** State before a transition; null for `baseline` and aggregate records. */
  before: DenBossSnapshot | null;
  /**
   * Den states at this frame. A transition record carries the single affected
   * den; the periodic aggregate carries every den on the floor.
   */
  dens: DenBossSnapshot[];
}
