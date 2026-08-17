/**
 * ECS World factory.
 * Creates and configures a bitecs world with component stores and observers.
 *
 * bitecs 0.4 uses observer-based data: set() fires onSet observers that
 * populate typed-array stores. Systems read stores directly for performance.
 */
import { createWorld as createBitecsWorld, observe, onSet } from 'bitecs';
import { SeededRandom } from '../shared/random.js';
import type { InventoryBag } from '../shared/inventory.js';
import type { StatusEffect } from '../shared/status-effect-types.js';
import type { CombatEvent } from '../shared/combat-events.js';
import type { VfxEvent } from '../shared/vfx-events.js';
import type { FloaterEvent } from '../shared/floater-events.js';
import type { AnnouncementEvent } from '../shared/announcement-events.js';
import type { AbilityActivationEvent } from '../shared/ability-activation-events.js';
import type { MobAbilityRuntime } from './mob-abilities/types.js';
import { createMobAbilityRuntime } from './mob-abilities/types.js';
import type { AbilityState, AbilityTriggerEvent } from '../shared/abilities.js';
import type {
  BloodFootprintSurface,
  BloodPoolSurface,
  BloodyFootprintState,
} from '../shared/blood-surfaces.js';
import { createBloodyFootprintState } from '../shared/blood-surfaces.js';
import { createLogger } from '../shared/logger.js';
import type { DoorLockConfig } from './door-lock.js';
import type { WeaponTelemetry } from './weapon-telemetry.js';
import type { RunEventCollector } from './run-events.js';
import type { FloorMap } from './map/FloorMap.js';
import {
  createBarrierRegistry,
  type BarrierHandle,
  type BarrierRegistry,
} from './barriers/index.js';
import {
  createGeneratedEquipmentRegistry,
  type GeneratedEquipmentRegistry,
} from './generated-equipment-registry.js';
import type {
  GeneratedEquipmentGenerationPolicyV1,
  GeneratedEquipmentRewardBundleV1,
} from '../shared/generated-equipment-types.js';
import type { BossChestRecord } from './systems/bossChestRewards.js';
import {
  Position,
  Velocity,
  Rotation,
  Health,
  Damage,
  Projectile,
  XpGem,
  Sprite,
  EnemyBehavior,
  Spawner,
  BroadcastScore,
  DroppedItem,
  Owner,
  Team,
  Lifetime,
  AreaDamage,
  AoeOnImpact,
  Returning,
  Bouncing,
  LineDamage,
  Trap,
  MeleeSwing,
  Knockback,
  DoorState,
  DeathTimer,
  SpawnAnim,
  BaseStats,
  EffectiveStats,
  DamageMeta,
  Gold,
  Npc,
  Weight,
  Size,
  BloodColor,
  Prop,
  PropLight,
  Harvestable,
  FamilyMembership,
  createComponentStores,
  type ComponentStores,
} from './components.js';
import type {
  StatModifier,
  SkillState,
  SkillUsageEvent,
  PlayerLevel,
  MilestoneGrantEvent,
} from '../shared/skills.js';
import type { FloorScenarioState, Floor2SettlementSnapshot } from '../shared/floor-types.js';
import type { NpcInstance } from '../shared/npc-types.js';
import type { SetPiecePropInstance } from '../shared/set-piece-render.js';
import type { QuestState } from '../shared/quest-types.js';
import type { QuestEvent } from '../shared/quest-events.js';
import type {
  GeneratedSpriteRegistry,
  NormalizedWeaponAnchor,
} from '../shared/generated-assets.js';
import type {
  FamilyId,
  FactionRelationChangedEvent,
  FactionRelationDelta,
  Floor2State,
} from './faction-relations.js';
import {
  createEmptyAchievementFactSnapshot,
  type AchievementFactSnapshot,
  type LootBoxRewardBundleV1,
} from '../shared/achievements.js';
import type { ResolvedRewardPresentation } from '../shared/reward-presentation.js';

const logger = createLogger('core:world');

/**
 * Floor-specific extended state that varies by scenario type. Populated by the
 * floor initializer; `null` on floors that don't use these mechanics.
 */
export interface FloorExtendedState {
  /** Family faction state for floors with a families mechanic (e.g. Floor 2). */
  familyState?: Floor2State;
  /** Settlement snapshot for floors with a settlement mechanic (e.g. Floor 2). */
  settlement?: Floor2SettlementSnapshot;
  /** Trash territory assignments for floors with territorial trash spawning (e.g. Floor 2). Maps quadrant ID ('N', 'S', 'E', 'W') to archetype ID. */
  trashTerritories?: Map<string, string>;
  /** Ambient enemies tracked by the floor director when `world.floorScenario` is intentionally null (e.g. Floor 2). */
  ambientEnemyArchetypes?: Map<number, string>;
}

/**
 * Cumulative loot accounting for a world session: how much XP/gold value was
 * spawned into the world versus how much the player actually collected.
 * Purely additive counters — never decremented, never reset mid-floor — so
 * `collected / spawned` is a deterministic collection-efficiency ratio.
 */
export interface LootLedger {
  /** Total XP gem value spawned into the world. */
  xpSpawned: number;
  /** Total XP gem value picked up by the player. */
  xpCollected: number;
  /** Total gold value spawned into the world. */
  goldSpawned: number;
  /** Total gold value picked up by the player. */
  goldCollected: number;
}

/** Create a zeroed loot ledger. */
export function createLootLedger(): LootLedger {
  return { xpSpawned: 0, xpCollected: 0, goldSpawned: 0, goldCollected: 0 };
}

