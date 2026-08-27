import type { Floor1BossRewardSpellId } from './abilities.js';
import type {
  GeneratedEquipmentInstanceId,
  GeneratedEquipmentRarity,
} from './generated-equipment-types.js';

/**
 * Enemy archetype identifier from the current floor's enemy pack.
 * Previously hardcoded as 'rat' | 'slime', now generalized to support any enemy ID.
 */
export type FloorEnemyArchetype = string;

/**
 * State for a single boss encounter inside a boss room.
 * Keyed by a stable string ID in `FloorObjectiveState.bossBattles`.
 */
export interface FloorBossEncounterState {
  /** True once the player enters the boss room and the battle begins. */
  started: boolean;
  /** EID of the spawned boss entity, or null if not yet spawned or already dead. */
  bossEid: number | null;
  /** True once the boss has been defeated. */
  defeated: boolean;
  /**
   * Last position (feet) the boss entity occupied while alive.
   *
   * Sampled every tick by the floor objective so the boss's reward chest can
   * drop where it actually died. Normal death cleanup clears the typed-array
   * component stores before the defeat branch runs, so reading the dead eid's
   * `Position` would return (0, 0) and strand the chest outside the dungeon.
   * Undefined until the boss has spawned.
   */
  lastKnownPos?: { x: number; y: number };
  /** True once the lethal-frame position has been captured and must not slide. */
  deathPosFrozen?: boolean;
  /** Display name shown in the HUD boss health bar. */
  displayName: string;
  /**
   * Loot table ID to use when this boss dies (see LOOT_TABLES in loot-tables.ts).
   * Undefined falls back to the standard BOSS table.
   */
  lootTableId?: string;
}

export interface FloorObjectiveState {
  readonly requiredRats: number;
  readonly requiredSlimes: number;
  readonly requiredGold: number;
  readonly requiredJunk: number;
  /**
   * Absolute elapsed-time threshold (ms) at which the floor collapses.
   * Mutable so that `floorObjectiveSystem` can advance it while the player
   * is in a safe room, effectively pausing the countdown.
   */
  deadlineMs: number;
  readonly staircaseSpawnCountdownMs: number;
  readonly safeRoomPos: { x: number; y: number };
  readonly staircasePos: { x: number; y: number };
  /** Position of the Welcome Office room where the Tutorial Goon NPC stands. */
  readonly welcomeOfficePos: { x: number; y: number };
  /** Position of the dedicated Slime Rat encounter room (separate from stair boss room). */
  readonly slimeRatRoomPos: { x: number; y: number };
  /** Position of the spell quest giver room. */
  readonly spellQuestGiverPos: { x: number; y: number };
  /** Position of the merchant's shop room where the Shopkeeper NPC stands. */
  readonly shopRoomPos: { x: number; y: number };
  /** Position where the shopkeeper's gross fetch item is dropped in the world. */
  readonly questItemPos: { x: number; y: number };
  readonly markerRadiusFt: number;
  /** True after the player talks to the Tutorial Goon and accepts the rat/slime quest. */
  questAccepted: boolean;
  /** True once the combined rat+slime kill target is met after quest acceptance. */
  questCompleted: boolean;
  ratsKilled: number;
  slimesKilled: number;
  goldCollected: number;
  junkCollected: number;
  safeRoomDiscovered: boolean;
  staircaseSpawnStartedMs: number | null;
  staircaseSpawnRemainingMs: number | null;
  staircaseSpawned: boolean;
  staircaseLocked: boolean;
  staircaseUnlocked: boolean;
  staircaseDiscovered: boolean;
  /**
   * Generic boss encounter registry, keyed by a stable boss ID string.
   * Floor 1 uses 'slime-rat' (spell-quest room) and 'staircase' (end-of-floor room).
   */
  bossBattles: Map<string, FloorBossEncounterState>;
}

export interface FloorRunSummary {
  outcome: 'failed_timeout' | 'cleared_floor';
  viewsEarned: number;
  fansEarned: number;
}

