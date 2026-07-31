/**
 * Unit tests for the size-variant transform.
 *
 * The module is pure: given per-type defaults and a variant it returns a
 * scaled copy. We assert the multipliers, the immutability contract, the
 * anchor-stays-valid invariant, the grid reshape, and the coercion/validation
 * helper.
 */

import { describe, expect, it } from 'vitest';
import {
  applySizeVariantToDefaults,
  coerceSizeVariant,
  DEFAULT_SIZE_VARIANT,
  isSizeVariant,
  SIZE_VARIANTS,
  SIZE_VARIANT_MULTIPLIERS,
  resizeSpriteStrategy,
} from '../../../scripts/sprites/size-variants.js';

function enemyDefaults(): Record<string, unknown> {
  return {
    size: { width: 64, height: 64 },
    anchor: { x: 32, y: 32 },
    palette: { id: 'kenney-roguelike' },
    generation: { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
  };
}

type Dim = { width: number; height: number };
type Anchor = { x: number; y: number };
type Sheet = { rows: number; cols: number; nativeCanvas: number };
const sheetOf = (v: unknown): Sheet => (v as { sheet: Sheet }).sheet;

describe('SIZE_VARIANTS / multipliers', () => {
  it('exposes the four expected variants', () => {
    expect(SIZE_VARIANTS).toEqual(['default', 'wide', 'tall', 'large']);
  });

  describe('resizeSpriteStrategy', () => {
    it('stretches tiles to their exact frame so postprocess cannot letterbox them', () => {
      expect(resizeSpriteStrategy('tile', 256, 256)).toBe('stretch');
      expect(resizeSpriteStrategy('tile', 256, 128)).toBe('stretch');
    });

    it('selects fit for frame-sequence briefs regardless of shape, overriding the cover branch', () => {
      // A 256×256 frame-sequence cell: without the override this would be 'cover'
      // (width === height && width >= 128), producing oversized output (the 256×434 defect).
      expect(resizeSpriteStrategy('enemy', 256, 256, true)).toBe('fit');
      expect(resizeSpriteStrategy('enemy', 512, 512, true)).toBe('fit');
      // Confirm the override actually matters — same size without frameSequence is 'cover'
      expect(resizeSpriteStrategy('enemy', 256, 256, false)).toBe('cover');
      expect(resizeSpriteStrategy('enemy', 256, 256)).toBe('cover');
    });
  });

  it('maps each variant to the documented width/height multipliers', () => {
    expect(SIZE_VARIANT_MULTIPLIERS.default).toEqual({ width: 1, height: 1 });
    expect(SIZE_VARIANT_MULTIPLIERS.wide).toEqual({ width: 2, height: 1 });
    expect(SIZE_VARIANT_MULTIPLIERS.tall).toEqual({ width: 1, height: 2 });
    expect(SIZE_VARIANT_MULTIPLIERS.large).toEqual({ width: 2, height: 2 });
  });
});

describe('coerceSizeVariant', () => {
  it('treats undefined/null as the default variant', () => {
    expect(coerceSizeVariant(undefined)).toBe(DEFAULT_SIZE_VARIANT);
    expect(coerceSizeVariant(null)).toBe('default');
  });

  it('passes through every known variant', () => {
    for (const v of SIZE_VARIANTS) {
      expect(coerceSizeVariant(v)).toBe(v);
    }
  });

  it('throws a clear error on an unknown value', () => {
    expect(() => coerceSizeVariant('huge')).toThrow(/Invalid sizeVariant 'huge'/);
    expect(() => coerceSizeVariant(2)).toThrow(/Expected one of/);
  });
});

describe('isSizeVariant', () => {
  it('narrows known strings and rejects everything else', () => {
    expect(isSizeVariant('wide')).toBe(true);
    expect(isSizeVariant('huge')).toBe(false);
    expect(isSizeVariant(undefined)).toBe(false);
    expect(isSizeVariant(7)).toBe(false);
  });
});

describe('applySizeVariantToDefaults', () => {
  it('returns the input unchanged for the default variant', () => {
    const defaults = enemyDefaults();
    const out = applySizeVariantToDefaults(defaults, 'default');
    expect(out).toBe(defaults);
  });

  it('doubles width and reshapes the grid to 4 rows × 2 cols for wide', () => {
    const out = applySizeVariantToDefaults(enemyDefaults(), 'wide');
    expect(out.size).toEqual({ width: 128, height: 64 });
    expect(out.anchor).toEqual({ x: 64, y: 32 });
    // Grid reshapes (cols ÷2) to 8 aspect-matched cells; canvas is NOT inflated.
    expect(sheetOf(out.generation)).toMatchObject({ rows: 4, cols: 2, nativeCanvas: 1024 });
  });

  it('doubles height and reshapes the grid to 2 rows × 4 cols for tall', () => {
    const out = applySizeVariantToDefaults(enemyDefaults(), 'tall');
    expect(out.size).toEqual({ width: 64, height: 128 });
    expect(out.anchor).toEqual({ x: 32, y: 64 });
    expect(sheetOf(out.generation)).toMatchObject({ rows: 2, cols: 4, nativeCanvas: 1024 });
  });

  it('doubles both axes and reshapes to a 2×2 grid for large', () => {
    const out = applySizeVariantToDefaults(enemyDefaults(), 'large');
    expect(out.size).toEqual({ width: 128, height: 128 });
    expect(out.anchor).toEqual({ x: 64, y: 64 });
    expect(sheetOf(out.generation)).toMatchObject({ rows: 2, cols: 2, nativeCanvas: 1024 });
  });

  it('preserves the anchor < size invariant after scaling', () => {
    // character defaults sit one pixel below the floor (anchor.y 63 in 64).
    const character = {
      size: { width: 64, height: 64 },
      anchor: { x: 32, y: 63 },
      generation: { sheet: { rows: 4, cols: 4, emptyCells: [], nativeCanvas: 1024 } },
    };
    const tall = applySizeVariantToDefaults(character, 'tall');
    expect((tall.anchor as Anchor).y).toBeLessThan((tall.size as Dim).height);
    expect(tall.anchor).toEqual({ x: 32, y: 126 });
    expect(tall.size).toEqual({ width: 64, height: 128 });
  });

  it('reshapes from a base of 4 when the defaults omit rows/cols', () => {
    const partial = {
      size: { width: 64, height: 64 },
      anchor: { x: 32, y: 32 },
      generation: { sheet: { emptyCells: [], nativeCanvas: 1024 } },
    };
    const out = applySizeVariantToDefaults(partial, 'wide');
    // Absent rows/cols fall back to the schema default of 4 before reshaping.
    expect(sheetOf(out.generation)).toMatchObject({ rows: 4, cols: 2, nativeCanvas: 1024 });
  });

  it('does not mutate the input defaults', () => {
    const defaults = enemyDefaults();
    const snapshot = JSON.parse(JSON.stringify(defaults));
    applySizeVariantToDefaults(defaults, 'large');
    expect(defaults).toEqual(snapshot);
  });

  it('no-ops gracefully when size/anchor/generation are absent', () => {
    const out = applySizeVariantToDefaults({ palette: { id: 'x' } }, 'wide');
    expect(out).toEqual({ palette: { id: 'x' } });
  });

  it('leaves non-numeric geometry fields untouched', () => {
    const weird = { size: { width: 'oops', height: 64 }, anchor: { x: 32, y: 32 } };
    const out = applySizeVariantToDefaults(weird, 'wide');
    expect((out.size as { width: unknown }).width).toBe('oops');
    expect((out.size as { height: unknown }).height).toBe(64);
    expect((out.anchor as Anchor).x).toBe(64);
  });
});
