import { z } from 'zod';
import { DEFAULT_FLOOR, MAX_FLOOR } from './content-direction.js';
import { SIZE_VARIANTS } from './size-variants.js';

/**
 * Sprite brief schema.
 *
 * A brief is the small, reviewable text artifact that fully describes one sprite
 * for the generation pipeline. Every later phase (generator, post-processor,
 * sensors, judge) reads the same brief.
 *
 * The schema mirrors the YAML shape documented in the sprite generation pipeline
 * spec. Briefs are typically authored as YAML and parsed into JSON before
 * validation, but Zod is format-agnostic.
 */

// Canonical sprite-type vocabulary lives in `src/shared/sprite-types.ts` (the
// single source of truth shared with the engine-facing manifest schema).
// Re-exported here so the many `./brief-schema.js` importers stay unchanged.
export { SPRITE_TYPES, type SpriteType } from '../../src/shared/sprite-types.js';
import { SPRITE_TYPES } from '../../src/shared/sprite-types.js';

const rgbTriple = z
  .tuple([
    z.number().int().min(0).max(255),
    z.number().int().min(0).max(255),
    z.number().int().min(0).max(255),
  ])
  .describe('An [r, g, b] color triple, each channel 0-255.');

const sizeSchema = z
  .object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  })
  .strict();

const anchorSchema = z
  .object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
  })
  .strict()
  .describe('Anchor pixel in the final post-processed sprite. Must be opaque.');

/**
 * Palette is referenced by id (a JSON file in data/palettes/<id>.json) and may
 * additionally carry inline colors when the brief is materialised after palette
 * resolution. The id is required so reviews can spot art-direction drift; the
 * inline colors are optional and live only in the resolved form passed to the
 * post-processor and sensors.
 */
const paletteSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'palette id must be lowercase kebab-case'),
    colors: z.array(rgbTriple).min(2).optional(),
  })
  .strict();

const referenceSchema = z
  .object({
    path: z.string().min(1),
    note: z.string().optional(),
  })
  .strict();

/**
 * Optional sheet-mode generation hints. The pipeline defaults to a 4x4 grid
 * with 16 variants, no empty cells. Rationale: a 1024 native canvas split
 * 4-ways yields 256x256 cells, which resample cleanly by an integer factor
 * to the default 64x64 output (and any larger integer multiples); 16 variants per call gives the
 * scoring loop enough headroom to reject low-quality candidates without
 * paying for a second provider round-trip. The slicer requires `nativeCanvas`
 * to be evenly divisible by both `rows` and `cols`, which the defaults
 * satisfy by construction.
 *
 * - `rows` x `cols` defines the grid. Variant count equals `rows * cols` minus
 *   the number of declared `emptyCells`.
 * - `emptyCells` lists `[row, col]` coordinates (0-based) the model should
 *   leave deliberately empty — useful when a brief wants 8 variants in a 3x3.
 *   Defaults to none.
 * - `nativeCanvas` is the requested square pixel side of the *whole sheet*
 *   sent to the provider. Defaults to 1024.
 */
const sheetSchema = z
  .object({
    rows: z.number().int().min(1).max(8).default(4),
    cols: z.number().int().min(1).max(8).default(4),
    emptyCells: z.array(z.tuple([z.number().int().min(0), z.number().int().min(0)])).default([]),
    nativeCanvas: z.number().int().min(256).max(2048).default(1024),
  })
  .strict()
  .default({ rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 });

const generationSchema = z
  .object({
    sheet: sheetSchema,
  })
  .strict()
  .default({ sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } });

/**
 * Optional per-brief sensor threshold overrides. Defaults are baked into
 * `scripts/sprites/score-candidate.ts`; briefs only need to set fields they
 * actually want to relax or tighten.
 *
 * Nested by sensor family so adding new groups (items, enemies, tiles, vfx)
 * is additive without restructuring existing briefs.
 */
