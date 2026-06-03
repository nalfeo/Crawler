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
  BroadcastScore,
  createComponentStores,
  type ComponentStores,
} from './components.js';

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
  state: 'loading' | 'playing' | 'paused' | 'safe_room' | 'game_over';
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
  wireStore(ecs, BroadcastScore, stores.broadcastScore);

  return {
    ecs,
    stores,
    rng: new SeededRandom(options.seed ?? 42),
    frameCount: 0,
    elapsedMs: 0,
    floor: options.floor ?? 1,
    state: 'playing',
  };
}

// Re-export set for convenience in systems
export { set } from 'bitecs';
