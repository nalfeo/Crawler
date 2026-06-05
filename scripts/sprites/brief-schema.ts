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
  });

export type Brief = z.infer<typeof briefSchema>;
// SpriteType inferred via Brief['type']; no separate alias needed yet.
export type RgbTriple = readonly [number, number, number];
export type PaletteColors = readonly RgbTriple[];
