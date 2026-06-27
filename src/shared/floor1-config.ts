/**
 * Floor 1 configuration schema and loader.
 *
 * DEPRECATED: This module is being replaced by floor-manifest.ts.
 * For now, it provides backward compatibility by deriving config from the manifest.
 *
 * Phase 3 Migration: floor1Config now loads from floor1.manifest.json
 * while maintaining the same interface for backward compatibility.
 */
import { z } from 'zod';
import { floor1Manifest } from './floor-manifest.js';
import { floor1EnemyPack } from './enemy-packs.js';

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
    spriteWidth: z.number().positive(),
    spriteHeight: z.number().positive(),
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
        spriteWidth: z.number().positive(),
        spriteHeight: z.number().positive(),
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
        markerRadiusFt: z.number().nonnegative(),
      })
      .strict(),
    map: z
      .object({
        widthTiles: z.number().int().positive(),
        heightTiles: z.number().int().positive(),
        tileSizeFt: z.number().positive(),
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
        ambientSpawnMaxDistanceFt: z.number().nonnegative(),
        ambientDespawnDistanceFt: z.number().nonnegative(),
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
        welcomeSign: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type Floor1Config = z.infer<typeof floor1ConfigSchema>;

/**
 * Derive Floor1Config from the manifest and enemy pack for backward compatibility.
 */
function loadFloor1ConfigFromManifest(): Floor1Config {
  const manifest = floor1Manifest;
  const enemyPack = floor1EnemyPack;

  // Derive enemy config from enemy pack archetypes
  const ratArchetype = enemyPack.archetypes.find((a) => a.id === 'rat')!;
  const slimeArchetype = enemyPack.archetypes.find((a) => a.id === 'slime')!;

  return {
    protagonist: manifest.protagonist,
    starterWeapons: manifest.starterWeapons,
    timer: manifest.timer,
    objectives: manifest.objectives,
    map: manifest.map,
    enemies: {
      rat: {
        hp: ratArchetype.hp,
        speed: ratArchetype.speed,
        detectRange: ratArchetype.detectRange,
        spriteTexture: ratArchetype.spriteTexture,
        spawnWeight: ratArchetype.spawnWeight,
      },
      slime: {
        hp: slimeArchetype.hp,
        speed: slimeArchetype.speed,
        detectRange: slimeArchetype.detectRange,
        spriteTexture: slimeArchetype.spriteTexture,
      },
      boss: {
        hp: 280, // Hardcoded for now, will be in enemy pack in future
        speed: 0.14375,
        detectRange: 67.5,
        spawnRadiusMin: 8,
        spawnRadiusMax: 13.75,
        spriteWidth: 3.75,
        spriteHeight: 3.75,
        fireballCooldownMs: 5000,
      },
    },
    bossVariants: manifest.bossVariants,
    spawning: {
      enemyCap: enemyPack.enemyCap,
      spawnIntervalMs: enemyPack.spawnIntervalMs,
      spawnRadiusMin: enemyPack.spawnRadiusMin,
      ambientSpawnMaxDistanceFt: 160, // Derived from viewport (1280px / 8)
      ambientDespawnDistanceFt: enemyPack.despawnDistanceFt,
    },
    player: manifest.player,
    camera: manifest.camera,
    sprites:
      manifest.sprites?.welcomeSign !== undefined
        ? {
            welcomeSign: manifest.sprites.welcomeSign,
          }
        : undefined,
  };
}

/**
 * Validated Floor 1 configuration, loaded at module initialization.
 * Now derived from floor1.manifest.json for Phase 3 compatibility.
 */
export const floor1Config: Floor1Config = loadFloor1ConfigFromManifest();