/**
 * Deterministic gold economy accounting: where the run's gold came from and
 * where it went. Purely additive counters (never decremented) so
 * `spentTotal / earnedTotal` is a stable spend-through metric and
 * `earnedTotal - spentTotal` reconstructs the unspent balance independently
 * of `playerGold` (which is also mutated by carryover).
 *
 * Deliberately **not** part of the player carryover snapshot: it measures a
 * single floor session's economy, which is exactly the quantity the Floor 1
 * pricing gate is written against.
 */
export interface GoldLedger {
  /** Gold picked up off the floor (drops, chests, piles). */
  earnedFromDrops: number;
  /** Gold granted by claimed achievement loot boxes. */
  earnedFromLootBoxes: number;
  /** Gold spent on the Floor 1 merchant's charm. */
  spentOnCharm: number;
  /** Gold spent on post-quest merchant weapons. */
  spentOnMerchantWeapon: number;
  /** Gold spent at the Floor 1 Spell Broker. */
  spentOnSpell: number;
  /** Number of charm purchases (0 or 1 per run). */
  charmPurchases: number;
  /** Number of post-quest merchant weapon purchases. */
  merchantWeaponPurchases: number;
  /** Number of Spell Broker spell purchases. */
  spellPurchases: number;
  /**
   * Gold earned at the moment the floor exit was confirmed, i.e. the income the
   * run could still convert into power at a Floor 1 vendor. `null` until the
   * floor completes.
   *
   * This exists because Floor 1 grants a large share of its income through
   * floor-clear achievement loot boxes that resolve *after* the last vendor
   * window; that gold is Floor 2 seed money by construction and can never
   * appear as Floor 1 spend.
   */
  earnedBeforeExit: number | null;
}

/** Create a zeroed gold ledger. */
export function createGoldLedger(): GoldLedger {
  return {
    earnedFromDrops: 0,
    earnedFromLootBoxes: 0,
    spentOnCharm: 0,
    spentOnMerchantWeapon: 0,
    spentOnSpell: 0,
    charmPurchases: 0,
    merchantWeaponPurchases: 0,
    spellPurchases: 0,
    earnedBeforeExit: null,
  };
}

/**
 * Latch {@link GoldLedger.earnedBeforeExit} at floor completion, before the
 * run-end achievement phase grants its loot boxes. Idempotent — the first call
 * wins, so a re-entered completion path cannot inflate the spendable income.
 */
export function markGoldLedgerFloorExit(world: GameWorld): void {
  if (world.goldLedger.earnedBeforeExit !== null) return;
  world.goldLedger.earnedBeforeExit =
    world.goldLedger.earnedFromDrops + world.goldLedger.earnedFromLootBoxes;
}

/** One item a vendor had on offer at the moment it was visited. */
export interface VendorStockEntry {
  readonly itemId: string;
  readonly cost: number;
}

/** A single interaction with a vendor, with the inventory it was offering. */
export interface VendorVisitRecord {
  /** Stable vendor identity (e.g. `floor1-merchant`, `floor1-spell-broker`). */
  readonly vendorId: string;
  /** Simulated game time (ms) of the visit. */
  readonly gameTimeMs: number;
  /** Simulation frame of the visit; also dedupes same-frame re-entry. */
  readonly frame: number;
  /** Gold the player held on arrival — the budget the decision was made against. */
  readonly playerGold: number;
  /** Inventory the vendor was offering at that moment. */
  readonly stock: readonly VendorStockEntry[];
}

/**
 * What the shopper decided at a vendor.
 *
 * `wanted` — intended to buy a specific item (the intent was formed).
 * `purchased` — the intent completed and gold changed hands.
 * `unaffordable` — wanted the item but could not pay for it yet.
 * `declined` — chose not to buy (e.g. no weapon-class switch this run).
 * `abandoned` — gave the intent up (deficit unfarmable inside the run budget).
 */
export type VendorDecisionOutcome =
  | 'wanted'
  | 'purchased'
  | 'unaffordable'
  | 'declined'
  | 'abandoned';

/** A decision made at a vendor, and the budget it was made against. */
export interface VendorDecisionRecord {
  readonly vendorId: string;
  /** Item the decision was about; `null` when no item could be chosen. */
  readonly itemId: string | null;
  /** Asking price of `itemId` (0 when unknown). */
  readonly cost: number;
  readonly outcome: VendorDecisionOutcome;
  /** Gold held when the decision was made. */
  readonly playerGold: number;
  readonly gameTimeMs: number;
  readonly frame: number;
  /** Short machine-stable reason tag, e.g. `insufficient-gold`. */
  readonly reason: string;
}

/**
 * Deterministic per-run vendor telemetry: every merchant visit (with the
 * inventory on offer) and every shopping decision, including the ones that
 * *wanted* to buy but could not pay. Purely observational — nothing in the
 * simulation reads it back, so recording can never change gameplay.
 */
export interface VendorLedger {
  visits: VendorVisitRecord[];
  decisions: VendorDecisionRecord[];
  /** Visits/decisions beyond {@link _VENDOR_LEDGER_MAX_ENTRIES}, counted only. */
  droppedVisits: number;
  droppedDecisions: number;
  /**
   * Same-frame dedup keys, tracked independently of the retained record
   * arrays. Once the retention cap is hit the tail stops growing, so a
   * dedup check against `visits[visits.length - 1]`/`decisions[...]` would
   * keep comparing against a stale entry and double-count every subsequent
   * same-frame re-entry as a fresh dropped visit/decision.
   */
  lastVisitKey: string | null;
  lastDecisionKey: string | null;
}