export interface FloorScenarioState {
  protagonistName: string;
  starterWeaponPool: readonly string[];
  starterChoices: string[];
  offeredRewardSpellIds?: Floor1BossRewardSpellId[];
  /** Deterministic Floor 1 Spell Broker stock; each offer is single-purchase. */
  spellBrokerOffers?: Floor1SpellBrokerOffer[];
  selectedWeaponId: string | null;
  selectedChoiceIndex: number | null;
  baseStatBonuses: {
    maxHp: number;
    moveSpeed: number;
    pickupRange: number;
  };
  enemyArchetypes: Map<number, FloorEnemyArchetype>;
  /** EID of the spawned Tutorial Goon NPC, or null if not yet spawned. */
  guideNpcEid: number | null;
  /** EID of the spawned spell-quest giver NPC, or null if not yet spawned. */
  spellQuestGiverNpcEid: number | null;
  /** EID of the spawned Shopkeeper NPC, or null if not yet spawned. */
  shopkeeperNpcEid: number | null;
  /** EID of the dropped fetch item, or null once collected/not spawned. */
  questItemEid: number | null;
  /**
   * Room id of the welcome-office hub (the carved set-piece prefab room), or
   * null if it could not be resolved. STABLE: unlike `objective.welcomeOfficePos`
   * — which is tightened to the tutorial-goon's live tile after NPC placement and
   * is explicitly NOT a room anchor — this is the fixed identity of the hub room,
   * so consumers (HUD markers, the reachability gate) can resolve the room
   * without depending on a mutable NPC-target tile.
   */
  welcomeRoomId?: number | null;
  /**
   * Ground-truth signal that the welcome-room prefab authoritatively CARVED (its
   * tile-write shell actually ran), persisted straight from
   * `carveWelcomeRoomPrefab`'s `fitted` result. Consumers (the reachability gate)
   * MUST use this rather than re-deriving carve success from `room.bounds ==
   * footprint`: Floor 1's config permits the generator to emit a coincidentally
   * 10x9 welcome room that `tagRoomAsSafe`/`sealSpecialRooms` then hardens, so a
   * bounds match can be true even on the render-only no-fit fallback — a false
   * "carved" that would let a silently-degraded floor pass the gate. `false` (or
   * absent) ⇒ degraded to the legacy render-only stamp; that is a hard gate
   * failure and a first-class degradation count, never an acceptable resting
   * state.
   */
  welcomeRoomCarved?: boolean;
  /**
   * Door entity IDs guarding each boss room, keyed by the same boss ID used in
   * `FloorObjectiveState.bossBattles` ('slime-rat', 'staircase', …).
   */
  bossRoomDoorEids: Map<string, number[]>;
  objective: FloorObjectiveState;
  failReason: 'stair_timeout' | null;
  runSummary: FloorRunSummary | null;
}

export interface Floor1SpellBrokerOffer {
  readonly spellId: Floor1BossRewardSpellId;
  readonly cost: number;
  purchased: boolean;
}

/**
 * Floor 2 · Slice 6 — a single line of a settlement shop's rolled inventory.
 * Prices are pre-computed at generation time (base × archetype × tier).
 */
export interface Floor2ShopInventoryItem {
  readonly itemId: string;
  readonly unitPrice: number;
  readonly stock: number;
}

/**
 * Floor 2 · Slice 6 — a spawned settlement shopkeeper NPC and its rolled
 * inventory. Held on the settlement snapshot so the HUD / shop UI can reach
 * an NPC's wares by eid.
 */
export interface Floor2ShopInstance {
  readonly archetypeId: string;
  readonly npcId: string;
  readonly npcEid: number;
  readonly inventory: readonly Floor2ShopInventoryItem[];
}

/** One exact generated instance offered by the Floor 2 Quartermaster. */
export interface Floor2QuartermasterStockOffer {
  readonly offerId: string;
  readonly instanceId: GeneratedEquipmentInstanceId;
  readonly rarity: Exclude<GeneratedEquipmentRarity, 'rare'>;
  readonly unitPrice: number;
  readonly quantity: 0 | 1;
}

/**
 * Authoritative Quartermaster stock owner. A new deterministic epoch retires
 * unsold prior offers so stale offer identities can never be purchased.
 */
export interface Floor2QuartermasterStockState {
  readonly stockId: string;
  readonly restockEpoch: number;
  readonly offers: readonly Floor2QuartermasterStockOffer[];
  readonly retiredInstanceIds: readonly GeneratedEquipmentInstanceId[];
}

/**
 * Floor 2 · Slice 6 — the settlement snapshot written to
 * `world.floorExtendedState.settlement` by `initializeFloor2Settlement`. Consumed by the
 * lab, tests, and HUD (Slice 7).
 */
