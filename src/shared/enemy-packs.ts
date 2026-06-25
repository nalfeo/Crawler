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
    /**
     * Radius (px) around the player within which an enemy counts as actively
     * "engaging/pursuing". Drives the engagement-budget top-up and the inner
     * recycling ring (enemies outside this ring are eligible for eviction when
     * the global cap is reached and the player needs closer threats).
     */
    engageRadiusPx: z.number().positive(),
    /**
     * Desired number of engaging enemies within {@link engageRadiusPx}. The
     * director burst-spawns near the player to keep the engaging count topped up
     * to this target, giving constant combat with no dead zones when the player
     * outruns the field. Separate from {@link enemyCap} (the global ceiling).
     */
    engageTarget: z.number().int().positive(),
    /** Maximum ambient enemies the director may burst-spawn in a single tick. */
    maxSpawnsPerTick: z.number().int().positive(),
    /**
     * Probability (0-1) that the first time the player enters a NORMAL combat
     * room it is pre-populated with a monster wave already inside.
     */
    roomWaveChance: z.number().min(0).max(1),
    /** Minimum wave size when a room is pre-populated. */
    roomWaveMin: z.number().int().nonnegative(),
    /** Maximum wave size when a room is pre-populated. */
    roomWaveMax: z.number().int().nonnegative(),
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