/**
 * Cap on retained visit/decision records. A run interacts with a vendor many
 * times (the AI re-targets on a cooldown), so the tail is bounded and the
 * overflow is counted instead of retained — RunStats must stay a small,
 * serializable object.
 */
export const _VENDOR_LEDGER_MAX_ENTRIES = 64;

/** Create an empty vendor ledger. */
export function createVendorLedger(): VendorLedger {
  return {
    visits: [],
    decisions: [],
    droppedVisits: 0,
    droppedDecisions: 0,
    lastVisitKey: null,
    lastDecisionKey: null,
  };
}

/**
 * Record a vendor visit. Same-vendor re-entry inside one frame collapses into
 * a single visit so a meet + purchase in the same tick is not double counted.
 */
export function recordVendorVisit(
  world: GameWorld,
  vendorId: string,
  stock: readonly VendorStockEntry[],
): void {
  const ledger = world.vendorLedger;
  const key = `${vendorId}:${world.frameCount}`;
  if (ledger.lastVisitKey === key) {
    return;
  }
  ledger.lastVisitKey = key;
  if (ledger.visits.length >= _VENDOR_LEDGER_MAX_ENTRIES) {
    ledger.droppedVisits += 1;
    return;
  }
  ledger.visits.push({
    vendorId,
    gameTimeMs: world.elapsedMs,
    frame: world.frameCount,
    playerGold: world.playerGold,
    stock: stock.map((entry) => ({ itemId: entry.itemId, cost: entry.cost })),
  });
}

/**
 * Record a vendor decision. Consecutive identical decisions (same vendor, item,
 * outcome and reason) collapse, because the AI re-polls a pending intent every
 * tick — the ledger records state *changes*, not poll counts.
 */
export function recordVendorDecision(
  world: GameWorld,
  decision: Omit<VendorDecisionRecord, 'gameTimeMs' | 'frame' | 'playerGold'>,
): void {
  const ledger = world.vendorLedger;
  const key = `${decision.vendorId}:${decision.itemId}:${decision.outcome}:${decision.reason}`;
  if (ledger.lastDecisionKey === key) {
    return;
  }
  ledger.lastDecisionKey = key;
  if (ledger.decisions.length >= _VENDOR_LEDGER_MAX_ENTRIES) {
    ledger.droppedDecisions += 1;
    return;
  }
  ledger.decisions.push({
    ...decision,
    playerGold: world.playerGold,
    gameTimeMs: world.elapsedMs,
    frame: world.frameCount,
  });
}

export interface GameWorld {
  /** The bitecs ECS world instance */
  ecs: ReturnType<typeof createBitecsWorld>;
  /** Typed-array component stores — read directly: stores.position.x[eid] */
  stores: ComponentStores;
  /**
   * Monotonic cosmetic spawn identity per EID. Renderers use it to distinguish
   * recycled entities without consulting or mutating gameplay state.
   */
  entityRenderGeneration: Uint32Array;
  /** Counter backing {@link entityRenderGeneration}; zero is reserved for unset slots. */
  nextEntityRenderGeneration: number;
  /** Seeded RNG — never use Math.random() */
  rng: SeededRandom;
  /**
   * Run seed (the value `rng` was constructed from). Stable for the whole run
   * and replay-safe. Combine with a per-key hash (see `hashStringToSeed`) to make
   * deterministic choices WITHOUT consuming the `rng` stream — e.g. selecting a
   * generated-sprite variant per item id.
   */
  readonly seed: number;
  /** Current frame count */
  frameCount: number;
  /** Time elapsed in current floor (ms) */
  elapsedMs: number;
  /**
   * Monotonic signal for newly activated hostile encounter lock-ins.
   * AI providers consume this at poll boundaries to discard transient plans
   * made before the encounter existed.
   */
  hostileEncounterRevision: number;
  /** Optional hostile-damage multiplier for simulation/testing modes (default 1). */
  hostileDamageMultiplier?: number;
  /**
   * Optional world-level override (ms) for the enemy-projectile telegraph
   * delay, resolved via `getEffectiveTelegraphMs()` (core/systems/enemyTelegraph.ts)
   * as `mob.telegraphMs ?? world.enemyTelegraphMs ?? ENEMY_PROJECTILE.TELEGRAPH_MS`.
   * Undefined (production default) falls through to the constant 250ms. Set
   * directly by the headless CLI's `--enemy-telegraph-ms <n>` flag; `0` is a
   * legitimate value that reproduces exact legacy (no-telegraph) behavior.
   */
  enemyTelegraphMs?: number;
  /** Current floor number (1-indexed) */
  floor: number;
  /** Game state */
  state: 'loading' | 'loadout' | 'playing' | 'paused' | 'safe_room' | 'game_over' | 'level_up';
  /**
   * Player's chosen display name. Defaults to the floor-1 protagonist ('Rhea Vale').
   * Set by IntroScene before the run starts; headless/lab runs keep the default.
   */
  playerName: string;
  /** Player's chosen gender. Defaults to 'female'. Set by IntroScene. */
  playerGender: 'female' | 'male' | 'other';

  // --- Stats/Skills/Levels (player-singleton, stored at world level) ---

