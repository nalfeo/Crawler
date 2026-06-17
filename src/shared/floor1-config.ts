/**
 * Floor 1 configuration schema and loader.
 *
 * This module validates and loads floor1.json at module initialization,
 * replacing the hardcoded FLOOR_1_* constants in floor1Scenario.ts.
 */
import { z } from 'zod';
import floor1ConfigJson from './data/floor1.json';

const enemyArchetypeConfigSchema = z
  .object({
    hp: z.number().int().positive(),
    speed: z.number().positive(),
    detectRange: z.number().nonnegative(),
    spriteTexture: z.number().int().positive(),
    spawnWeight: z.number().min(0).max(1).optional(),
  })
  .strict();

const bossArchetypeConfigSchema = z
  .object({
    hp: z.number().int().positive(),
    speed: z.number().positive(),
    detectRange: z.number().nonnegative(),
    spawnRadiusMin: z.number().nonnegative(),
    spawnRadiusMax: z.number().nonnegative(),
    spriteWidth: z.number().int().positive(),
    spriteHeight: z.number().int().positive(),
    fireballCooldownMs: z.number().int().nonnegative(),
  })
  .strict();

const bossVariantConfigSchema = z
  .object({
    slimeRat: z
      .object({
        hp: z.number().int().positive(),
        speed: z.number().positive(),
        detectRange: z.number().nonnegative(),
        fireballCooldownMs: z.number().int().nonnegative(),
      })
      .strict(),
    ratSlime: z
      .object({
        hp: z.number().int().positive(),
        speed: z.number().positive(),
        detectRange: z.number().nonnegative(),
        fireballCooldownMs: z.number().int().nonnegative(),
        spawnRadiusMin: z.number().nonnegative(),
        spawnRadiusMax: z.number().nonnegative(),
        spriteWidth: z.number().int().positive(),
        spriteHeight: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export const floor1ConfigSchema = z
  .object({
    protagonist: z.string().min(1),
    starterWeapons: z.array(z.string().min(1)).min(1),
    timer: z
      .object({
        durationMs: z.number().int().positive(),
        stairSpawnCountdownMs: z.number().int().nonnegative(),
      })
      .strict(),
    objectives: z
      .object({
        requiredRats: z.number().int().nonnegative(),
        requiredSlimes: z.number().int().nonnegative(),
        requiredTotalKills: z.number().int().nonnegative(),
        requiredGold: z.number().int().nonnegative(),
        requiredJunk: z.number().int().nonnegative(),
        markerRadiusPx: z.number().nonnegative(),
      })
      .strict(),
    map: z
      .object({
        widthTiles: z.number().int().positive(),
        heightTiles: z.number().int().positive(),
        tileSizePx: z.number().int().positive(),
        seed: z.number().int().positive(),
        roomWidthRange: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        roomHeightRange: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        maxRooms: z.number().int().positive(),
        floorDensity: z.number().min(0).max(1),
      })
      .strict(),
    enemies: z
      .object({
        rat: enemyArchetypeConfigSchema,
        slime: enemyArchetypeConfigSchema,
        boss: bossArchetypeConfigSchema,
      })
      .strict(),
    bossVariants: bossVariantConfigSchema.optional(),
    spawning: z
      .object({
        enemyCap: z.number().int().positive(),
        spawnIntervalMs: z.number().int().positive(),
        spawnRadiusMin: z.number().nonnegative(),
        ambientSpawnMaxDistancePx: z.number().nonnegative(),
        ambientDespawnDistancePx: z.number().nonnegative(),
      })
      .strict(),
    player: z
      .object({
        hpBonus: z.number().nonnegative(),
        moveSpeedBonus: z.number().nonnegative(),
        pickupRangeBonus: z.number().nonnegative(),
      })
      .strict(),
    camera: z
      .object({
        zoom: z.number().positive(),
      })
      .strict(),
    sprites: z
      .object({
        welcomeSign: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Floor1Config = z.infer<typeof floor1ConfigSchema>;

/**
 * Load and validate floor1.json. Throws if validation fails.
 */
function loadFloor1Config(): Floor1Config {
  const parsed = floor1ConfigSchema.parse(floor1ConfigJson);
  return parsed;
}

/**
 * Validated Floor 1 configuration, loaded at module initialization.
 * This replaces all FLOOR_1_* constants previously hardcoded in floor1Scenario.ts.
 */
export const floor1Config: Floor1Config = loadFloor1Config();
