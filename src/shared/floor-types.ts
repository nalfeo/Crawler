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
  /** One team id per Trainer (Studio) / Handler (Final Four). */
  readonly teamIds: readonly number[];
  /**
   * Room id the roster spawned in (a `TERRITORY` biome zone for a Studio).
   * `-1` for the Final Four, which has no dedicated room yet — its physical
   * arena/set-piece is spec slice 9's deliverable; slice 8 only wires the
   * logical gate + roster.
   */
  readonly roomId: number;
  /** Latched true once every teamId's Companions are simultaneously KO'd. */
  defeated: boolean;
}

/** A single Companion the Final Four gate spawns once it unlocks (deferred, spec R6 soft-gate). */
export interface Floor3PendingRosterSpawn {
  readonly speciesId: string;
  readonly level: number;
  readonly teamId: number;
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
}

// Backward compatibility exports
export type Floor1EnemyArchetype = FloorEnemyArchetype;
export type Floor1BossEncounterState = FloorBossEncounterState;
export type Floor1ObjectiveState = FloorObjectiveState;
export type Floor1RunSummary = FloorRunSummary;
export type Floor1ScenarioState = FloorScenarioState;