  /** Player level state — JS numbers to avoid Uint16 cap and float precision issues. */
  playerLevel: PlayerLevel;
  /** Active stat modifiers from skills, floors, and buffs. Filtered by statsSystem. */
  statModifiers: StatModifier[];
  /** Per-skill state keyed by skill id. */
  playerSkills: Map<string, SkillState>;
  /** Per-entity skill state keyed by holder eid, then by skill id. */
  skillStatesByEntity: Map<number, Map<string, SkillState>>;
  /** Usage events emitted this frame — cleared at end of skillSystem after processing. */
  skillUsageEvents: SkillUsageEvent[];
  /**
   * Append-only log of every milestone ability grant during this run.
   * Never cleared — read by headless runner at run end for RunStats.
   */
  milestoneGrantLog: MilestoneGrantEvent[];
  /**
   * Active weapon skill IDs keyed by attacker EID (player).
   * Set by weaponSystem after a successful accuracy check; read by damage
   * systems (melee/projectile/beam/area) to emit skill XP when damage lands.
   */
  attackerWeaponSkills: Map<number, { classSkillId: string; typeSkillId: string }>;
  /**
   * Weapon skill IDs keyed by spawned attack entity EID (projectile/beam/swing/trap/AoE).
   * Preferred over `attackerWeaponSkills` so delayed hits keep the weapon that spawned them.
   */
  attackWeaponSkillsByEntity: Map<number, { classSkillId: string; typeSkillId: string }>;
  /** Per-entity ability state keyed by holder eid. */
  abilityStatesByEntity: Map<number, AbilityState>;
  /** Trigger events emitted this frame — cleared at end of abilitySystem. */
  abilityTriggerEvents: AbilityTriggerEvent[];
  /** Per-entity inventory bags (eid → bag). Side-car for variable-length data. */
  inventories: Map<number, InventoryBag>;
  /** Authoritative generated-equipment records for this run. */
  generatedEquipmentRegistry: GeneratedEquipmentRegistry;
  /** Unopened generated-equipment reward bundles keyed by achievement ID. */
  generatedEquipmentRewardBundles: Map<string, GeneratedEquipmentRewardBundleV1>;
  /** Boss chest lifecycle records keyed by chest ID (`boss-chest:<familyId>`). */
  bossChests: Map<string, BossChestRecord>;
  /**
   * Reverse lookup: physical boss-chest ECS entity ID keyed by chest ID.
   * Populated when `spawnBossChestEntity` creates the world-object; cleared when
   * `bossChestPickupSystem` removes the entity after the player opens it.
   */
  bossChestEids: Map<string, number>;
  /**
   * Unclaimed Floor 1 `lootBox` reward bundles keyed by achievement ID.
   * Resolved once at unlock (see `resolveLootBoxRewardBundle`) and consumed
   * read-only by `claimAchievementReward` — no RNG at claim/load/presentation.
   */
  lootBoxRewardBundles: Map<string, LootBoxRewardBundleV1>;
  /** Per-entity active status effects (eid → effects). Side-car for variable-length data. */
  statusEffectsByEntity: Map<number, StatusEffect[]>;
  /** Per-door lock configurations (eid → lock config). */
  doorLockConfigs: Map<number, DoorLockConfig>;
  /** Scenario/world objective flags used by lock conditions and other systems. */
  goalFlags: Map<string, boolean>;
  /** Combat events emitted this frame — consumed and drained by the render layer. */
  combatEvents: CombatEvent[];
  /**
   * Lethal damage ownership that must survive the render layer draining
   * `combatEvents` before `dropSystem` processes the target next frame.
   */
  lethalDamageSourceByTarget: Map<number, number>;
  /**
   * Durable record of the most recent damaging hit that landed on the player,
   * written at the `applyDamage` choke point. Unlike {@link combatEvents} —
   * which the render layer drains every rendered frame (`combatVfx.update`)
   * BEFORE the next frame's AI prepass runs — this field persists across
   * frames. Floor 2 Slice 3's ally-defend retaliation reads it so it observes
   * the attacker in the REAL visual frame loop, not just in headless (which
   * never drains the queue). `attackerEid` can be stale a frame later, so
   * consumers must re-validate the entity before targeting it.
   */
  lastPlayerHit?: { attackerEid: number; atMs: number };
  /**
   * Optional, OFF-by-default per-run weapon telemetry (player swings, connecting
   * hits, accuracy, multi-hit rate). `undefined` = disabled → the shipping sim
   * and Floor-1 gate see zero behavior/allocation cost. Opt-in surfaces (headless
   * runner `recordWeaponTelemetry`, PlayerSessionRecorder `recordWeaponTelemetry`)
   * assign a collector via `createWeaponTelemetry()`. See `weapon-telemetry.ts`.
   */
  weaponTelemetry?: WeaponTelemetry;
  /**
   * Optional, OFF-by-default collector for successful run item activations.
   * The headless runner owns timestamps, offers, selections, and aggregation.
   */
  runEvents?: RunEventCollector;
  /**
   * Max REALIZED knockback displacement (feet) applied to any entity this frame.
   * Reset to 0 at the top of `knockbackSystem` and accumulated (max) there after
   * each entity's final post-clamp position is written. Read by `beamSystem` to
   * inflate its spatial-hash broad-phase radius so a beam still finds targets the
   * grid indexed at a now-stale (pre-knockback) position — the grid is built by
   * `collisionSystem`, then `knockbackSystem` moves entities, then `beamSystem`
   * queries the stale grid. Determinism-load-bearing (see the superset proof in
   * beamSystem); NOT a gameplay value. Measuring realized (not commanded)
   * displacement keeps the bound writer-agnostic and wall-clamp-aware.
   */
  maxKnockbackStepThisFrame: number;
  /**
   * Generic cosmetic VFX effect-requests emitted this frame — drained by the
   * engine-layer EffectsVfx renderer. Cosmetic-only; never read by game logic.
   */
  vfxEvents: VfxEvent[];
  /**
   * Cosmetic non-combat floating-text requests (skill level-ups today) emitted
   * this frame — drained by the engine-layer `CombatVfx` renderer. Data-only;
   * never read by game logic. Capped defensively by `pushFloaterEvent`.
   */
  floaterEvents: FloaterEvent[];
  /**
   * HUD announcement banner events pushed by systems (arena start/end today,
   * extensible). Drained by the engine-layer `HudAnnouncementBanner`. Data-only
   * so `src/core` stays portable. Capped defensively by `pushAnnouncement`.
   */
  announcements: AnnouncementEvent[];
  /**
   * Player active/spell ability activations emitted this frame — drained by the
   * engine-layer floating-text renderer, which shows the ability name above the
   * player. Cosmetic-only; never read by game logic. Capped defensively by
   * `pushAbilityActivationEvent`.
   */
  abilityActivations: AbilityActivationEvent[];
  /** Persistent blood pools authored by simulation-side death/contact logic. */
  bloodPools: BloodPoolSurface[];
  /** Persistent bloody footprints/smears authored by the core step. */
  bloodyFootprints: BloodFootprintSurface[];
  /** Active bloody-footprint source window + overlap tracking. */
  bloodyFootprintState: BloodyFootprintState;
  /**
   * Typed mob-ability runtime (Queen Mab Verdigris Glamour + future generic mob
   * abilities). Default-disabled: the normal game never registers active boss
   * ability definitions or emits casts. Only the combat-arena lab enables it and
   * activates the encounter. Phaser-free; the renderer consumes committed cue
   * state. See `src/core/mob-abilities/`.
   */
  mobAbilities: MobAbilityRuntime;
  /**
   * Per-spawner cached door entity IDs for a sealed-room arena. Populated at
   * arena trigger, cleared once the arena resolves. Side-car (not SoA) because
   * bitecs typed arrays cannot store variable-length door lists.
   */
  spawnerArenaDoors: Map<number, number[]>;
  /**
   * Per-spawner barrier handles raised while the arena is armed. One entry
   * per spawner for the ring (open-fence) or doorway plug (sealed-room);
   * both are dropped on resolve. Replaces the pre-PR-#767 `spawnerArenaFence`
   * side-car (which mutated `TileMap.flags` and produced leaky cages when the
   * ring landed on walls — see ADR 0050).
   */
  spawnerArenaBarriers: Map<number, BarrierHandle>;
  /**
   * First-class barrier registry — the single source of truth for dynamic,
   * tile-granular impassable overlays. Movement, projectile cleanup, and
   * pathfinding consult this instead of mutating `TileMap.flags`. See
   * `src/core/barriers/` and ADR 0050.
   */
  barriers: BarrierRegistry;
  /**
   * Per-spawner "ever raised a *real* barrier" latch. Set at idle → locked
   * only when a non-empty barrier handle is stored, and not cleared on resolve.
   * This keeps headless telemetry honest by excluding IDLE→RESOLVED
   * short-circuits where the spawner died before it ever physically caged the
   * player.
   */
  spawnerArenaEverArmed: Set<number>;
  /** Player's gold (currency) — separate from BroadcastScore (reality show rating). */
  playerGold: number;
  /**
   * Deterministic cumulative ledger of loot value that entered the world versus
   * loot value the player actually picked up. Spawn counters are incremented by
   * `spawnXpGem` / `spawnGold`; collected counters by `itemPickupSystem`. Unlike
   * end-of-run ground scans, these survive floor transitions destroying pickups,
   * so `collected / spawned` is a stable collection-efficiency metric.
   */
  lootLedger: LootLedger;
  /**
   * Deterministic per-floor gold economy accounting (earned split by source,
   * spent split by vendor). Incremented by `itemPickupSystem` (drops),
   * `achievementRewards` (loot boxes) and the Floor 1 purchase functions in
   * `floorScenario`. Drives the Floor 1 pricing gate.
   */
  goldLedger: GoldLedger;
  /**
   * Deterministic per-run vendor telemetry: merchant visits (with the stock on
   * offer) and shopping decisions, including intents that could not be paid
   * for. Written by the Floor 1 vendor entry points and the AI purchase
   * intents; read only by run-stats assembly.
   */
  vendorLedger: VendorLedger;
  /**
   * Running maximum gold balance seen this floor session. Updated by `achievementSystem`
   * each tick so the "Hoarder's Ledger" run-global achievement can fire even after the
   * player spends down to < 800.  Resets to 0 on floor load; the carried peak from
   * previous floors is preserved in `achievements.carriedRunFacts.numberFacts.peakGold`.
   */
  peakGold: number;
  /** Procedurally generated floor map — null until floor is loaded. */
  floorMap: FloorMap | null;
  /**
   * String identifier for the current floor (e.g. `'floor1'`, `'floor2'`).
   * Set by each floor's scenario initializer. Empty string when no floor is loaded.
   */
  floorId: string;
  /** Current floor scenario state — populated when a floor run is active, null otherwise. */
  floorScenario: FloorScenarioState | null;
  /**
   * Lab-only display hint: when true, the HUD floor countdown timer is hidden.
   * Real floor runs leave this false; lab spawner-arena presets set it so the
   * `FLOOR.MAX_DURATION_S` fallback countdown doesn't show a spurious 5:00.
   */
  hideFloorTimer: boolean;
  /**
   * Floor-specific extended state for floors that use families / settlement
   * mechanics. Populated by the floor initializer; `null` on floors that don't
   * use these mechanics (e.g. Floor 1).
   */
  floorExtendedState: FloorExtendedState | null;
  /**
   * Floor 2 per-family relationship values, clamped `[0, 100]`. Single source
   * of truth (ADR 0040 · D1) — mobs read this at decision time via the
   * helpers in `src/core/faction-relations.ts`, never store it per-entity.
   */
  factionRelations: Map<FamilyId, number>;
  /**
   * Change events emitted this frame by `adjustFactionRelation`. Consumed by
   * the HUD widget (Slice 7) and quest triggers; drained by the render/HUD
   * layer, never trusted to persist between frames.
   */
  factionRelationEvents: FactionRelationChangedEvent[];
  /**
   * Queued relationship deltas awaiting `familyRelationshipSystem`. Combat,
   * quest, and emergent-event systems push here; the system drains + applies
   * every tick.
   */
  factionRelationDeltas: FactionRelationDelta[];
  /**
   * Per-world timestamp (`elapsedMs`) at which `familyRelationshipSystem` last
   * applied passive relationship decay. `null` until the decay branch first
   * runs. Held on the world (not a module-level map) so decay timing is
   * per-world, serializable, and reset with the world.
   */
  factionRelationDecayLastMs: number | null;
  /**
   * Generic per-floor objective tick registered by each floor's scenario at
   * initialisation. `floorObjectiveSystem` calls this every frame so no
   * floor needs its own named system slot in `postSystems`.
   */
  floorObjectiveTick: ((world: GameWorld) => void) | null;
  /** Per-entity NPC instance state (eid → NpcInstance). Side-car for variable-length NPC data. */
  npcs: Map<number, NpcInstance>;
  /**
   * Render-only set-piece prop layers, in draw order, produced by the set-piece
   * stamping pass ({@link SetPiecePropInstance}). The engine renders this list in
   * a dedicated pass so authored set-piece dressing shows its own
   * sprite/depth/footprint/tint. These are deliberately NOT ECS entities: they
   * consume no entity ids, so ambient mobs and drops keep their ids and the
   * cosmetic dressing never perturbs collision order, RNG, or balance (see
   * `set-piece-render.ts` for the full rationale).
   */
  setPieceProps: SetPiecePropInstance[];
  /**
   * Stable per-enemy appearance identity (eid → archetype/mob key). The engine
   * uses this to resolve generated-art families more precisely than textureId
   * buckets alone.
   */
  enemyAppearanceKeys: Map<number, string>;
  /**
   * Archetype-key snapshot for enemy projectile and AoE explosion entities,
   * keyed by entity EID. Covers two entity phases:
   *
   * - **In-flight projectiles**: populated in `spawnEnemyProjectile` and
   *   `spawnAoeProjectile` while the shooter is still live. `damageSystem` reads
   *   the entry and passes it as `DamageOptions.sourceArchetypeKey` so
   *   `apply-damage` emits a stable attribution even after shooter death or EID
   *   recycling.
   *
   * - **AoE explosion entities**: `aoeOnImpactSystem` copies the projectile's
   *   entry onto the spawned explosion EID (`aoeOnImpactPostDamage`);
   *   `areaDamageSystem` reads it for the splash-hit attribution and then deletes
   *   it via `clearAreaDamageHits`.
   *
   * Entries are explicitly managed: `clearEntityStores` deletes the entry on
   * every entity removal or EID recycle, and each enemy-projectile/AoE spawn sets
   * a fresh entry when the owner archetype is known. This ensures neither
   * `damageSystem` nor `areaDamageSystem` ever reads a stale snapshot from a
   * previous occupant of the same EID.
   */
  enemyProjectileArchetypeKeys: Map<number, string>;
  /**
   * Generated sprite registry sourced from the approved-sprite manifest. Set by
   * the engine layer (PhaserBridge) when the registry loads or changes, and used
   * by game-layer helpers (see `getEntityNormalizedWeaponAnchor`) to resolve
   * per-entity weapon-anchor offsets without importing Phaser or engine code.
   * Null in headless runs and before the first registry load.
   */
  generatedSpriteRegistry: GeneratedSpriteRegistry | null;
  /**
   * Per-entity normalized weapon-anchor offsets, keyed by entity id.
   *
   * Stores a {@link NormalizedWeaponAnchor}: dimensionless COG-relative offsets
   * (`relX`, `relY`) and the art's canonical facing direction (`artFacing`).
   * Populated lazily by {@link getEntityNormalizedWeaponAnchor} (game layer) on
   * first access; cleared by PhaserBridge on entity visual removal.
   *
   * Consumers apply mirroring when the entity's current facing differs from
   * `artFacing`, then multiply by the sprite's visual dimension in feet to
   * get a world-space offset:
   *
   *   ```ts
   *   const needsMirror = wa.artFacing !== (facingRight ? 'right' : 'left');
   *   const offsetX = (needsMirror ? -wa.relX : wa.relX) * spriteWidthFt;
   *   ```
   */
  entityWeaponAnchors: Map<number, NormalizedWeaponAnchor>;
  /** Active/completed quests keyed by quest id. Drives the quest tracker HUD. */
  questLog: Map<string, QuestState>;
  /** Quest progression events queued this frame. Drained by questSystem. */
  questEvents: QuestEvent[];
  /** Progressively-unlocked UI features. Latched true; never reset to false mid-run. */
  featureUnlocks: {
    /** Inventory panel becomes usable once unlocked (Floor 1: on key-item pickup). */
    inventory: boolean;
    /** Equipment actions become usable once the player holds something equippable. */
    equipment: boolean;
    /** Ability system and spells become usable once unlocked (Floor 1: after boss quest). */
    spells: boolean;
  };
  /** Runtime achievement state for the active run. */
  achievements: {
    /** Achievement IDs unlocked this run. */
    unlockedIds: Set<string>;
    /** Newly unlocked IDs waiting to be surfaced by UI. */
    pendingUnlockIds: string[];
    /** Achievement IDs whose reward has been opened/claimed this run. */
    claimedIds: Set<string>;
    /**
     * Resolved `lootBox`/`equipment` reward snapshots waiting to be
     * shown/acknowledged by the reward-opening presentation UI, keyed by
     * achievement id. Populated by `claimAchievementReward` (atomically, at
     * the same time as the grant) and consumed by
     * `acknowledgeAchievementRewardPresentation` once the UI sequence
     * finishes/skips to the end. Surviving reload lets a mid-sequence
     * interruption resume exactly where it left off without re-granting
     * anything.
     */
    pendingPresentations: Map<string, ResolvedRewardPresentation>;
    /** Aggregate facts from completed floors only; the active floor stays live. */
    carriedRunFacts: AchievementFactSnapshot;
  };
  /**
   * True when the player entity's current position is inside a safe room.
   * Updated each tick by `safeRoomSystem`. Systems and UI use this to pause
   * timers and enable customization panels.
   */
  playerInSafeRoom: boolean;
  /** Debug flags — lab/dev use only. Never read in production game logic. */
  debugFlags: {
    /** When true, renders enemies in closed rooms at reduced alpha (doesn't affect game FOV). */
    showAllRooms: boolean;
  };
  /**
   * Floor 2 equipment feature flags. All flags default to `false` and apply
   * only to Floor 2. Floor 1 is unaffected regardless of flag values.
   *
   * Dependency closure (enabling a flag without its deps is a config error):
   *   floor2EquipmentRegistry      — none
   *   floor2EquipmentCatalog       — registry
   *   floor2EquipmentRewards       — registry, catalog
   *   floor2EquipmentEconomy       — registry, catalog
   *   floor2EquipmentUx            — registry, catalog
   *   floor2EquipmentWorld         — registry, catalog
   *   floor2EquipmentAiMaintenance — registry, catalog, economy, UX, world
   *
   * Disabling a flag stops new generation/mutation through that consumer but
   * does NOT delete, rewrite, or reroll persisted v1 records.
   *
   * See ADR 0065 DEC-009 and .specify/specs/equipment-system.md §Feature flags.
   */
  floor2EquipmentFlags: {
    /** Enables the generated-instance registry. Gate for all other Floor 2 equipment features. */
    floor2EquipmentRegistry: boolean;
    /** Enables the equipment catalog (70 normalized bases). Requires registry. */
    floor2EquipmentCatalog: boolean;
    /** Enables achievement equipment reward generation. Requires registry + catalog. */
    floor2EquipmentRewards: boolean;
    /** Enables Quartermaster stock + boss chest generation. Requires registry + catalog. */
    floor2EquipmentEconomy: boolean;
    /** Enables equipment inventory/equip UX. Requires registry + catalog. */
    floor2EquipmentUx: boolean;
    /** Enables world placement (chests, drops). Requires registry + catalog. */
    floor2EquipmentWorld: boolean;
    /** Enables AI settlement-maintenance behavior. Requires all other flags. */
    floor2EquipmentAiMaintenance: boolean;
  };
}

