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
export declare const SPRITE_TYPES: readonly ['weapon', 'enemy', 'item', 'tile', 'vfx', 'character'];
export declare const briefSchema: z.ZodObject<
  {
    type: z.ZodEnum<{
      enemy: 'enemy';
      item: 'item';
      weapon: 'weapon';
      tile: 'tile';
      vfx: 'vfx';
      character: 'character';
    }>;
    name: z.ZodString;
    size: z.ZodObject<
      {
        width: z.ZodNumber;
        height: z.ZodNumber;
      },
      z.core.$strict
    >;
    palette: z.ZodObject<
      {
        id: z.ZodString;
        colors: z.ZodOptional<
          z.ZodArray<z.ZodTuple<[z.ZodNumber, z.ZodNumber, z.ZodNumber], null>>
        >;
      },
      z.core.$strict
    >;
    anchor: z.ZodObject<
      {
        x: z.ZodNumber;
        y: z.ZodNumber;
      },
      z.core.$strict
    >;
    tags: z.ZodDefault<z.ZodArray<z.ZodString>>;
    prompt: z.ZodString;
    references: z.ZodArray<
      z.ZodObject<
        {
          path: z.ZodString;
          note: z.ZodOptional<z.ZodString>;
        },
        z.core.$strict
      >
    >;
    generation: z.ZodDefault<
      z.ZodObject<
        {
          sheet: z.ZodDefault<
            z.ZodObject<
              {
                rows: z.ZodDefault<z.ZodNumber>;
                cols: z.ZodDefault<z.ZodNumber>;
                emptyCells: z.ZodDefault<z.ZodArray<z.ZodTuple<[z.ZodNumber, z.ZodNumber], null>>>;
                nativeCanvas: z.ZodDefault<z.ZodNumber>;
              },
              z.core.$strict
            >
          >;
        },
        z.core.$strict
      >
    >;
    sensors: z.ZodDefault<
      z.ZodObject<
        {
          opaqueRatio: z.ZodOptional<
            z.ZodObject<
              {
                min: z.ZodOptional<z.ZodNumber>;
                max: z.ZodOptional<z.ZodNumber>;
              },
              z.core.$strict
            >
          >;
          weapon: z.ZodOptional<
            z.ZodObject<
              {
                diagonalToleranceDeg: z.ZodOptional<z.ZodNumber>;
                orientation: z.ZodOptional<
                  z.ZodEnum<{
                    any: 'any';
                    diagonal: 'diagonal';
                    vertical: 'vertical';
                    horizontal: 'horizontal';
                  }>
                >;
              },
              z.core.$strict
            >
          >;
          edge: z.ZodOptional<
            z.ZodObject<
              {
                allowMainTouch: z.ZodDefault<z.ZodBoolean>;
                allowDetachedEdgeComponents: z.ZodDefault<z.ZodBoolean>;
                maxDetachedEdgePixels: z.ZodDefault<z.ZodNumber>;
              },
              z.core.$strict
            >
          >;
          enemy: z.ZodOptional<
            z.ZodObject<
              {
                facing: z.ZodDefault<
                  z.ZodEnum<{
                    any: 'any';
                    front: 'front';
                  }>
                >;
                toleranceDeg: z.ZodDefault<z.ZodNumber>;
              },
              z.core.$strict
            >
          >;
          anchor: z.ZodOptional<
            z.ZodObject<
              {
                derive: z.ZodDefault<z.ZodBoolean>;
                mode: z.ZodDefault<
                  z.ZodEnum<{
                    static: 'static';
                    grip: 'grip';
                    'center-of-mass': 'center-of-mass';
                  }>
                >;
                bandRows: z.ZodDefault<z.ZodNumber>;
                centerToleranceX: z.ZodDefault<z.ZodNumber>;
              },
              z.core.$strict
            >
          >;
        },
        z.core.$strict
      >
    >;
    variations: z.ZodDefault<z.ZodArray<z.ZodString>>;
    minVariations: z.ZodDefault<z.ZodNumber>;
    judge: z.ZodDefault<
      z.ZodObject<
        {
          enabled: z.ZodDefault<z.ZodBoolean>;
          maxVariants: z.ZodDefault<z.ZodNumber>;
        },
        z.core.$strict
      >
    >;
    postprocessing: z.ZodDefault<
      z.ZodObject<
        {
          trimAndFit: z.ZodDefault<z.ZodBoolean>;
          minDimension: z.ZodDefault<z.ZodNumber>;
          paletteMode: z.ZodDefault<
            z.ZodEnum<{
              none: 'none';
              strict: 'strict';
            }>
          >;
        },
        z.core.$strict
      >
    >;
  },
  z.core.$strict
>;
export type Brief = z.infer<typeof briefSchema>;
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
export declare const minimalBriefSchema: z.ZodObject<
  {
    type: z.ZodEnum<{
      enemy: 'enemy';
      item: 'item';
      weapon: 'weapon';
      tile: 'tile';
      vfx: 'vfx';
      character: 'character';
    }>;
    name: z.ZodString;
    description: z.ZodOptional<z.ZodString>;
    prompt: z.ZodOptional<z.ZodString>;
  },
  z.core.$loose
>;
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
export declare function variantCount(brief: Brief): number;
//# sourceMappingURL=brief-schema.d.ts.map