export interface Floor2SettlementSnapshot {
  /** Anchor room id (the settlement bar) in `world.floorMap.roomGraph` for the SAFE settlement cluster. */
  readonly settlementRoomId: number;
  /** All room ids that compose the settlement cluster (bar + annex rooms). */
  readonly settlementRoomIds: readonly number[];
  /** EID of the spawned Broker NPC, or -1 if the def was not registered. */
  readonly brokerEid: number;
  /** EID of the spawned defected family member NPC, or -1 if the def was not registered. */
  readonly defectorEid: number;
  /** Present-family id the defector used to run with. */
  readonly defectorFamilyId: string;
  /** Preferred appearance key for the defected NPC (elite key). */
  readonly defectorAppearanceKey: string;
  /** Same-family fallback appearance key when preferred art is unavailable. */
  readonly defectorFallbackAppearanceKey: string;
  /** Guaranteed Quartermaster shop instance. */
  readonly quartermasterShop: Floor2ShopInstance;
  /**
   * Generated common/uncommon equipment stock owned by the Quartermaster.
   * Present only when the Floor 2 equipment economy consumer is enabled, or
   * when a previously persisted stock snapshot is being preserved while the
   * consumer is temporarily disabled.
   */
  readonly quartermasterStock?: Floor2QuartermasterStockState;
  /** 1–2 seeded non-Quartermaster shop instances. */
  readonly shops: readonly Floor2ShopInstance[];
}

/**
 * Floor 3 · Slice 8 — one Studio (or the Final Four roster) placed in the
 * world: the team ids its Trainers'/Handlers' Companions were spawned under,
 * and whether every one of those teams has been simultaneously KO'd (spec R6
 * "all Studio's Trainers' Companions are KO'd").
 */
export interface Floor3EncounterState {
  readonly id: string;
  readonly name: string;
  /**
   * One shared team id for every Trainer's Companions in a Studio (or every
   * Handler's Companions in the Final Four) — a single-element array kept for
   * shape-compatibility with `_isEncounterTeamsWiped`'s multi-team signature.
   * All of an encounter's Companions MUST share one team id: `companionAISystem`
   * treats any different-`Team.id` Companion as a rival, so per-Trainer team
   * ids would make Trainers within the same Studio (or Handlers within the
   * Final Four) fight each other before the player ever engages (plan-review
   * finding, slice 8).
   */
  readonly teamIds: readonly number[];
  /**
   * Room id the roster spawns in. Studios use carved `TERRITORY` biome rooms;
   * the Final Four uses a carved championship arena room (slice 9).
   */
  readonly roomId: number;
  /** Authored set-piece stamped into `roomId` for this encounter. */
  readonly setPieceId: string;
  /** True when the set-piece prefab became authoritative room geometry. */
  readonly setPieceCarved: boolean;
  /** Latched true once every teamId's Companions are simultaneously KO'd. */
  defeated: boolean;
  /**
   * Player level required to unlock this Studio (spec R6: "any-order
   * soft-gated ... requires the player's party to meet a floor-level
   * threshold, not a fixed sequence"). Assigned per Studio from the seeded
   * selection order, so unlock difficulty varies by seed. Unused (`0`) by
   * the Final Four, which gates on `studiosDefeatedCount` instead.
   */
  unlockLevel: number;
  /** True once `unlockLevel` has been met and this encounter's roster has spawned. */
  unlocked: boolean;
  /**
   * This Studio's Companions, deferred at floor init until `unlockLevel` is
   * met (spec R6 soft-gate) — mirrors `Floor3StudiosState.finalFourPendingSpawns`.
   * `floor3ObjectiveTick` spawns these once `unlocked` latches true and clears
   * the array so a re-tick never double-spawns. Unused by the Final Four,
   * which has its own `finalFourPendingSpawns` field.
   */
  pendingSpawns: readonly Floor3PendingRosterSpawn[];
  /**
   * The Companions this encounter's Trainers field, retained past spawning so
   * the poach picker (spec §6.2, UX surface #3) can still offer the full
   * roster after the encounter is defeated and despawned. Unused by the Final
   * Four, which is never poachable (it ends the floor).
   */
  readonly poachRoster: readonly Floor3PoachCandidate[];
  /**
   * Latched true once this encounter's defeat has produced a poach offer (or
   * was skipped because the party had already locked), so a defeated Studio
   * can never re-offer its roster on a later tick.
   */
  poachOffered: boolean;
}

/** One poachable Companion on a defeated Trainer's roster (spec §6.2). */
export interface Floor3PoachCandidate {
  readonly speciesId: string;
  readonly level: number;
}

/**
 * A pending Trainer-poach pick (spec §6.2, UX surface #3): written by
 * `floor3ObjectiveTick` when a Studio is defeated while the player's party
 * still has a recruit slot, and consumed by the Floor 3 loadout dispatcher.
 */
