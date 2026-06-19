/**
 * Enemy Pack Abstraction — config-driven enemy spawning system.
 *
 * This module provides a data-driven approach to enemy spawning,
 * replacing hardcoded archetype logic in floor1EnemyDirectorSystem.
 */
import { z } from 'zod';
import floor1EnemyPackJson from './data/enemies.floor1.json';

/**
 * Single enemy archetype configuration for spawning.
 */
export const enemyArchetypeDefSchema = z
  .object({
    /** Unique identifier for this enemy type. */
    id: z.string().min(1),
    /** Display name for this enemy. */
    name: z.string().min(1),
    /** Base hit points. */
    hp: z.number().int().positive(),
    /** Movement speed in ECS world units (pixels per frame). */
    speed: z.number().positive(),
    /** Detection range in pixels. */
    detectRange: z.number().nonnegative(),
    /** Sprite texture ID from the sprite catalog. */
    spriteTexture: z.number().int().positive(),
    /** Sprite width in pixels. */
    spriteWidth: z.number().int().positive().default(16),
    /** Sprite height in pixels. */
    spriteHeight: z.number().int().positive().default(16),
    /** AI behavior type. */
    aiType: z.enum(['chase', 'patrol', 'ranged', 'flee']).default('chase'),
    /** Spawn weight for weighted random selection (0-1). */
    spawnWeight: z.number().min(0).max(1),
  })
  .strict();

export type EnemyArchetypeDef = z.infer<typeof enemyArchetypeDefSchema>;

/**
 * Enemy pack configuration defining a set of enemies for a floor.
 */
export const enemyPackDefSchema = z
  .object({
    /** Unique identifier for this enemy pack. */
    id: z.string().min(1),
    /** Display name for this pack. */
    name: z.string().min(1),
    /** Enemy archetypes available in this pack. */
    archetypes: z.array(enemyArchetypeDefSchema).min(1),
    /** Maximum number of concurrent ambient enemies. */
    enemyCap: z.number().int().positive(),
    /** Minimum milliseconds between spawn attempts. */
    spawnIntervalMs: z.number().int().nonnegative(),
    /** Minimum spawn radius from player in pixels. */
    spawnRadiusMin: z.number().nonnegative(),
    /** Maximum spawn distance from player before despawning (in pixels). */
    despawnDistancePx: z.number().nonnegative(),
  })
  .strict();

export type EnemyPackDef = z.infer<typeof enemyPackDefSchema>;

/**
 * Load and validate the Floor 1 enemy pack.
 */
function loadFloor1EnemyPack(): EnemyPackDef {
  const parsed = enemyPackDefSchema.parse(floor1EnemyPackJson);
  return parsed;
}

/**
 * Validated Floor 1 enemy pack, loaded at module initialization.
 */
export const floor1EnemyPack: EnemyPackDef = loadFloor1EnemyPack();

/**
 * Selects a random enemy archetype from the pack using weighted selection.
 */
export function pickEnemyArchetype(
  archetypes: readonly EnemyArchetypeDef[],
  random: () => number,
): EnemyArchetypeDef {
  const roll = random();
  let cumulative = 0;
  for (const archetype of archetypes) {
    cumulative += archetype.spawnWeight;
    if (roll < cumulative) {
      return archetype;
    }
  }
  // Fallback to last archetype if weights don't sum to 1
  return archetypes[archetypes.length - 1]!;
}
