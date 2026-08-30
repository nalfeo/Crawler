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
import floor5ManifestJson from './data/floors/floor5.manifest.json';
import { npcPlacementDefSchema } from './npc-placements.js';
import { floorBehaviorSchema } from './floor-behavior.js';
import { getFloorEnemyPack } from './enemy-packs.js';
import { BiomeType } from './map-types.js';
import { runtimeTerrainPackIdSchema } from './terrain-pack-types.js';

/** Shape {@link validateFloor4Waves} reads out of the parsed `floor4` block. */
interface Floor4WaveValidationInput {
  readonly phase: {
    readonly actCount: number;
    readonly waveWindowMs: number;
    readonly overtimeCapMs: number;
  };
  readonly waves: {
    readonly enemyPackId: string;
    readonly cadence: { readonly wavesPerAct: number; readonly intervalMs: number };
    readonly budget: { readonly actMultipliers: readonly number[] };
    readonly concurrency: { readonly liveCap: number };
    readonly rosters: readonly {
      readonly act: number;
      readonly entries: readonly { readonly archetypeId: string }[];
    }[];
  };
  readonly headliners?: {
    readonly enemyPackId: string;
    readonly pool: readonly {
      readonly archetypeId: string;
      readonly grade: string;
    }[];
    readonly slots: readonly {
      readonly act: number;
      readonly eligibleGrades: readonly string[];
      readonly fixedArchetypeId?: string;
      readonly appearanceFeeGold: number;
      readonly contactDamage: number;
    }[];
  };
  readonly economy?: {
    readonly actIncomeBudgetGold: readonly {
      readonly act: number;
      readonly minWaveGold: number;
      readonly maxWaveGold: number;
    }[];
    readonly visitPriceBandGold: readonly {
      readonly visitIndex: number;
      readonly minGold: number;
      readonly maxGold: number;
    }[];
  };
  readonly overtime?: {
    readonly capMs: number;
    readonly rampSteps: readonly {
      readonly atMs: number;
      readonly speedMultiplier: number;
      readonly damageMultiplier: number;
    }[];
  };
}

/**
 * Cross-field validation for the Floor 4 wave schedule (spec FR3.1–FR3.5).
 *
 * These are contracts the per-field bounds cannot express, and every one of
 * them would otherwise fail silently at runtime — a roster naming a
 * nonexistent archetype would spawn nothing, and a cadence that overruns the
 * wave window would author waves that are cut the instant they release. Failing
 * at manifest load makes the data wrong loudly instead of quietly.
 */
function validateFloor4Waves(floor4: Floor4WaveValidationInput, ctx: z.RefinementCtx): void {
  const { phase, waves } = floor4;
  const pack = getFloorEnemyPack(waves.enemyPackId);
  if (!pack) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['waves', 'enemyPackId'],
      message: `unknown enemy pack "${waves.enemyPackId}"`,
    });
  }

  if (waves.budget.actMultipliers.length !== phase.actCount) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['waves', 'budget', 'actMultipliers'],
      message: `expected one act multiplier per act (${phase.actCount}), got ${waves.budget.actMultipliers.length}`,
    });
  }

  // The last wave must still release INSIDE the wave window, otherwise the
  // authored cadence silently drops waves at the cut (FR3.6).
  const lastReleaseMs = (waves.cadence.wavesPerAct - 1) * waves.cadence.intervalMs;
  if (lastReleaseMs >= phase.waveWindowMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['waves', 'cadence', 'intervalMs'],
      message: `wave ${waves.cadence.wavesPerAct - 1} would release at ${lastReleaseMs}ms, at or after the ${phase.waveWindowMs}ms wave window ends`,
    });
  }

  if (pack && waves.concurrency.liveCap > pack.enemyCap) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['waves', 'concurrency', 'liveCap'],
      message: `live cap ${waves.concurrency.liveCap} exceeds the "${waves.enemyPackId}" pack cap ${pack.enemyCap}`,
    });
  }

  const expectedActs = Array.from({ length: phase.actCount }, (_, index) => index + 1);
  const authoredActs = waves.rosters.map((roster) => roster.act);
  if (
    authoredActs.length !== expectedActs.length ||
    authoredActs.some((act, index) => act !== expectedActs[index])
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['waves', 'rosters'],
      message: `rosters must list acts ${expectedActs.join(',')} exactly once, in order; got ${authoredActs.join(',')}`,
    });
  }

  if (!pack) {
    return;
  }
  const knownArchetypes = new Set(pack.archetypes.map((archetype) => archetype.id));
  for (const [rosterIndex, roster] of waves.rosters.entries()) {
    for (const [entryIndex, entry] of roster.entries.entries()) {
      if (!knownArchetypes.has(entry.archetypeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['waves', 'rosters', rosterIndex, 'entries', entryIndex, 'archetypeId'],
          message: `archetype "${entry.archetypeId}" is not in enemy pack "${waves.enemyPackId}"`,
        });
      }
    }
  }
}