const sensorOverridesSchema = z
  .object({
    opaqueRatio: z
      .object({
        disabled: z.boolean().optional(),
        min: z.number().min(0).max(1).optional(),
        max: z.number().min(0).max(1).optional(),
      })
      .strict()
      .optional(),
    weapon: z
      .object({
        diagonalToleranceDeg: z.number().min(0).max(45).optional(),
        orientation: z.enum(['any', 'diagonal', 'vertical', 'horizontal']).optional(),
      })
      .strict()
      .optional(),
    /**
     * Edge-clipping / bleed-artifact guard.
     *
     * By default, variants fail when the main silhouette touches the frame edge
     * (likely clipped) or when a disconnected edge-touching fragment appears
     * (often bleed from an adjacent sheet cell).
     *
     * Use overrides only when a brief intentionally wants border contact.
     */
    edge: z
      .object({
        allowMainTouch: z.boolean().default(false),
        allowDetachedEdgeComponents: z.boolean().default(false),
        maxDetachedEdgePixels: z.number().int().min(0).max(512).default(0),
      })
      .strict()
      .optional(),
    enemy: z
      .object({
        /**
         * Shared orientation hint block used by character-facing checks and
         * prompt generation.
         *
         * - Characters still default to front-facing checks when `facing` is
         *   omitted (score-candidate enforces vertical silhouette orientation
         *   only for `facing: 'front'`).
         * - Enemy scoring no longer uses orientation-axis gating, but the
         *   value flows into the mob-rules prompt so authors can choose a
         *   camera-facing pose or a left/right three-quarter bias. The enemy
         *   sprite-type template defaults to `three-quarter`; left/right never
         *   permits a full side profile.
         */
        facing: z.enum(['front', 'three-quarter', 'left', 'right', 'any']).optional(),
        toleranceDeg: z.number().min(0).max(45).default(2),
      })
      .strict()
      .optional(),
    interiorHoles: z
      .object({
        maxPixels: z.number().int().min(0).max(512).default(0),
      })
      .strict()
      .optional(),
    /**
     * Per-variant derived anchor opt-in. When `derive: true`, the scorer
     * replaces the static `anchor-opaque` sensor with `anchor-derivable`,
     * which finds the bottom-center grip pixel from the silhouette instead
     * of asserting a single pre-declared pixel. The brief's `anchor` field
     * becomes informational in that mode.
     *
     * - `bandRows`: how many rows up from the bottom edge are eligible for
     *   the grip. Default 4. Range 1-8.
     * - `centerToleranceX`: max horizontal distance (px) between the
     *   chosen grip-run midpoint and frame center before the variant is
     *   rejected. Default 3. Range 0-8.
     */
    anchor: z
      .object({
        derive: z.boolean().default(false),
        mode: z.enum(['static', 'grip', 'center-of-mass']).default('static'),
        bandRows: z.number().int().min(1).max(32).default(4),
        centerToleranceX: z.number().int().min(0).max(64).default(3),
      })
      .strict()
      .optional(),
  })
  .strict()
  .default({});

export const briefThemeSchema = z
  .object({
    setId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'theme.setId must be lowercase kebab-case'),
    displayName: z.string().trim().min(1).max(80),
    designLanguage: z.string().trim().min(10).max(2_000),
  })
  .strict();

