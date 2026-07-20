import type { Floor1BossRewardSpellId } from './abilities.js';

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
   * Door entity IDs guarding each boss room, keyed by the same boss ID used in
   * `FloorObjectiveState.bossBattles` ('slime-rat', 'staircase', …).
   */
  bossRoomDoorEids: Map<string, number[]>;
  objective: FloorObjectiveState;
  failReason: 'stair_timeout' | null;
  runSummary: FloorRunSummary | null;
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
  /** 1–2 seeded non-Quartermaster shop instances. */
  readonly shops: readonly Floor2ShopInstance[];
}

// Backward compatibility exports
export type Floor1EnemyArchetype = FloorEnemyArchetype;
export type Floor1BossEncounterState = FloorBossEncounterState;
export type Floor1ObjectiveState = FloorObjectiveState;
export type Floor1RunSummary = FloorRunSummary;
export type Floor1ScenarioState = FloorScenarioState;
