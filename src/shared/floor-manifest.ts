/**
 * Floor Manifest Schema — unified floor configuration system.
 *
 * A floor manifest aggregates all configuration needed to initialize a floor:
 * - Map generation parameters
 * - Enemy pack reference
 * - Objective requirements
 * - Timer settings
 * - Player stat bonuses
 * - Protagonist info
 * - Starter weapon pool
 *
 * This replaces individual config files (floor1.json, enemies.floor1.json)
 * with a single source of truth per floor.
 */
import { z } from 'zod';
import floor1ManifestJson from './data/floors/floor1.manifest.json';

/**
 * Floor manifest configuration schema.
 */
export const floorManifestDefSchema = z
  .object({
    /** Unique identifier for this floor (e.g., "floor1", "floor2"). */
    id: z.string().min(1),
    /** Display name for this floor. */
    name: z.string().min(1),
    /** Protagonist character ID. */
    protagonist: z.string().min(1),
    /** Available starter weapons for loadout selection. */
    starterWeapons: z.array(z.string().min(1)).min(1),
    /** Floor timer configuration. */
    timer: z
      .object({
        /** Total floor duration in milliseconds. */
        durationMs: z.number().int().positive(),
        /** Countdown timer before staircase spawns (ms). */
        stairSpawnCountdownMs: z.number().int().nonnegative(),
      })
      .strict(),
    /** Objective requirements to unlock staircase. */
    objectives: z
      .object({
        /** Required rat kills (archetype-specific). */
        requiredRats: z.number().int().nonnegative(),
        /** Required slime kills (archetype-specific). */
        requiredSlimes: z.number().int().nonnegative(),
        /** Required total enemy kills. */
        requiredTotalKills: z.number().int().nonnegative(),
        /** Required gold collected. */
        requiredGold: z.number().int().nonnegative(),
        /** Required junk items collected. */
        requiredJunk: z.number().int().nonnegative(),
        /** Marker radius in pixels for objective indicators. */
        markerRadiusPx: z.number().nonnegative(),
      })
      .strict(),
    /** Map generation configuration. */
    map: z
      .object({
        /** Map width in tiles. */
        widthTiles: z.number().int().positive(),
        /** Map height in tiles. */
        heightTiles: z.number().int().positive(),
        /** Tile size in pixels. */
        tileSizePx: z.number().int().positive(),
        /** Map generation seed. */
        seed: z.number().int().positive(),
        /** Room width range [min, max] in tiles. */
        roomWidthRange: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        /** Room height range [min, max] in tiles. */
        roomHeightRange: z.tuple([z.number().int().positive(), z.number().int().positive()]),
        /** Maximum number of rooms to generate. */
        maxRooms: z.number().int().positive(),
        /** Floor tile coverage density (0-1). */
        floorDensity: z.number().min(0).max(1),
      })
      .strict(),
    /** Reference to enemy pack ID (e.g., "floor1-ambient"). */
    enemyPackId: z.string().min(1),
    /** Player stat bonuses for this floor. */
    player: z
      .object({
        /** Additional max HP. */
        hpBonus: z.number().nonnegative(),
        /** Additional move speed. */
        moveSpeedBonus: z.number().nonnegative(),
        /** Additional pickup range. */
        pickupRangeBonus: z.number().nonnegative(),
      })
      .strict(),
    /** Camera configuration. */
    camera: z
      .object({
        /** Camera zoom level. */
        zoom: z.number().positive(),
      })
      .strict(),
    /** Optional sprite texture IDs. */
    sprites: z
      .object({
        /** Welcome sign sprite texture ID. */
        welcomeSign: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    /** Boss variant configurations (if applicable). */
    bossVariants: z
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
      .strict()
      .optional(),
  })
  .strict();

export type FloorManifestDef = z.infer<typeof floorManifestDefSchema>;

/**
 * Load and validate the Floor 1 manifest.
 */
function loadFloor1Manifest(): FloorManifestDef {
  const parsed = floorManifestDefSchema.parse(floor1ManifestJson);
  return parsed;
}

/**
 * Validated Floor 1 manifest, loaded at module initialization.
 */
export const floor1Manifest: FloorManifestDef = loadFloor1Manifest();