export interface Floor3PoachOffer {
  /** Id of the defeated encounter the offer came from (dedupe key). */
  readonly encounterId: string;
  /** Display name of the defeated Studio, for the picker subtitle. */
  readonly encounterName: string;
  /** The defeated roster in seeded offer order. */
  readonly candidates: readonly Floor3PoachCandidate[];
  /** Recruit slots left before the party locks, this pick included. */
  readonly slotsRemaining: number;
}

/** A single Companion an encounter gate spawns once it unlocks (deferred, spec R6 soft-gate). */
export interface Floor3PendingRosterSpawn {
  readonly speciesId: string;
  readonly level: number;
  readonly teamId: number;
  /** Pre-resolved world-space (ft) spawn position, when known at gate-creation time. */
  readonly x?: number;
  readonly y?: number;
}

/**
 * Floor 3 · Slice 8 — Studios + Final Four + objective-tick state written to
 * `world.floorExtendedState.floor3Studios` by `initializeFloor3Scenario`.
 * Mirrors Floor 2's `Floor2State` staircase fields (same win-path shape:
 * spawn -> unlock -> discover) for the shared stair-descend contract.
 */
export interface Floor3StudiosState {
  /** The 6 Studios selected for this run (spec R8: seeded, "6-of-~10"). */
  readonly studios: Floor3EncounterState[];
  /** The single Final Four roster (4 handlers) selected for this run. */
  readonly finalFour: Floor3EncounterState;
  /** Count of `studios` currently `defeated`. Convenience — always derivable from `studios`. */
  studiosDefeatedCount: number;
  /**
   * The Final Four's Companions, deferred at floor init (spec R6: the Final
   * Four is soft-gated behind the Studios-defeated counter, not present in
   * the world until it unlocks). `floor3ObjectiveTick` spawns these once and
   * clears the array so a re-tick never double-spawns.
   */
  finalFourPendingSpawns: readonly Floor3PendingRosterSpawn[];
  /** World-space (ft) position of the exit staircase. Set on victory. */
  staircasePos?: { x: number; y: number };
  /** True once the exit staircase tile has been spawned (Final Four defeated). */
  staircaseSpawned?: boolean;
  /** True once the staircase is accessible to the player. */
  staircaseUnlocked?: boolean;
  /** True once the player confirms descent — terminal run state. */
  staircaseDiscovered?: boolean;
  /**
   * ECS entity id of the single party Companion the player will keep
   * cross-floor (spec R7 §9.3, slice 11). Auto-defaulted to the player's
   * first party slot the moment victory latches, then overridable by
   * `selectFloor3KeptCompanion` (the end-of-floor picker hook) before the
   * floor-transition carryover is captured. `undefined` before victory.
   */
  keptCompanionEid?: number;
}

export type Floor4ActIndex = 1 | 2 | 3 | 4 | 5;

/**
 * One precomputed spawn instruction inside a wave manifest (spec FR3.2/FR3.4).
 * Immutable: the entry is rolled when the act arms and is never re-rolled, so a
 * cap-deferred (debted) entry releases with exactly the identity it was born
 * with.
 */
export interface Floor4WaveSpawnEntry {
  /** Archetype id, resolved against the Floor 4 arena enemy pack. */
  readonly archetypeId: string;
  /** Fixed feed-gate index this entry enters from (`FloorMap.feedGates`). */
  readonly gateIndex: number;
  /** Authored threat cost this entry consumed out of the wave budget. */
  readonly threatCost: number;
}

/** One act-relative wave: an immutable, ordered spawn manifest (spec FR3.2). */
export interface Floor4WaveManifest {
  readonly act: Floor4ActIndex;
  /** 0-based index within the act. */
  readonly waveIndex: number;
  /** Act-relative release mark in ms (`waveIndex * cadence.intervalMs`). */
  readonly releaseAtActMs: number;
  /** Threat budget this wave was composed against (FR3.3). */
  readonly budget: number;
  /** Spawn order. Also the FIFO order spawn debt is released in (FR3.5). */
  readonly entries: readonly Floor4WaveSpawnEntry[];
}

/** A manifest entry awaiting capacity — spawn debt (spec FR3.5). */
export interface Floor4PendingWaveSpawn {
  readonly waveIndex: number;
  /** The entry's index inside its wave manifest — drives deterministic gate stagger. */
  readonly slot: number;
  readonly entry: Floor4WaveSpawnEntry;
}

/** An armed gate telegraph: a gate lit ahead of a wave release (design §4). */
export interface Floor4GateTelegraph {
  readonly gateIndex: number;
  readonly waveIndex: number;
  /** Arena-clock ms at which the telegraphed wave releases. */
  readonly firesAtArenaMs: number;
}

