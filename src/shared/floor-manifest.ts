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
import floor3ManifestJson from './data/floors/floor3.manifest.json';
import floor4ManifestJson from './data/floors/floor4.manifest.json';
import { npcPlacementDefSchema } from './npc-placements.js';
import { floorBehaviorSchema } from './floor-behavior.js';
import { BiomeType } from './map-types.js';
import { runtimeTerrainPackIdSchema } from './terrain-pack-types.js';
import { getFloorEnemyPack } from './enemy-packs.js';

/** Shape of the parsed `floor4` manifest block, as seen by the cross-field refiner. */
interface Floor4WaveRefineInput {
  readonly phase: { readonly waveWindowMs: number };
  readonly waves?: {
    readonly enemyPackId: string;
    readonly wavesPerAct: number;
    readonly waveIntervalMs: number;
    readonly gateTelegraphMs: number;
    readonly baseBudget: number;
    readonly intraActRamp: number;
    readonly openingWaveBudgetScale: number;
    readonly actMultipliers: readonly number[];
    readonly acts: ReadonlyArray<{
      readonly act: number;
      readonly roster: ReadonlyArray<{ readonly archetypeId: string; readonly threatCost: number }>;
    }>;
  };
}

/**
 * Cross-field + registry validation for the Floor 4 `waves` block.
 *
 * Zod can express the per-field bounds, but not "the cadence fits the wave
 * window", "act rows are exactly 1..5 in order", or "every roster archetype
 * actually exists in the referenced enemy pack". Those are the authoring
 * mistakes that would otherwise surface as a mid-run spawn failure or a wave
 * that silently never releases, so they fail loudly at manifest load instead.
 */
