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
import type { CombatEvent } from '../shared/combat-events.js';
import type { VfxEvent } from '../shared/vfx-events.js';
import type { AbilityState, AbilityTriggerEvent } from '../shared/abilities.js';
import { createLogger } from '../shared/logger.js';
import type { DoorLockConfig } from './door-lock.js';
import type { FloorMap } from './map/FloorMap.js';
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
  Weapon,
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
  Gold,
  Npc,
  Weight,
  BloodColor,
  Prop,
  PropLight,
  Harvestable,
  createComponentStores,
  type ComponentStores,
} from './components.js';
import type { StatModifier, SkillState, SkillUsageEvent, PlayerLevel } from '../shared/skills.js';
import type { Floor1ScenarioState } from '../shared/floor-types.js';
import type { NpcInstance } from '../shared/npc-types.js';
import type { QuestState } from '../shared/quest-types.js';
import type { QuestEvent } from '../shared/quest-events.js';

const logger = createLogger('core:world');

export interface GameWorld {
  /** The bitecs ECS world instance */
  ecs: ReturnType<typeof createBitecsWorld>;
  /** Typed-array component stores — read directly: stores.position.x[eid] */
  stores: ComponentStores;
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
  /** Current floor number (1-indexed) */
  floor: number;
  /** Game state */
  state: 'loading' | 'loadout' | 'playing' | 'paused' | 'safe_room' | 'game_over' | 'level_up';

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
   * Active weapon skill IDs keyed by attacker EID (player).
   * Set by weaponSystem after a successful accuracy check; read by damage
   * systems (melee/projectile/beam/area) to emit skill XP when damage lands.
   */
  attackerWeaponSkills: Map<number, { classSkillId: string; typeSkillId: string }>;
  /** Per-entity ability state keyed by holder eid. */
  abilityStatesByEntity: Map<number, AbilityState>;
  /** Trigger events emitted this frame — cleared at end of abilitySystem. */
  abilityTriggerEvents: AbilityTriggerEvent[];
  /** Dirty flag: true when stats need recomputing. Set by level-up, modifier change, etc. */
  statsDirty: boolean;
  /** Per-entity inventory bags (eid → bag). Side-car for variable-length data. */
  inventories: Map<number, InventoryBag>;
  /** Per-door lock configurations (eid → lock config). */
  doorLockConfigs: Map<number, DoorLockConfig>;
  /** Scenario/world objective flags used by lock conditions and other systems. */
  goalFlags: Map<string, boolean>;
  /** Combat events emitted this frame — consumed and drained by the render layer. */
  combatEvents: CombatEvent[];
  /**
   * Generic cosmetic VFX effect-requests emitted this frame — drained by the
   * engine-layer EffectsVfx renderer. Cosmetic-only; never read by game logic.
   */
  vfxEvents: VfxEvent[];
  /** Player's gold (currency) — separate from BroadcastScore (reality show rating). */
  playerGold: number;
  /** Procedurally generated floor map — null until floor is loaded. */
  floorMap: FloorMap | null;
  /** Floor 1 tutorial scenario state. */
  floor1: Floor1ScenarioState | null;
  /**
   * Generic per-floor objective tick registered by each floor's scenario at
   * initialisation. `floorObjectiveSystem` calls this every frame so no
   * floor needs its own named system slot in `postSystems`.
   */
  floorObjectiveTick: ((world: GameWorld) => void) | null;
  /** Per-entity NPC instance state (eid → NpcInstance). Side-car for variable-length NPC data. */
  npcs: Map<number, NpcInstance>;
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
  };
  /** Player's current MP (mana points). */
  playerMp: number;
  /** Player's maximum MP (mana points). */
  playerMaxMp: number;
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
}

export interface CreateWorldOptions {
  seed?: number;
  floor?: number;
  maxEntities?: number;
  entityCapacityMode?: 'game' | 'lab' | 'test';
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
  wireStore(ecs, Weapon, stores.weapon);
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
  wireStore(ecs, Gold, stores.gold);
  wireStore(ecs, Npc, stores.npc);
  wireStore(ecs, Weight, stores.weight);
  wireStore(ecs, BloodColor, stores.bloodColor);
  wireStore(ecs, Prop, stores.prop);
  wireStore(ecs, PropLight, stores.propLight);
  wireStore(ecs, Harvestable, stores.harvestable);

  const world: GameWorld = {
    ecs,
    stores,
    rng: new SeededRandom(options.seed ?? 42),
    seed: options.seed ?? 42,
    frameCount: 0,
    elapsedMs: 0,
    floor: options.floor ?? 1,
    state: 'playing',
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
    attackerWeaponSkills: new Map(),
    abilityStatesByEntity: new Map(),
    abilityTriggerEvents: [],
    statsDirty: true,
    inventories: new Map(),
    doorLockConfigs: new Map(),
    goalFlags: new Map(),
    combatEvents: [],
    vfxEvents: [],
    playerGold: 0,
    floorMap: null,
    floor1: null,
    floorObjectiveTick: null,
    npcs: new Map(),
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
    },
    playerMp: 100,
    playerMaxMp: 100,
    debugFlags: {
      showAllRooms: false,
    },
    playerInSafeRoom: false,
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
