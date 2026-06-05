import { z } from 'zod';

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

export const SPRITE_TYPES = ['weapon', 'enemy', 'item', 'tile', 'vfx', 'character'] as const;

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
 * 4-ways yields 256x256 cells, which downscale cleanly by an integer factor
 * to 64x64, 32x32, and 16x16 pixel sprites; 16 variants per call gives the
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
  })
  .strict()
  .default({});

export const briefSchema = z
  .object({
    type: z.enum(SPRITE_TYPES),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'name must be lowercase kebab-case'),
    size: sizeSchema,
    palette: paletteSchema,
    anchor: anchorSchema,
    tags: z.array(z.string().min(1)).default([]),
    prompt: z.string().min(1),
    references: z
      .array(referenceSchema)
      .min(2, 'references must contain at least 2 entries (F2.3)'),
    generation: generationSchema,
    sensors: sensorOverridesSchema,
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
    // Validate empty-cell coordinates fit inside the declared grid.
    const { rows, cols, emptyCells } = brief.generation.sheet;
    for (const [r, c] of emptyCells) {
      if (r >= rows || c >= cols) {
        ctx.addIssue({
          code: 'custom',
          path: ['generation', 'sheet', 'emptyCells'],
          message: `empty cell [${r}, ${c}] is outside the ${rows}x${cols} grid`,
        });
      }
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
  });

export type Brief = z.infer<typeof briefSchema>;
// SpriteType inferred via Brief['type']; no separate alias needed yet.
export type RgbTriple = readonly [number, number, number];
export type PaletteColors = readonly RgbTriple[];

/**
 * Variant count produced by a brief's sheet config. Pure derivation; exported
 * because slicer and prompt builder both need it.
 */
export function variantCount(brief: Brief): number {
  const { rows, cols, emptyCells } = brief.generation.sheet;
  return rows * cols - emptyCells.length;
}