function validateFloor4Waves(floor4: Floor4WaveRefineInput, ctx: z.RefinementCtx): void {
  const waves = floor4.waves;
  if (!waves) {
    return;
  }
  if ((waves.wavesPerAct - 1) * waves.waveIntervalMs >= floor4.phase.waveWindowMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['waves', 'waveIntervalMs'],
      message: 'Floor 4 wave cadence does not fit inside the act wave window',
    });
  }
  if (waves.gateTelegraphMs > waves.waveIntervalMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['waves', 'gateTelegraphMs'],
      message: 'Floor 4 gate telegraph is longer than the gap between waves',
    });
  }
  const pack = getFloorEnemyPack(waves.enemyPackId);
  if (!pack) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['waves', 'enemyPackId'],
      message: `Floor 4 wave enemy pack "${waves.enemyPackId}" is not registered`,
    });
  }
  waves.acts.forEach((actRow, index) => {
    if (actRow.act !== index + 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['waves', 'acts', index, 'act'],
        message: 'Floor 4 act rosters must be authored in act order 1..5',
      });
    }
    const seen = new Set<string>();
    for (const entry of actRow.roster) {
      if (seen.has(entry.archetypeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['waves', 'acts', index, 'roster'],
          message: `Floor 4 act ${actRow.act} lists archetype "${entry.archetypeId}" twice`,
        });
      }
      seen.add(entry.archetypeId);
      if (pack && !pack.archetypes.some((archetype) => archetype.id === entry.archetypeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['waves', 'acts', index, 'roster'],
          message: `Floor 4 act ${actRow.act} references archetype "${entry.archetypeId}", which is not in pack "${waves.enemyPackId}"`,
        });
      }
    }
    // A wave whose budget cannot afford its cheapest roster entry would spawn
    // nothing at all, which is an authoring bug rather than a design choice.
    const cheapest = Math.min(...actRow.roster.map((entry) => entry.threatCost));
    const multiplier = waves.actMultipliers[index] ?? 0;
    const openingScale = actRow.act === 1 ? waves.openingWaveBudgetScale : 1;
    const smallestBudget = Math.max(
      1,
      Math.round(waves.baseBudget * multiplier * openingScale * (1 + waves.intraActRamp * 0)),
    );
    if (cheapest > smallestBudget) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['waves', 'acts', index, 'roster'],
        message: `Floor 4 act ${actRow.act} cannot afford its cheapest archetype in its first wave (budget ${smallestBudget}, cost ${cheapest})`,
      });
    }
  });
}

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
    /**
     * Implementation maturity for this floor — the single source of truth for
     * "is this floor actually finishable end-to-end?".
     *
     * Deliberately NOT sweep-specific: any system that needs to know whether a
     * floor is real content (stair-enabling into the next floor, floor-select
     * UI, progression chaining) reads this rather than hardcoding a floor id.
     *
     * - `mvp`: the floor is implemented E2E with an attainable victory. This —
     *   NOT `released` — is what puts a floor in the implemented (sweepable)
     *   set, so a floor still stabilizing behind the release flag is still
     *   swept.
     * - `released`: the floor is shipped to players. Implies `mvp`; a floor may
     *   be `mvp` but not yet `released` while it stabilizes.
     * - `winBudgetMs`: the ACTIVE-time budget an official (tournament) win must
     *   land under, in simulated game time. Omitted means the floor has no
     *   validated budget yet, and a win is raw victory with no time bound.
     *
     * Defaulted so a manifest that predates this block still parses (as an
     * unimplemented floor with no budget).
     */
    implemented: z
      .object({
        mvp: z.boolean().default(false),
        released: z.boolean().default(false),
        winBudgetMs: z.number().int().positive().optional(),
      })
      .strict()
      .default(() => ({ mvp: false, released: false })),
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
    /**
     * Reference to enemy pack ID (e.g., "floor1-ambient") for floors whose
     * enemies come from an ambient pack.
     *
     * Omitted by floors that spawn exclusively from an authored schedule rather
     * than an ambient director — Floor 4's waves are precomputed manifests
     * (spec FR3.2), so it has no ambient pack to name. A floor that DOES run an
     * ambient director must set it; the director paths throw when it is absent
     * rather than silently spawning nothing.
     */
    enemyPackId: z.string().min(1).optional(),
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
    /**
     * Generic per-floor behavior switches. These replace hardcoded
     * `world.floor === 1` / `world.floorId === 'floor2'` conditionals inside
     * otherwise-generic systems: the system stays floor-agnostic and the floor
     * declares which behavior it wants. Every flag defaults to `false`, so a
     * new floor opts in explicitly.
     */
    behavior: floorBehaviorSchema.default(() => floorBehaviorSchema.parse({})),
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
    /** Floor-3-specific scenario config (ignored by other floors). */
    floor3: z
      .object({
        biomeRegionCount: z.number().int().min(1).optional(),
      })
      .strict()
      .optional(),
    /**
     * Floor-4-specific scenario config (ignored by other floors).
     *
     * Slice 1 authors ONLY the venue geometry — the act/wave/Headliner/shop
     * blocks named by spec FR8.2 arrive with the slices that consume them, so
     * this block never carries data no system reads yet.
     */
    floor4: z
      .object({
        /** Authored venue geometry, in tiles (see `ShowcaseArenaGenerator`). */
        arena: z
          .object({
            widthTiles: z.number().int().min(16),
            heightTiles: z.number().int().min(16),
            pillarSizeTiles: z.number().int().min(1),
            pillarInsetTiles: z.number().int().min(1),
            borderThicknessTiles: z.number().int().min(1),
          })
          .strict(),
        greenRoom: z
          .object({
            widthTiles: z.number().int().min(6),
            heightTiles: z.number().int().min(6),
          })
          .strict(),
        tunnel: z
          .object({
            lengthTiles: z.number().int().min(1),
            widthTiles: z.number().int().min(2),
          })
          .strict(),
        phase: z
          .object({
            countdownMs: z.number().int().min(0),
            actCount: z.literal(5),
            actDurationMs: z.number().int().positive(),
            waveWindowMs: z.number().int().positive(),
            headlineWindowMs: z.number().int().positive(),
            intermissionMs: z.number().int().min(0),
            overtimeCapMs: z.number().int().positive(),
          })
          .strict(),
        /**
         * Deterministic wave scheduling (spec R3). Every number the wave
         * director reads lives here — budget curve, per-act rosters and threat
         * costs, the live-enemy concurrency cap, the spawn-debt cap and the
         * gate telegraph lead — because FR3.3 forbids hardcoding them in the
         * system.
         */
        waves: z
          .object({
            /** Enemy pack id (see `src/shared/enemy-packs.ts`) the rosters draw from. */
            enemyPackId: z.string().min(1),
            /** Waves scheduled per act (spec FR3.1). */
            wavesPerAct: z.number().int().positive(),
            /** Act-relative spacing between wave releases (spec FR3.1). */
            waveIntervalMs: z.number().int().positive(),
            /** Lead time a feed gate flares before its wave releases. */
            gateTelegraphMs: z.number().int().min(0),
            /**
             * Threat budget of act 1's first wave before the act multiplier and
             * the intra-act ramp. Threat is an INTEGER unit so the spend loop
             * can never drift or fail to terminate.
             */
            baseBudget: z.number().int().positive(),
            /** Per-wave-index budget ramp inside an act (spec FR3.3). */
            intraActRamp: z.number().min(0),
            /** Scale applied to act 1's wave 0 only — the deliberately tiny opener. */
            openingWaveBudgetScale: z.number().positive().max(1),
            /** Per-act budget multipliers, act 1 → act 5 (spec FR3.3). */
            actMultipliers: z.array(z.number().positive()).length(5),
            /** Live hostile arena combatants allowed at once (spec FR3.5). */
            concurrencyCap: z.number().int().positive(),
            /** Maximum queued spawn debt; overflow beyond this is discarded (spec FR3.5). */
            debtCap: z.number().int().min(0),
            /** Spacing (ft) between the deterministic spawn slots behind a feed gate. */
            gateSlotSpacingFt: z.number().positive(),
            /** Per-act rosters and threat costs (spec FR3.3/FR8.2). */
            acts: z
              .array(
                z
                  .object({
                    act: z.number().int().min(1).max(5),
                    roster: z
                      .array(
                        z
                          .object({
                            archetypeId: z.string().min(1),
                            threatCost: z.number().int().positive(),
                          })
                          .strict(),
                      )
                      .min(1),
                  })
                  .strict(),
              )
              .length(5),
          })
          .strict()
          .optional(),
      })
      .strict()
      .superRefine((floor4, ctx) => {
        // Cross-field geometry checks the per-field bounds cannot express. A
        // venue that does not fit would move gate tiles, which is a breaking
        // change to every seeded wave manifest (FR3.4), so it must fail loudly
        // at load rather than clamp at generation.
        const { arena, greenRoom, tunnel } = floor4;
        if (
          arena.pillarInsetTiles + arena.pillarSizeTiles >=
          Math.min(arena.widthTiles, arena.heightTiles) / 2
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['arena', 'pillarInsetTiles'],
            message: 'pit-fixture pillars would meet in the middle of the arena',
          });
        }
        if (tunnel.widthTiles > greenRoom.heightTiles) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tunnel', 'widthTiles'],
            message: 'curtain tunnel is wider than the Green Room it opens into',
          });
        }
        if (greenRoom.heightTiles > arena.heightTiles) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['greenRoom', 'heightTiles'],
            message: 'Green Room is taller than the arena, so it would overflow the venue border',
          });
        }
        const border = arena.borderThicknessTiles;
        const arenaMidY = border + Math.floor(arena.heightTiles / 2);
        const tunnelY =
          border + Math.floor((arena.heightTiles * 3) / 4) - Math.floor(tunnel.widthTiles / 2);
        if (arenaMidY >= tunnelY && arenaMidY < tunnelY + tunnel.widthTiles) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['tunnel', 'widthTiles'],
            message: 'curtain tunnel mouth collides with the east feed gate',
          });
        }
        if (
          floor4.phase.waveWindowMs + floor4.phase.headlineWindowMs !==
          floor4.phase.actDurationMs
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['phase', 'actDurationMs'],
            message: 'Floor 4 act duration must equal wave window plus headline window',
          });
        }
        validateFloor4Waves(floor4, ctx);
      })
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
  .strict()
  .superRefine((manifest, ctx) => {
    // `released` means shipped-to-players, which cannot be true of a floor that
    // is not even finishable. Catching this in the schema keeps the released
    // sweep set from ever containing an unwinnable floor.
    if (manifest.implemented.released && !manifest.implemented.mvp) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['implemented', 'released'],
        message: 'implemented.released requires implemented.mvp to be true',
      });
    }
  });

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
  } else if (floorId === 'floor3') {
    manifestJson = floor3ManifestJson;
  } else if (floorId === 'floor4') {
    manifestJson = floor4ManifestJson;
  } else {
    throw new Error(`Floor manifest not found: ${floorId}`);
  }

  const parsed = floorManifestDefSchema.parse(manifestJson);
  return parsed;
}

/**
 * Validated Floor 1 manifest, loaded at module initialization.
 * @deprecated Use floor-registry.ts instead
 */
export const floor1Manifest: FloorManifestDef = loadFloorManifest('floor1');
export const floor2Manifest: FloorManifestDef = loadFloorManifest('floor2');
export const floor3Manifest: FloorManifestDef = loadFloorManifest('floor3');
export const floor4Manifest: FloorManifestDef = loadFloorManifest('floor4');
