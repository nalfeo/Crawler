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
 * - NPC placements
 *
 * This replaces individual config files (floor1.json, enemies.floor1.json)
 * with a single source of truth per floor.
 */
import { z } from 'zod';
import floor1ManifestJson from './data/floors/floor1.manifest.json';
import floor2ManifestJson from './data/floors/floor2.manifest.json';
import { npcPlacementDefSchema } from './npc-placements.js';
import { BiomeType } from './map-types.js';
import { runtimeTerrainPackIdSchema } from './terrain-pack-types.js';

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
        /** Marker radius in feet for objective indicators. */
        markerRadiusFt: z.number().nonnegative(),
      })
      .strict(),
    /** Map generation configuration. */
    map: z
      .object({
        /** Map width in tiles. */
        widthTiles: z.number().int().positive(),
        /** Map height in tiles. */
        heightTiles: z.number().int().positive(),
        /** Tile size in feet. */
        tileSizeFt: z.number().positive(),
        /** Map generation seed. */
        seed: z.number().int().positive(),
        /** Biome/generator id for this floor. */
        biome: z.nativeEnum(BiomeType).optional(),
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
    /**
     * Optional loot table ID to apply as a floor-bonus drop on every enemy kill.
     * Matched against the `id` field of each `LootTable` entry in `LOOT_TABLES` (e.g. `"floor_1"`).
     * When omitted no floor-level loot bonus is applied.
     */
    floorLootTableId: z.string().min(1).optional(),
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
            spriteWidth: z.number().positive(),
            spriteHeight: z.number().positive(),
          })
          .strict(),
      })
      .strict()
      .optional(),
    /** NPC placements for this floor. */
    npcPlacements: z.array(npcPlacementDefSchema).optional(),
    /** Optional prop/decoration configuration for this floor. */
    props: z
      .object({
        /** Biome tag used to filter decoration defs. */
        biomeTag: z.enum(['dungeon', 'organic', 'tech', 'void', 'cave']),
        /** Multiplier applied to each def's base density (default 1.0). */
        densityMultiplier: z.number().positive().optional(),
        /** Category whitelist — only defs in these categories are placed. */
        allowedCategories: z
          .array(z.enum(['rubbish', 'light-source', 'structural', 'organic', 'tech']))
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * Per-floor lighting defaults. Only `ambient` (the base light level applied
     * to visible tiles outside any light source) is authored per floor; all
     * other lighting parameters come from the engine's DEFAULT_LIGHTING_CONFIG.
     * Floor 1 ships 0.2; deeper/darker floors can ship lower values.
     */
    lighting: z
      .object({
        /** Base ambient light level in [0,1] applied to visible tiles. */
        ambient: z.number().min(0).max(1),
      })
      .strict(),
    /** Floor-2-specific scenario config (ignored by Floor 1). */
    floor2: z
      .object({
        presentCount: z.number().int().min(3).max(4).optional(),
        familyPool: z.array(z.string().min(1)).min(4).optional(),
        resourcePool: z.array(z.string().min(1)).min(1).optional(),
        settlement: z
          .object({
            shopCountRange: z.tuple([
              z.number().int().min(1).max(2),
              z.number().int().min(1).max(2),
            ]),
            shopArchetypes: z.array(z.string().min(1)).min(1).optional(),
          })
          .strict()
          .optional(),
        governor: z
          .object({
            autoUnlockDens: z.boolean().optional(),
            autoVictoryOnStart: z.boolean().optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    /**
     * Optional terrain pack id (registry-backed, see `terrain-pack-types.ts`)
     * this floor's renderer should use for walls/floor-pool/corridor-pool/
     * doors. Omitted entirely by floors that use the legacy 16-mask
     * `TILE_SPRITES` autotile + generated-single-image path —
     * a typo'd id fails this Zod enum, never silently falls back at runtime.
     */
    terrainPackId: runtimeTerrainPackIdSchema.optional(),
    /**
     * Optional pack assignment for floors that mix carved stone and cave
     * terrain. An omitted family falls back to `terrainPackId`.
     */
    terrainPacks: z
      .object({
        stone: runtimeTerrainPackIdSchema.optional(),
        cave: runtimeTerrainPackIdSchema.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type FloorManifestDef = z.infer<typeof floorManifestDefSchema>;

/**
 * Load and validate a floor manifest by ID.
 * @param floorId - The floor identifier (e.g., "floor1")
 * @returns The loaded manifest
 */
function loadFloorManifest(floorId: string): FloorManifestDef {
  let manifestJson: unknown;

  if (floorId === 'floor1') {
    manifestJson = floor1ManifestJson;
  } else if (floorId === 'floor2') {
    manifestJson = floor2ManifestJson;
  } else {
    throw new Error(`Floor manifest not found: ${floorId}`);
  }

  const parsed = floorManifestDefSchema.parse(manifestJson);
  return parsed;
}

function deepFreeze<T extends object>(obj: T): T {
  for (const val of Object.values(obj)) {
    if (val !== null && typeof val === 'object') {
      deepFreeze(val as object);
    }
  }
  return Object.freeze(obj);
}

/**
 * Validated Floor 1 manifest, loaded at module initialization.
 * Deep-frozen to prevent accidental mutation; use floor-registry.ts for mutable
 * working copies.
 * @deprecated Use floor-registry.ts instead
 */
export const floor1Manifest: FloorManifestDef = deepFreeze(loadFloorManifest('floor1'));
export const floor2Manifest: FloorManifestDef = deepFreeze(loadFloorManifest('floor2'));