/**
 * The live wave window for one act: immutable manifest content plus the mutable
 * release state that plays it back.
 *
 * The split is deliberate — `manifests` is frozen content derived purely from
 * the seed (FR3.2/FR7.4), while the cursor, debt and ownership below are the
 * only things cap pressure and player performance may perturb.
 */
export interface Floor4WaveWindowState {
  readonly act: Floor4ActIndex;
  /** Immutable per-act wave manifests, in wave order. */
  readonly manifests: readonly Floor4WaveManifest[];
  /** Next wave index to release; monotonic within the act. */
  releaseCursor: number;
  /** FIFO spawn debt in manifest order, bounded by `waves.concurrency.debtCap`. */
  debt: Floor4PendingWaveSpawn[];
  /** Gates currently lit for an imminent wave. */
  armedTelegraphs: Floor4GateTelegraph[];
  /** Live wave-owned enemies: entity id → owning wave index. */
  ownedEnemies: Map<number, number>;
}

/**
 * Pre-armed opening telegraph for an act whose wave window has not opened yet.
 *
 * Built during the final `gates.telegraphLeadMs` of the preceding phase and
 * handed to the window when it arms, so wave 0 gets the same authored warning
 * every later wave gets without its manifests being rebuilt or re-rolled.
 */
export interface Floor4PendingWaveWindow {
  readonly act: Floor4ActIndex;
  readonly manifests: readonly Floor4WaveManifest[];
  armedTelegraphs: Floor4GateTelegraph[];
}

/** Cumulative wave telemetry for a Floor 4 run (spec FR10.3). */
export interface Floor4WaveTelemetry {
  /** Waves whose manifest was released into the arena. */
  wavesReleased: number;
  /** Wave enemies actually spawned. */
  enemiesSpawned: number;
  /** Enemies removed by the cut at a wave-window boundary (FR3.6). */
  enemiesCut: number;
  /** Debt entries dropped because the debt cap was full (FR3.5). */
  debtDiscarded: number;
  /** Gate telegraphs armed. */
  gateTelegraphsArmed: number;
}

export type Floor4ArenaPhase =
  | { readonly kind: 'COUNTDOWN' }
  | { readonly kind: 'WAVES'; readonly act: Floor4ActIndex }
  | { readonly kind: 'HEADLINE'; readonly act: Floor4ActIndex; readonly cleared: boolean }
  | { readonly kind: 'OVERTIME'; readonly act: Floor4ActIndex }
  | { readonly kind: 'INTERMISSION'; readonly act: Floor4ActIndex }
  | { readonly kind: 'VICTORY' }
  | { readonly kind: 'DEFEAT' };

export interface Floor4ArenaPhaseTimelineEntry {
  readonly frame: number;
  readonly worldElapsedMs: number;
  readonly arenaElapsedMs: number;
  readonly phase: Floor4ArenaPhase;
  readonly reason: string;
}

export interface Floor4ArenaState {
  phase: Floor4ArenaPhase;
  arenaElapsedMs: number;
  phaseElapsedMs: number;
  lastWorldElapsedMs: number;
  timeline: Floor4ArenaPhaseTimelineEntry[];
  /**
   * Wave window for the act currently in `WAVES`. Undefined in every other
   * phase: the window is armed on entry to `WAVES(act)` and torn down at the
   * wave-window boundary, so no consumer can read stale release state.
   */
  waves?: Floor4WaveWindowState;
  /**
   * Gate telegraphs lit for the *next* act's opening wave, armed during the
   * final `gates.telegraphLeadMs` of COUNTDOWN/INTERMISSION.
   *
   * Wave 0 releases at `releaseAtActMs = 0`, so it can only get its authored
   * pre-spawn warning before its act's wave window exists. The manifests are
   * carried with it so the window arms on exactly the content it telegraphed.
   * Discarded at every phase boundary it is not consumed by (FR3.5).
   */
  pendingWaves?: Floor4PendingWaveWindow;
  /** Cumulative wave counters, retained across acts for RunStats. */
  waveTelemetry: Floor4WaveTelemetry;
}

export interface Floor4ArenaRunStats {
  readonly arenaElapsedMs: number;
  readonly phase: Floor4ArenaPhase;
  readonly timeline: readonly Floor4ArenaPhaseTimelineEntry[];
  readonly waveTelemetry: Floor4WaveTelemetry;
}

// Backward compatibility exports
export type Floor1EnemyArchetype = FloorEnemyArchetype;
export type Floor1ObjectiveState = FloorObjectiveState;
export type Floor1RunSummary = FloorRunSummary;
export type Floor1ScenarioState = FloorScenarioState;
