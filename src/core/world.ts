/**
 * ECS World factory.
 * Creates and configures a bitecs world with component stores and observers.
 *
 * bitecs 0.4 uses observer-based data: set() fires onSet observers that
 * populate typed-array stores. Systems read stores directly for performance.
 */
import { createWorld as createBitecsWorld, observe, onSet } from 'bitecs';
import { SeededRandom } from '../shared/random.js';
import {
  Position,
  Velocity,
  Rotation,
  Health,
  Damage,
  XpGem,
  Sprite,
  EnemyBehavior,
  BroadcastScore,
  createComponentStores,
  type ComponentStores,
} from './components.js';
import type { StatModifier, SkillState, SkillUsageEvent, PlayerLevel } from '../shared/skills.js';

export interface GameWorld {
  /** The bitecs ECS world instance */
  ecs: ReturnType<typeof createBitecsWorld>;
  /** Typed-array component stores — read directly: stores.position.x[eid] */
  stores: ComponentStores;
  /** Seeded RNG — never use Math.random() */
  rng: SeededRandom;
  /** Current frame count */
  frameCount: number;
  /** Time elapsed in current floor (ms) */
  elapsedMs: number;
  /** Current floor number (1-indexed) */
  floor: number;
  /** Game state */
  state: 'loading' | 'playing' | 'paused' | 'safe_room' | 'game_over' | 'level_up';

  // --- Stats/Skills/Levels (player-singleton, stored at world level) ---

  /** Player level state — JS numbers to avoid Uint16 cap and float precision issues. */
  playerLevel: PlayerLevel;
  /** Active stat modifiers from skills, floors, and buffs. Filtered by statsSystem. */
  statModifiers: StatModifier[];
  /** Per-skill state keyed by skill id. */
  playerSkills: Map<string, SkillState>;
  /** Usage events emitted this frame — cleared at start of skillSystem. */
  skillUsageEvents: SkillUsageEvent[];
  /** Dirty flag: true when stats need recomputing. Set by level-up, modifier change, etc. */
  statsDirty: boolean;
}

export interface CreateWorldOptions {
  seed?: number;
  floor?: number;
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
  const stores = createComponentStores();

  // Wire onSet observers so set(Component, data) populates typed arrays
  wireStore(ecs, Position, stores.position);
  wireStore(ecs, Velocity, stores.velocity);
  wireStore(ecs, Rotation, stores.rotation);
  wireStore(ecs, Health, stores.health);
  wireStore(ecs, Damage, stores.damage);
  wireStore(ecs, XpGem, stores.xpGem);
  wireStore(ecs, Sprite, stores.sprite);
  wireStore(ecs, EnemyBehavior, stores.enemyBehavior);
  wireStore(ecs, BroadcastScore, stores.broadcastScore);

  return {
    ecs,
    stores,
    rng: new SeededRandom(options.seed ?? 42),
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
    skillUsageEvents: [],
    statsDirty: true,
  };
}

// Re-export set for convenience in systems
export { set } from 'bitecs';
