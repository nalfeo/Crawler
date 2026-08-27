/**
 * Enemy Pack Abstraction — config-driven enemy spawning system.
 *
 * This module provides a data-driven approach to enemy spawning,
 * replacing hardcoded archetype logic in floor1EnemyDirectorSystem.
 */
import { z } from 'zod';
import floor1EnemyPackJson from './data/enemies.floor1.json';
import floor2EnemyPackJson from './data/enemies.floor2.json';
import floor3EnemyPackJson from './data/enemies.floor3.json';

/**
 * Single enemy archetype configuration for spawning.
 */
const enemyArchetypeDefSchema = z
  .object({
    /** Unique identifier for this enemy type. */
    id: z.string().min(1),
    /** Display name for this enemy. */
    name: z.string().min(1),
    /** Base hit points. */
    hp: z.number().int().positive(),
    /** Movement speed in feet per frame. */
    speed: z.number().positive(),
    /** Detection range in feet. */
    detectRange: z.number().nonnegative(),
    /** Sprite texture ID from the sprite catalog. */
    spriteTexture: z.number().int().positive(),
    /** Sprite width in feet. */
    spriteWidth: z.number().positive().default(2),
    /** Sprite height in feet. */
    spriteHeight: z.number().positive().default(2),
    /** AI behavior type. */
    aiType: z
      .enum(['chase', 'patrol', 'ranged', 'flee', 'leaper', 'guardian', 'support'])
      .default('chase'),
    /** Spawn weight for weighted random selection (0-1). */
    spawnWeight: z.number().min(0).max(1),
    /**
     * Family this archetype belongs to (Floor 2, FR6/FR18). Omitted for
     * floor-neutral trash mobs. Matches `FamilyId` from
     * `src/core/faction-relations.ts`.
     */
    familyId: z.string().min(1).optional(),
    /**
     * `true` when this archetype is a family boss (spawned once into a
     * `BOSS_DEN` at floor-init). Bosses require `familyId`.
     */
    isBoss: z.boolean().optional(),
    /**
     * Explicit collision radius in feet. When set, overrides the default
     * `max(spriteWidth, spriteHeight) * 0.5` calculation (also in feet). Use
     * when the sprite's aspect ratio should not determine physics size — e.g. a
     * wide sprite whose collision footprint should match its height, not
     * its width.
     */
    collisionRadius: z.number().positive().optional(),
    /** Optional Floor 3 species line for wild-companion spawns. */
    speciesId: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((archetype, ctx) => {
    if (archetype.isBoss === true && archetype.familyId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['familyId'],
        message: `isBoss archetype "${archetype.id}" must set familyId`,
      });
    }
  });

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
    /** Minimum spawn radius from player in feet. */
    spawnRadiusMin: z.number().nonnegative(),
    /** Maximum spawn distance from player before despawning (in feet). */
    despawnDistanceFt: z.number().nonnegative(),
    /**
     * Radius (ft) around the player within which an enemy counts as actively
     * "engaging/pursuing". Drives the engagement-budget top-up and the inner
     * recycling ring (enemies outside this ring are eligible for eviction when
     * the global cap is reached and the player needs closer threats).
     */
    engageRadiusFt: z.number().positive(),
    /**
     * Desired number of engaging enemies within {@link engageRadiusFt}. The
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
 * Load and validate an enemy pack by ID.
 */
function loadEnemyPackByJson(json: unknown): EnemyPackDef {
  const parsed = enemyPackDefSchema.parse(json);
  return parsed;
}

/**
 * Enemy pack registry mapping pack IDs to their definitions.
 */
const ENEMY_PACK_REGISTRY = new Map<string, EnemyPackDef>([
  ['floor1-ambient', loadEnemyPackByJson(floor1EnemyPackJson)],
  ['floor2-families', loadEnemyPackByJson(floor2EnemyPackJson)],
  ['floor3-wild', loadEnemyPackByJson(floor3EnemyPackJson)],
]);

/**
 * Get an enemy pack by ID.
 * @param packId - The enemy pack identifier (e.g., "floor1-ambient")
 * @returns Enemy pack definition, or undefined if not found
 */
export function getFloorEnemyPack(packId: string): EnemyPackDef | undefined {
  return ENEMY_PACK_REGISTRY.get(packId);
}

/**
 * @deprecated Use getFloorEnemyPack("floor1-ambient") instead
 */
export const floor1EnemyPack: EnemyPackDef = ENEMY_PACK_REGISTRY.get('floor1-ambient')!;

/**
 * Floor 2 enemy pack — family bosses (`isBoss:true`, spawnWeight 0), family
 * trash (`familyId` set), and floor-neutral trash (no `familyId`). Boss
 * archetypes carry `spawnWeight: 0` so the ambient spawner never rolls them —
 * they are placed by {@link initializeFloor2Bosses} at floor init.
 */
export const floor2EnemyPack: EnemyPackDef = ENEMY_PACK_REGISTRY.get('floor2-families')!;

/** Get the boss archetype for a specific family id, or undefined if missing. */
export function getFloor2BossArchetype(familyId: string): EnemyArchetypeDef | undefined {
  return floor2EnemyPack.archetypes.find((a) => a.isBoss === true && a.familyId === familyId);
}

/** Get all trash archetypes for a specific family id. */
export function getFloor2FamilyTrash(familyId: string): readonly EnemyArchetypeDef[] {
  return floor2EnemyPack.archetypes.filter((a) => a.familyId === familyId && a.isBoss !== true);
}

/** Get the elite non-boss archetype for a specific Floor 2 family id. */
export function getFloor2FamilyEliteArchetype(familyId: string): EnemyArchetypeDef | undefined {
  const elites = floor2EnemyPack.archetypes.filter(
    (a) => a.familyId === familyId && a.isBoss !== true && a.id.includes('-elite-'),
  );
  return elites.length === 1 ? elites[0] : undefined;
}

/** Get a family's non-elite non-boss archetype for fallback visual usage. */
export function getFloor2FamilyFallbackArchetype(familyId: string): EnemyArchetypeDef | undefined {
  const nonElite = floor2EnemyPack.archetypes.filter(
    (a) => a.familyId === familyId && a.isBoss !== true && !a.id.includes('-elite-'),
  );
  return nonElite[0];
}

/** Get the floor-neutral trash pool (no `familyId`). */
export function getFloor2NeutralTrash(): readonly EnemyArchetypeDef[] {
  return floor2EnemyPack.archetypes.filter((a) => a.familyId === undefined);
}
