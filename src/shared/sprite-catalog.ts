import { z } from 'zod';

const sentenceSchema = z
  .string()
  .trim()
  .min(1, 'description is required')
  .refine((value) => !value.includes('\n'), 'description must be a single sentence line')
  .refine(
    (value) => /[.!?]$/.test(value),
    'description must end with sentence punctuation (., !, or ?)',
  );

const tagSchema = z.string().trim().min(1);

const tileMetadataSchema = z
  .object({
    connectsTo: z.array(z.string().trim().min(1)),
  })
  .strict();

const animationMetadataSchema = z
  .object({
    clips: z.array(z.string().trim().min(1)),
  })
  .strict();

const baseEntrySchema = z
  .object({
    id: z.string().trim().min(1),
    kind: z.enum(['sheet', 'sprite']),
    label: z.string().trim().min(1),
    description: sentenceSchema,
    tags: z.array(tagSchema).default([]),
  })
  .strict();

export const spriteSheetCatalogEntrySchema = baseEntrySchema
  .extend({
    kind: z.literal('sheet'),
    sheetKey: z.string().trim().min(1),
    path: z.string().trim().min(1),
    frameWidth: z.number().int().positive(),
    frameHeight: z.number().int().positive(),
    margin: z.number().int().min(0),
    spacing: z.number().int().min(0),
    cols: z.number().int().positive(),
  })
  .strict();

export const spriteCatalogEntrySchema = baseEntrySchema
  .extend({
    kind: z.literal('sprite'),
    spriteId: z.string().trim().min(1),
    sheetKey: z.string().trim().min(1),
    frame: z.number().int().min(0),
    col: z.number().int().min(0),
    row: z.number().int().min(0),
    note: z.string().trim().min(1).optional(),
    tile: tileMetadataSchema.optional(),
    animation: animationMetadataSchema.optional(),
  })
  .strict();

export const spriteCatalogEntryUnionSchema = z.discriminatedUnion('kind', [
  spriteSheetCatalogEntrySchema,
  spriteCatalogEntrySchema,
]);

export const spriteCatalogSchema = z.array(spriteCatalogEntryUnionSchema);

export type SpriteSheetCatalogEntry = z.infer<typeof spriteSheetCatalogEntrySchema>;
export type SpriteCatalogEntry = z.infer<typeof spriteCatalogEntrySchema>;
export type SpriteCatalogRecord = z.infer<typeof spriteCatalogEntryUnionSchema>;
export type SpriteCatalog = z.infer<typeof spriteCatalogSchema>;

export function ensureSentence(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '') {
    return 'Description pending.';
  }
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

export function parseSpriteCatalog(raw: unknown): SpriteCatalog {
  return spriteCatalogSchema.parse(raw);
}