export interface CreateWorldOptions {
  seed?: number;
  floor?: number;
  maxEntities?: number;
  entityCapacityMode?: 'game' | 'lab' | 'test';
  /** Explicit immutable run identity required before generated equipment can be created. */
  generatedEquipmentRunKey?: string;
  /** Frozen-content generation policy; omitted to use the v1 contract policy. */
  generatedEquipmentGenerationPolicy?: GeneratedEquipmentGenerationPolicyV1;
}

const DEFAULT_ENTITY_CAPACITY_BY_MODE = {
  game: 10_000,
  lab: 5_000,
  test: 3_000,
} as const;

function getDefaultEntityCapacityMode(): keyof typeof DEFAULT_ENTITY_CAPACITY_BY_MODE {
  if (typeof process !== 'undefined' && process.env.VITEST === 'true') {
    return 'test';
  }
  if (typeof window !== 'undefined' && window.location.pathname.endsWith('lab.html')) {
    return 'lab';
  }
  return 'game';
}

/** Helper to wire an onSet observer that copies fields into a typed-array store. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wireStore(ecs: ReturnType<typeof createBitecsWorld>, component: object, store: any): void {
  observe(ecs, onSet(component), (eid: number, params: Record<string, unknown>) => {
    for (const key of Object.keys(store)) {
      const val = params[key];
      if (typeof val === 'number') {
        store[key][eid] = val;
      }
    }
  });
}

export function createGameWorld(options: CreateWorldOptions = {}): GameWorld {
  const ecs = createBitecsWorld();
  const mode = options.entityCapacityMode ?? getDefaultEntityCapacityMode();
  const maxEntities = options.maxEntities ?? DEFAULT_ENTITY_CAPACITY_BY_MODE[mode];
  const stores = createComponentStores(maxEntities);

  // Wire onSet observers so set(Component, data) populates typed arrays
  wireStore(ecs, Position, stores.position);
  wireStore(ecs, Velocity, stores.velocity);
  wireStore(ecs, Rotation, stores.rotation);
  wireStore(ecs, Health, stores.health);
  wireStore(ecs, Damage, stores.damage);
  wireStore(ecs, Projectile, stores.projectile);
  wireStore(ecs, XpGem, stores.xpGem);
  wireStore(ecs, Sprite, stores.sprite);
  wireStore(ecs, EnemyBehavior, stores.enemyBehavior);
  wireStore(ecs, Spawner, stores.spawner);
  wireStore(ecs, BroadcastScore, stores.broadcastScore);
  wireStore(ecs, DroppedItem, stores.droppedItem);
  wireStore(ecs, Owner, stores.owner);
  wireStore(ecs, Team, stores.team);
  wireStore(ecs, Lifetime, stores.lifetime);
  wireStore(ecs, AreaDamage, stores.areaDamage);
  wireStore(ecs, AoeOnImpact, stores.aoeOnImpact);
  wireStore(ecs, Returning, stores.returning);
  wireStore(ecs, Bouncing, stores.bouncing);
  wireStore(ecs, LineDamage, stores.lineDamage);
  wireStore(ecs, Trap, stores.trap);
  wireStore(ecs, MeleeSwing, stores.meleeSwing);
  wireStore(ecs, Knockback, stores.knockback);
  wireStore(ecs, DoorState, stores.doorState);
  wireStore(ecs, DeathTimer, stores.deathTimer);
  wireStore(ecs, SpawnAnim, stores.spawnAnim);
  wireStore(ecs, BaseStats, stores.baseStats);
  wireStore(ecs, EffectiveStats, stores.effectiveStats);
  wireStore(ecs, DamageMeta, stores.damageMeta);
  wireStore(ecs, Gold, stores.gold);
  wireStore(ecs, Npc, stores.npc);
  wireStore(ecs, Weight, stores.weight);
  wireStore(ecs, Size, stores.size);
  wireStore(ecs, BloodColor, stores.bloodColor);
  wireStore(ecs, Prop, stores.prop);
  wireStore(ecs, PropLight, stores.propLight);
  wireStore(ecs, Harvestable, stores.harvestable);
  wireStore(ecs, FamilyMembership, stores.familyMembership);

  const world: GameWorld = {
    ecs,
    stores,
    entityRenderGeneration: new Uint32Array(maxEntities),
    nextEntityRenderGeneration: 0,
    rng: new SeededRandom(options.seed ?? 42),
    seed: options.seed ?? 42,
    frameCount: 0,
    elapsedMs: 0,
    hostileEncounterRevision: 0,
    floor: options.floor ?? 1,
    state: 'playing',
    playerName: 'Rhea Vale',
    playerGender: 'female',
    playerLevel: {
      xp: 0,
      level: 0,
      unspentPoints: 0,
      pointsPerLevel: 3,
    },
    statModifiers: [],
    playerSkills: new Map(),
    skillStatesByEntity: new Map(),
    skillUsageEvents: [],
    milestoneGrantLog: [],
    attackerWeaponSkills: new Map(),
    attackWeaponSkillsByEntity: new Map(),
    abilityStatesByEntity: new Map(),
    abilityTriggerEvents: [],
    inventories: new Map(),
    generatedEquipmentRegistry: createGeneratedEquipmentRegistry({
      runKey: options.generatedEquipmentRunKey,
      generationPolicy: options.generatedEquipmentGenerationPolicy,
    }),
    generatedEquipmentRewardBundles: new Map(),
    bossChests: new Map(),
    bossChestEids: new Map(),
    lootBoxRewardBundles: new Map(),
    statusEffectsByEntity: new Map(),
    doorLockConfigs: new Map(),
    goalFlags: new Map(),
    combatEvents: [],
    lethalDamageSourceByTarget: new Map(),
    maxKnockbackStepThisFrame: 0,
    vfxEvents: [],
    floaterEvents: [],
    announcements: [],
    abilityActivations: [],
    mobAbilities: createMobAbilityRuntime(),
    bloodPools: [],
    bloodyFootprints: [],
    bloodyFootprintState: createBloodyFootprintState(),
    spawnerArenaDoors: new Map(),
    spawnerArenaBarriers: new Map(),
    barriers: createBarrierRegistry(),
    spawnerArenaEverArmed: new Set(),
    playerGold: 0,
    lootLedger: createLootLedger(),
    goldLedger: createGoldLedger(),
    vendorLedger: createVendorLedger(),
    peakGold: 0,
    floorMap: null,
    floorId: '',
    floorScenario: null,
    hideFloorTimer: false,
    floorExtendedState: null,
    factionRelations: new Map(),
    factionRelationEvents: [],
    factionRelationDeltas: [],
    factionRelationDecayLastMs: null,
    floorObjectiveTick: null,
    npcs: new Map(),
    setPieceProps: [],
    enemyAppearanceKeys: new Map(),
    enemyProjectileArchetypeKeys: new Map(),
    generatedSpriteRegistry: null,
    entityWeaponAnchors: new Map(),
    questLog: new Map(),
    questEvents: [],
    featureUnlocks: {
      inventory: false,
      equipment: false,
      spells: false,
    },
    achievements: {
      unlockedIds: new Set(),
      pendingUnlockIds: [],
      claimedIds: new Set(),
      pendingPresentations: new Map(),
      carriedRunFacts: createEmptyAchievementFactSnapshot(),
    },
    debugFlags: {
      showAllRooms: false,
    },
    playerInSafeRoom: false,
    floor2EquipmentFlags: {
      floor2EquipmentRegistry: false,
      floor2EquipmentCatalog: false,
      floor2EquipmentRewards: false,
      floor2EquipmentEconomy: false,
      floor2EquipmentUx: false,
      floor2EquipmentWorld: false,
      floor2EquipmentAiMaintenance: false,
    },
  };
  logger.info('Created game world', {
    seed: options.seed ?? 42,
    floor: world.floor,
    state: world.state,
    entityCapacityMode: mode,
    maxEntities,
  });
  return world;
}

// Re-export set for convenience in systems
export { set } from 'bitecs';
