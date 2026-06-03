/**
 * ECS World factory.
 * Creates and configures a bitecs world with game-specific metadata.
 */
import { createWorld as createBitecsWorld } from 'bitecs';
import { SeededRandom } from '../shared/random.js';

export interface GameWorld {
  /** The bitecs ECS world instance */
  ecs: ReturnType<typeof createBitecsWorld>;
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

export function createGameWorld(options: CreateWorldOptions = {}): GameWorld {
  return {
    ecs: createBitecsWorld(),
    rng: new SeededRandom(options.seed ?? 42),
    frameCount: 0,
    elapsedMs: 0,
    floor: options.floor ?? 1,
    state: 'playing',
  };
}