export const briefSchema = z
  .object({
    type: z.enum(SPRITE_TYPES),
    mobRole: z.enum(['normal', 'elite', 'boss']).optional(),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be lowercase kebab-case'),
    theme: briefThemeSchema.optional(),
    size: sizeSchema,
    palette: paletteSchema,
    anchor: anchorSchema,
    tags: z.array(z.string().min(1)).default([]),
    prompt: z.string().min(1),
    floor: z.number().int().min(DEFAULT_FLOOR).max(MAX_FLOOR).default(DEFAULT_FLOOR),
    /**
     * Legacy author-pinned reference images. NO LONGER READ by generation:
     * the pipeline now selects our own highest-quality approved sprites at
     * generate-time (see `reference-selector.ts`), and the Kenney placeholder
     * spritesheets these historically pointed at are retired. Kept optional +
     * defaulting to `[]` so existing briefs (and the per-type defaults) still
     * validate; forward-compat only, not a generation input.
     */
    references: z.array(referenceSchema).default([]),
    generation: generationSchema,
    sensors: sensorOverridesSchema,
    /**
     * Optional discrete on-theme embellishments the model is invited to
     * distribute across cells (one per cell, never combined). Free-form
     * natural language so authors can iterate without schema churn.
     *
     * Treat this as the *seed* list. At run time the orchestrator may
     * call a text LLM to top this list up to `minVariations` entries so
     * authors don't have to brainstorm exhaustively. Author-supplied
     * entries always survive the expansion pass; the LLM only appends.
     *
     * Use this for thematic variety that the continuous "vary along
     * silhouette / shading / material" axes in the sheet prompt cannot
     * express — e.g. "spiked iron pommel at the base", "wolf skull
     * instead of human skull". Set `minVariations: 0` for briefs where
     * the subject must stay strictly canonical (e.g. icons matching
     * existing in-game art).
     */
    variations: z.array(z.string().trim().min(1)).max(20).default([]),
    /**
     * Minimum total variations to feed into the sheet prompt after the
     * optional LLM expansion pass runs.
     *
     *   - `0` disables expansion entirely (canonical sprites: stick to
     *     the author's `variations` exactly, even if empty).
     *   - `N > 0` asks the orchestrator to top up `variations` to at
     *     least N entries by calling the text provider, when one is
     *     configured. If no text provider is available the run still
     *     succeeds — the orchestrator emits a warning and proceeds with
     *     whatever seed `variations` already contained.
     *
     * Default of 4 reflects the empirical sweet spot: enough discrete
     * embellishments to spread across a 4×4 sheet without looking
     * repetitive, few enough that the model doesn't get overwhelmed.
     */
    minVariations: z.number().int().min(0).max(20).default(4),
    /**
     * Opt-in for the local-only VLM judge (spec §F4).
     *
     * The judge runs four evaluators (`design_language`,
     * `reference_style_match`, `brief_match`, `readability`) on each sensor-passing variant via a vision model
     * and rejects variants where ANY evaluator scores below 3 (on the
     * 1-5 ordinal scale). Disabled by default so existing briefs and
     * unattended-but-CI runs are unaffected — flip to `enabled: true`
     * on briefs where you want unattended quality filtering beyond what
     * the deterministic sensors catch.
     *
     * NEVER enabled in CI: `judge.ts` refuses to run when `process.env.CI`
     * is defined (Constitutional §3 — non-deterministic + costs Azure
     * credits). The flag is enforced at the orchestrator boundary even
     * if a brief sets `enabled: true`.
     *
     * `maxVariants` caps how many sensor-passing candidates get judged
     * per run; the judge ranks sensor-passing variants by sensor score
     * and keeps the top N. Default is 16 — high enough for a full 4x4
     * sheet, low enough that an accidental brief with thousands of
     * variants can't run away with the cost. Set lower (e.g. 4) to
     * keep cost predictable on large batches.
     */
    judge: z
      .object({
        enabled: z.boolean().default(false),
        maxVariants: z.number().int().min(1).max(64).default(16),
      })
      .strict()
      .default({ enabled: false, maxVariants: 16 }),
    /**
     * Optional post-processing overrides beyond the standard pipeline.
     *
     * `trimAndFit`: when enabled, after the normal postprocess steps
     * (bg removal → resample to brief size → quantize → alpha threshold), the
     * pipeline trims fully-transparent edge rows/columns and then
     * scales the result up (nearest-neighbor) so the smallest
     * dimension reaches `minDimension` pixels. This maximises pixel
     * utilisation for sprites that don't fill their canvas.
     *
     * The `dimensions-exact` sensor should be disabled or adjusted
     * when this is enabled since the output size becomes dynamic.
     */
    postprocessing: z
      .object({
        trimAndFit: z.boolean().default(false),
        minDimension: z.number().int().min(8).max(256).default(64),
        paletteMode: z.enum(['none', 'strict']).default('none'),
      })
      .strict()
      .default({ trimAndFit: false, minDimension: 64, paletteMode: 'none' }),
    /**
     * Opt-in icon-batch mode.
     *
     * When present, each cell on the sheet is a DIFFERENT icon concept rather
     * than a variant of one subject. Used for achievement icons, ability icons,
     * and other UI icon families where batching many distinct symbols into one
     * generation call reduces cost (~15× vs per-icon calls).
     *
     * Key differences from a normal brief:
     *   - `minVariations` should be 0 — variation expansion is skipped.
     *   - Each entry's `id` becomes the manifest key and asset filename.
     *   - Approval uses `approveIconBatch()` (not `approveVariant()`).
     *   - The prompt builder emits per-cell concept labels instead of a
     *     single subject + thematic-variations list.
     *
     * Length must equal `generation.sheet.rows × cols − emptyCells.length`.
     * Validated in `superRefine` below.
     */
    iconBatch: z
      .array(
        z
          .object({
            /** Manifest key and asset filename for this icon. Kebab-case. */
            id: z
              .string()
              .min(1)
              .regex(/^[a-z0-9][a-z0-9-]*$/, 'iconBatch entry id must be lowercase kebab-case'),
            /** Short human-readable name shown in the cell label prompt. */
            concept: z.string().trim().min(1).max(200),
            /** Optional detailed visual description for this cell's icon. */
            description: z.string().trim().min(1).max(1000).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16)
      .optional(),
    /**
     * Opt-in ORDERED frame-sequence mode (walk-cycle animation sheets).
     *
     * When enabled, the sheet's cells are NOT independent design
     * alternatives of one static sprite (the normal sheet-mode meaning) —
     * they are an ORDERED sequence of poses of the SAME subject, read in
     * row-major order (left-to-right within each row, top row first), meant
     * to be packed into a single horizontal animation strip and played back
     * frame-by-frame in the engine.
     *
     * Any rectangular layout is valid: 1×N (single row), 2×2, 2×3, etc.
     * The only constraint is `rows × cols === frameCount` with no empty cells.
     *
     * Strictly opt-in and fully backward-compatible: every existing brief
     * omits this field and behaves exactly as before. When enabled,
     * `generation.sheet` is cross-validated (see `superRefine` below) to
     * have exactly `frameCount` cells total — this reuses the content-aware
     * slicing machinery (`slice-sheet.ts`) instead of introducing a parallel
     * layout system.
     */
    frameSequence: z
      .object({
        enabled: z.boolean().default(false),
        /** Ordered pose-frame count. Target for a walk cycle: 3. */
        frameCount: z.number().int().min(2).max(8).default(3),
        /** Intended playback rate (frames per second) for the packed strip. */
        frameRate: z.number().positive().default(8),
        /** Whether playback should loop. */
        loop: z.boolean().default(true),
      })
      .strict()
      .default({ enabled: false, frameCount: 3, frameRate: 8, loop: true }),
  })
  .strict()
  .superRefine((brief, ctx) => {
    if (brief.anchor.x >= brief.size.width) {
      ctx.addIssue({
        code: 'custom',
        path: ['anchor', 'x'],
        message: `anchor.x (${brief.anchor.x}) must be < size.width (${brief.size.width})`,
      });
    }
    if (brief.anchor.y >= brief.size.height) {
      ctx.addIssue({
        code: 'custom',
        path: ['anchor', 'y'],
        message: `anchor.y (${brief.anchor.y}) must be < size.height (${brief.size.height})`,
      });
    }
    // Validate empty-cell coordinates fit inside the declared grid and are
    // unique. Duplicates would inflate `emptyCells.length`, making
    // `variantCount` (rows*cols - emptyCells.length) under-count the real cells
    // — corrupting the row-major variant indexing and the rerun grid-change
    // guard (see rerun.ts `sameEmptyCells`), which trusts `emptyCells` as a set.
    const { rows, cols, emptyCells } = brief.generation.sheet;
    const seenEmpty = new Set<string>();
    for (const [r, c] of emptyCells) {
      if (r >= rows || c >= cols) {
        ctx.addIssue({
          code: 'custom',
          path: ['generation', 'sheet', 'emptyCells'],
          message: `empty cell [${r}, ${c}] is outside the ${rows}x${cols} grid`,
        });
      }
      const key = `${r},${c}`;
      if (seenEmpty.has(key)) {
        ctx.addIssue({
          code: 'custom',
          path: ['generation', 'sheet', 'emptyCells'],
          message: `duplicate empty cell [${r}, ${c}]`,
        });
      }
      seenEmpty.add(key);
    }
    const variantCount = rows * cols - emptyCells.length;
    if (variantCount < 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['generation', 'sheet'],
        message: `grid produces ${variantCount} variants — must be at least 1`,
      });
    }
    // The slicer requires nativeCanvas to be evenly divisible by both rows
    // and cols so every cell is an integer pixel grid. We catch this at
    // brief-load time so we fail before a (slow, expensive) provider call.
    const { nativeCanvas } = brief.generation.sheet;
    if (nativeCanvas % rows !== 0 || nativeCanvas % cols !== 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['generation', 'sheet'],
        message: `nativeCanvas ${nativeCanvas} is not evenly divisible into a ${rows}x${cols} grid (cells would be ${nativeCanvas / cols}x${nativeCanvas / rows})`,
      });
    }
    // iconBatch mode: each cell is a DIFFERENT icon concept. The iconBatch
    // array length must match the total cell count (rows × cols − emptyCells).
    if (brief.iconBatch !== undefined) {
      const batchLen = brief.iconBatch.length;
      if (batchLen !== variantCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['iconBatch'],
          message: `iconBatch length (${batchLen}) must equal grid cell count (${variantCount})`,
        });
      }
      // Unique id guard — duplicate ids would stomp each other's manifest entry.
      const seenIds = new Set<string>();
      for (const entry of brief.iconBatch) {
        if (seenIds.has(entry.id)) {
          ctx.addIssue({
            code: 'custom',
            path: ['iconBatch'],
            message: `duplicate iconBatch id: "${entry.id}"`,
          });
        }
        seenIds.add(entry.id);
      }
    }
    // frameSequence mode: the grid cells are ordered animation frames, so
    // rows × cols must equal frameCount and every cell must be a required frame.
    // Any rectangular layout (1×N, 2×2, 2×3, etc.) is valid — the content-aware
    // slicer reads cells in row-major order, matching the animation frame order.
    if (brief.frameSequence.enabled) {
      const { frameCount } = brief.frameSequence;
      const totalCells = rows * cols;
      if (totalCells !== frameCount) {
        ctx.addIssue({
          code: 'custom',
          path: ['generation', 'sheet'],
          message: `frameSequence.enabled requires generation.sheet.rows × cols === frameSequence.frameCount (${frameCount}), got ${rows}×${cols} = ${totalCells}`,
        });
      }
      if (emptyCells.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['generation', 'sheet', 'emptyCells'],
          message: `frameSequence.enabled requires no empty cells — every cell is a required ordered frame`,
        });
      }
    }
  });