function validateFloor4Headliners(floor4: Floor4WaveValidationInput, ctx: z.RefinementCtx): void {
  const { headliners, overtime, phase } = floor4;
  if (!headliners) {
    return;
  }
  const pack = getFloorEnemyPack(headliners.enemyPackId);
  if (!pack) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['headliners', 'enemyPackId'],
      message: `unknown enemy pack "${headliners.enemyPackId}"`,
    });
    return;
  }

  const knownArchetypes = new Set(pack.archetypes.map((archetype) => archetype.id));
  const poolIds = new Set<string>();
  const fixedArchetypeIds = new Set(
    headliners.slots.flatMap((slot) => (slot.fixedArchetypeId ? [slot.fixedArchetypeId] : [])),
  );
  if (fixedArchetypeIds.size !== headliners.slots.filter((slot) => slot.fixedArchetypeId).length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['headliners', 'slots'],
      message: 'fixed Headliner archetypes must be unique',
    });
  }
  for (const [index, entry] of headliners.pool.entries()) {
    if (poolIds.has(entry.archetypeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headliners', 'pool', index, 'archetypeId'],
        message: `duplicate Headliner archetype "${entry.archetypeId}"`,
      });
    }
    poolIds.add(entry.archetypeId);
    if (!knownArchetypes.has(entry.archetypeId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headliners', 'pool', index, 'archetypeId'],
        message: `Headliner archetype "${entry.archetypeId}" is not in enemy pack "${headliners.enemyPackId}"`,
      });
    }
  }
  if (headliners.pool.length < 8) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['headliners', 'pool'],
      message: 'Floor 4 requires at least eight seeded Headliner candidates',
    });
  }

  const expectedActs = Array.from({ length: phase.actCount }, (_, index) => index + 1);
  const authoredActs = headliners.slots.map((slot) => slot.act);
  if (
    authoredActs.length !== expectedActs.length ||
    authoredActs.some((act, index) => act !== expectedActs[index])
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['headliners', 'slots'],
      message: `Headliner slots must list acts ${expectedActs.join(',')} exactly once, in order; got ${authoredActs.join(',')}`,
    });
  }

  for (const [slotIndex, slot] of headliners.slots.entries()) {
    const eligiblePool = headliners.pool.filter((entry) =>
      slot.eligibleGrades.includes(entry.grade),
    );
    if (slot.fixedArchetypeId) {
      if (!poolIds.has(slot.fixedArchetypeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headliners', 'slots', slotIndex, 'fixedArchetypeId'],
          message: `fixed Headliner "${slot.fixedArchetypeId}" is not in the Headliner pool`,
        });
      }
      if (!eligiblePool.some((entry) => entry.archetypeId === slot.fixedArchetypeId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['headliners', 'slots', slotIndex, 'eligibleGrades'],
          message: `fixed Headliner "${slot.fixedArchetypeId}" is not eligible for act ${slot.act}`,
        });
      }
      continue;
    }
    if (eligiblePool.filter((entry) => !fixedArchetypeIds.has(entry.archetypeId)).length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['headliners', 'slots', slotIndex, 'eligibleGrades'],
        message: `act ${slot.act} has no eligible non-fixed Headliners`,
      });
    }
  }

  if (overtime && overtime.capMs !== phase.overtimeCapMs) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['overtime', 'capMs'],
      message: 'Floor 4 overtime cap must match phase.overtimeCapMs',
    });
  }
  if (overtime) {
    let previousAtMs = -1;
    for (const [index, step] of overtime.rampSteps.entries()) {
      if (step.atMs <= previousAtMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['overtime', 'rampSteps', index, 'atMs'],
          message: 'overtime ramp steps must be strictly increasing',
        });
      }
      if (step.atMs >= overtime.capMs) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['overtime', 'rampSteps', index, 'atMs'],
          message: 'overtime ramp steps must occur before the cap',
        });
      }
      previousAtMs = step.atMs;
    }
  }
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
            /**
             * Fixed sponsor-table identities (spec §7.2: "Tables are fixed
             * identities across the floor"). Two-to-three tables; the same set
             * exists at every break, only branding and stock change. `id` is the
             * stable identity used in the per-visit stock stream key
             * (`<seed>:floor4:stock:<visitIndex>:<tableId>`) and `archetypeId`
             * names the shop-archetype pool the table draws from. Pool→archetype
             * resolution is validated at stock-roll time in the game layer, not
             * here, to keep this schema pure structural data.
             */
            tables: z
              .array(
                z
                  .object({
                    id: z.string().min(1),
                    archetypeId: z.string().min(1),
                  })
                  .strict(),
              )
              .min(2)
              .max(3),
            /**
             * Per-visit price-tier multiplier applied on top of each archetype's
             * own `priceMultiplier` (fed to `generateShopInventory` as
             * `tierMultiplier`). Indexed by 0-based visit (one per Headliner);
             * length must equal `phase.actCount`. Later breaks carry higher
             * prices so the gold curve stays coupled to the threat curve
             * (spec §7.1). Slice A authors a single curve shared by all tables;
             * per-table pricing is a later seam.
             */
            priceTierByVisit: z.array(z.number().positive()),
            /**
             * Per-visit worst-case gold-on-hand from guaranteed appearance fees
             * alone (spec §8: "every Green Room must be able to buy something
             * meaningful"). Every visit's rolled stock must contain at least one
             * offer priced at or below this budget. Indexed by 0-based visit;
             * length must equal `phase.actCount`, and every entry must match
             * that act's authored Headliner `appearanceFeeGold` so the budget
             * cannot drift away from the gold actually granted at runtime.
             */
            affordabilityBudgetByVisit: z.array(z.number().positive()),
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
         * Wave scheduling contract (spec FR3.1–FR3.5, FR8.2). Every number the
         * wave machinery reads lives here — the director hardcodes none of it,
         * so the balance slice can retune cadence, budget, caps and telegraph
         * lead without touching code.
         */
        waves: z
          .object({
            /**
             * Enemy pack the act rosters draw archetype stats from. Floor 4
             * deliberately leaves the top-level `enemyPackId` unset (it runs no
             * ambient director, FR3.2), so the pack is named here where the
             * authored schedule actually consumes it.
             */
            enemyPackId: z.string().min(1),
            cadence: z
              .object({
                /** Waves scheduled per act (FR3.1). */
                wavesPerAct: z.number().int().min(1),
                /** Act-relative spacing between wave releases, in ms (FR3.1). */
                intervalMs: z.number().int().positive(),
              })
              .strict(),
            budget: z
              .object({
                /** `baseBudget` in the FR3.3 curve. */
                base: z.number().positive(),
                /** `actMultiplier[act]`, indexed act-1. Length must equal `phase.actCount`. */
                actMultipliers: z.array(z.number().positive()).min(1),
                /** `intraActRamp` in the FR3.3 curve. */
                intraActRamp: z.number().min(0),
                /**
                 * Extra multiplier applied ONLY to act 1's wave 0 — the
                 * deliberately tiny opener that teaches the gates (design §5.1).
                 */
                openingWaveMultiplier: z.number().positive().max(1),
                /**
                 * Hard ceiling on entries in one wave manifest. A guard, not a
                 * dial: it bounds manifest size (and therefore spawn debt) even
                 * if a future roster authors a near-zero threat cost.
                 */
                maxEntriesPerWave: z.number().int().positive(),
              })
              .strict(),
            concurrency: z
              .object({
                /** Live wave-enemy concurrency cap (FR3.5). */
                liveCap: z.number().int().positive(),
                /** Maximum banked spawn debt; overflow beyond this is discarded (FR3.5). */
                debtCap: z.number().int().nonnegative(),
              })
              .strict(),
            gates: z
              .object({
                /** How long before a wave releases its gates telegraph (design §4). */
                telegraphLeadMs: z.number().int().nonnegative(),
              })
              .strict(),
            /**
             * Per-act roster with authored threat costs and composition weights
             * (FR3.3). Ordered by act; entry order inside an act is a data
             * contract because it is the weighted-draw order.
             */
            rosters: z
              .array(
                z
                  .object({
                    act: z.number().int().min(1).max(5),
                    entries: z
                      .array(
                        z
                          .object({
                            archetypeId: z.string().min(1),
                            threatCost: z.number().positive(),
                            weight: z.number().positive(),
                          })
                          .strict(),
                      )
                      .min(1),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
        headliners: z
          .object({
            enemyPackId: z.string().min(1),
            pool: z
              .array(
                z
                  .object({
                    archetypeId: z.string().min(1),
                    grade: z.enum(['warmup', 'midcard', 'main-event', 'finale']),
                    displayName: z.string().min(1),
                    entranceAnnouncement: z.string().min(1),
                  })
                  .strict(),
              )
              .min(8),
            slots: z
              .array(
                z
                  .object({
                    act: z.number().int().min(1).max(5),
                    eligibleGrades: z
                      .array(z.enum(['warmup', 'midcard', 'main-event', 'finale']))
                      .min(1),
                    fixedArchetypeId: z.string().min(1).optional(),
                    appearanceFeeGold: z.number().int().nonnegative(),
                    contactDamage: z.number().int().positive(),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
        /**
         * Slice-7 economy contract (spec FR6.7/FR6.8, FR10.3).
         *
         * `actIncomeBudgetGold` is the authored band of **wave drop income**
         * one act may realise, excluding the guaranteed Headliner appearance
         * fee (which is authored per slot and reported separately). The
         * headless gate asserts realised per-act income against it, so a
         * balance change that quietly inflates or starves the gold curve fails
         * loudly instead of drifting.
         *
         * `visitPriceBandGold` is the authored price window each visit's rolled
         * stock must land inside, derived from the archetype pools scaled by
         * that visit's `priceTierByVisit`. Enforced when the visit rolls, so a
         * pool or tier edit that pushes prices out of band cannot ship silently.
         */
        economy: z
          .object({
            actIncomeBudgetGold: z
              .array(
                z
                  .object({
                    act: z.number().int().min(1).max(5),
                    minWaveGold: z.number().int().nonnegative(),
                    maxWaveGold: z.number().int().nonnegative(),
                  })
                  .strict(),
              )
              .min(1),
            visitPriceBandGold: z
              .array(
                z
                  .object({
                    visitIndex: z.number().int().min(0).max(4),
                    minGold: z.number().int().positive(),
                    maxGold: z.number().int().positive(),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
        overtime: z
          .object({
            capMs: z.number().int().positive(),
            warningAnnouncement: z.string().min(1),
            finisherAnnouncement: z.string().min(1),
            rampSteps: z
              .array(
                z
                  .object({
                    atMs: z.number().int().min(0),
                    speedMultiplier: z.number().positive(),
                    damageMultiplier: z.number().positive(),
                  })
                  .strict(),
              )
              .min(1),
          })
          .strict(),
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
        // Green Room shop lifecycle (spec §7.1–§7.2): fixed table identities must
        // be unique, and both per-visit arrays must cover exactly one entry per
        // act so every break has authorized pricing and an affordability budget.
        const tableIds = new Set<string>();
        for (const table of greenRoom.tables) {
          if (tableIds.has(table.id)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['greenRoom', 'tables'],
              message: `duplicate Green Room table id "${table.id}"`,
            });
          }
          tableIds.add(table.id);
        }
        if (greenRoom.priceTierByVisit.length !== floor4.phase.actCount) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['greenRoom', 'priceTierByVisit'],
            message: `expected one price tier per act (${floor4.phase.actCount}), got ${greenRoom.priceTierByVisit.length}`,
          });
        }
        if (greenRoom.affordabilityBudgetByVisit.length !== floor4.phase.actCount) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['greenRoom', 'affordabilityBudgetByVisit'],
            message: `expected one affordability budget per act (${floor4.phase.actCount}), got ${greenRoom.affordabilityBudgetByVisit.length}`,
          });
        }
        for (let index = 0; index < greenRoom.affordabilityBudgetByVisit.length; index += 1) {
          const act = index + 1;
          const slot = floor4.headliners.slots.find((entry) => entry.act === act);
          if (slot && greenRoom.affordabilityBudgetByVisit[index] !== slot.appearanceFeeGold) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['greenRoom', 'affordabilityBudgetByVisit', index],
              message: `expected Green Room affordability budget for act ${act} to match appearanceFeeGold ${slot.appearanceFeeGold}`,
            });
          }
        }
        // Slice-7 economy contract (FR6.7/FR6.8). Both bands must cover every
        // act/visit exactly once, be ordered, and stay coupled to the
        // affordability budget so an authored band can never make a break
        // unshoppable.
        const economy = floor4.economy;
        const expectedIncomeActs = Array.from(
          { length: floor4.phase.actCount },
          (_unused, index) => index + 1,
        );
        if (
          economy.actIncomeBudgetGold.map((entry) => entry.act).join(',') !==
          expectedIncomeActs.join(',')
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['economy', 'actIncomeBudgetGold'],
            message: `income budgets must list acts ${expectedIncomeActs.join(',')} exactly once, in order`,
          });
        }
        for (const [index, entry] of economy.actIncomeBudgetGold.entries()) {
          if (entry.minWaveGold > entry.maxWaveGold) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['economy', 'actIncomeBudgetGold', index],
              message: `act ${entry.act} income budget is inverted (${entry.minWaveGold} > ${entry.maxWaveGold})`,
            });
          }
        }
        const expectedVisits = expectedIncomeActs.map((act) => act - 1);
        if (
          economy.visitPriceBandGold.map((entry) => entry.visitIndex).join(',') !==
          expectedVisits.join(',')
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['economy', 'visitPriceBandGold'],
            message: `price bands must list visits ${expectedVisits.join(',')} exactly once, in order`,
          });
        }
        for (const [index, band] of economy.visitPriceBandGold.entries()) {
          if (band.minGold > band.maxGold) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['economy', 'visitPriceBandGold', index],
              message: `visit ${band.visitIndex} price band is inverted (${band.minGold} > ${band.maxGold})`,
            });
          }
          const budget = greenRoom.affordabilityBudgetByVisit[band.visitIndex];
          if (budget !== undefined && band.minGold > budget) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ['economy', 'visitPriceBandGold', index],
              message: `visit ${band.visitIndex} cheapest authorized price ${band.minGold} exceeds its affordability budget ${budget}, so the break could not be shopped`,
            });
          }
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
        validateFloor4Headliners(floor4, ctx);
      })
      .optional(),
    /** Floor-5-specific authored siege geometry and phase skeleton config. */
    floor5: z
      .object({
        commandPost: z
          .object({
            widthTiles: z.number().int().min(6),
            heightTiles: z.number().int().min(6),
            health: z.number().int().positive(),
          })
          .strict(),
        siegeYard: z
          .object({
            widthTiles: z.number().int().min(6),
            heightTiles: z.number().int().min(6),
          })
          .strict(),
        flankPockets: z
          .object({
            widthTiles: z.number().int().min(6),
            heightTiles: z.number().int().min(6),
          })
          .strict(),
        lane: z
          .object({
            lengthTiles: z.number().int().min(12),
            widthTiles: z.number().int().min(4),
          })
          .strict(),
        outerWall: z
          .object({
            thicknessTiles: z.number().int().min(1),
            breachWidthTiles: z.number().int().min(1),
          })
          .strict(),
        courtyard: z
          .object({
            widthTiles: z.number().int().min(8),
            heightTiles: z.number().int().min(8),
          })
          .strict(),
        throneRoom: z
          .object({
            widthTiles: z.number().int().min(8),
            heightTiles: z.number().int().min(8),
          })
          .strict(),
        winnersBalcony: z
          .object({
            widthTiles: z.number().int().min(6),
            heightTiles: z.number().int().min(4),
          })
          .strict(),
        borderThicknessTiles: z.number().int().min(1),
        phase: z
          .object({
            initial: z.literal('MUSTER'),
            terminal: z.array(z.enum(['CAPTURED', 'DEFEAT'])).length(2),
          })
          .strict(),
        rngStreams: z.array(z.enum(['waves', 'heroes', 'tasks', 'dressing', 'rewards'])).length(5),
      })
      .strict()
      .superRefine((floor5, ctx) => {
        if (floor5.outerWall.breachWidthTiles > floor5.lane.widthTiles) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['outerWall', 'breachWidthTiles'],
            message: 'breach width cannot exceed primary lane width',
          });
        }
        const streamKeys = new Set(floor5.rngStreams);
        if (streamKeys.size !== floor5.rngStreams.length) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['rngStreams'],
            message: 'Floor 5 RNG stream labels must be unique',
          });
        }
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
  } else if (floorId === 'floor5') {
    manifestJson = floor5ManifestJson;
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
export const floor5Manifest: FloorManifestDef = loadFloorManifest('floor5');