export type Brief = z.infer<typeof briefSchema>;
export type BriefTheme = NonNullable<Brief['theme']>;
// SpriteType inferred via Brief['type']; no separate alias needed yet.
export type RgbTriple = readonly [number, number, number];
export type PaletteColors = readonly RgbTriple[];

/**
 * Minimal on-disk brief shape — what authors actually write in YAML.
 *
 * The pipeline is intentionally split into two layers:
 *  - this `minimalBriefSchema` describes what a human writes in
 *    `briefs/<type>/<name>.yaml`: just enough to identify the sprite
 *    (`type` + `name`) and a free-form `description` of what it should
 *    look like.
 *  - `briefSchema` (above) describes what the downstream pipeline
 *    consumes after per-type defaults are merged in.
 *
 * Any field on the full `briefSchema` may be overridden inline on a
 * minimal brief — overrides are deep-merged on top of the per-type
 * defaults loaded from `data/sprite-types/<type>.json`. We do NOT
 * validate the override fields here; the merged result is what gets
 * Zod-validated, so authors get a single coherent error message instead
 * of two layers of complaints.
 */
export const minimalBriefSchema = z
  .object({
    type: z.enum(SPRITE_TYPES),
    mobRole: z.enum(['normal', 'elite', 'boss']).optional(),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be lowercase kebab-case'),
    theme: briefThemeSchema.optional(),
    description: z.string().trim().min(1).optional(),
    // Optional size-variant directive. Scales the per-type defaults
    // (size / anchor / native canvas) at load time so a brief can be wide,
    // tall, or large without restating geometry. Consumed and stripped during
    // the merge into defaults; the strict `briefSchema` never sees it.
    sizeVariant: z.enum(SIZE_VARIANTS).optional(),
    // Legacy/fully-specified briefs may set `prompt` directly instead of
    // `description`. We accept it here as a typed passthrough so the
    // superRefine below can require one of the two without tripping on
    // `.passthrough()` losing the field's type.
    prompt: z.string().trim().min(1).optional(),
    floor: z.number().int().min(DEFAULT_FLOOR).max(MAX_FLOOR).default(DEFAULT_FLOOR),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    // The merged brief needs *some* prompt text — either authored as a
    // minimal `description` (which the loader maps to `prompt`) or as an
    // explicit legacy `prompt`. Enforce that here so authors get one
    // clear error at the minimal layer instead of a less actionable
    // "prompt required" error after the merge.
    if (!data.description && !data.prompt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['description'],
        message: 'a brief must provide either `description` or `prompt`',
      });
    }
  });

export type MinimalBrief = z.infer<typeof minimalBriefSchema>;

/**
 * Per-type defaults loaded from `data/sprite-types/<type>.json`. The
 * shape is intentionally `unknown` here — we let the deep merge run and
 * then `briefSchema` validates the final object. This keeps the
 * defaults file authoring loose (you can omit any field) while still
 * giving authors a single, helpful validation pass on the merged brief.
 */
export type SpriteTypeDefaults = Record<string, unknown>;

/**
 * Variant count produced by a brief's sheet config. Pure derivation; exported
 * because slicer and prompt builder both need it.
 */
export function variantCount(brief: Brief): number {
  const { rows, cols, emptyCells } = brief.generation.sheet;
  return rows * cols - emptyCells.length;
}
