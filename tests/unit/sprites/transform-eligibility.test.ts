/**
 * Tests for `scripts/sprites/terrain-packs/transform-eligibility.ts` — the
 * directional-asymmetry seam-closure deriver/validator (2026-07-25
 * terrain-variance adversarial-review resolution #2).
 */
import { describe, expect, it } from 'vitest';
import {
  applyTransform,
  computeEdgeBandMeans,
  deriveAllowedTransforms,
  validateDeclaredTransforms,
  DIRECTIONAL_ASYMMETRY_THRESHOLD,
} from '../../../scripts/sprites/terrain-packs/transform-eligibility.js';
import {
  createImage,
  fillRect,
  type RgbaImage,
} from '../../../scripts/sprites/terrain-packs/png-buffer.js';

const SIZE = 64;

function uniformImage(gray: number): RgbaImage {
  const img = createImage(SIZE, SIZE);
  fillRect(img, 0, 0, SIZE, SIZE, gray, gray, gray, 255);
  return img;
}

/** A vertically-gradient image: dark at top, bright at bottom. */
function verticalGradientImage(): RgbaImage {
  const img = createImage(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    const gray = Math.round((y / (SIZE - 1)) * 255);
    fillRect(img, 0, y, SIZE, 1, gray, gray, gray, 255);
  }
  return img;
}

/** A horizontally-gradient image: dark at left, bright at right. */
function horizontalGradientImage(): RgbaImage {
  const img = createImage(SIZE, SIZE);
  for (let x = 0; x < SIZE; x++) {
    const gray = Math.round((x / (SIZE - 1)) * 255);
    fillRect(img, x, 0, 1, SIZE, gray, gray, gray, 255);
  }
  return img;
}

describe('computeEdgeBandMeans', () => {
  it('reports equal means on all 4 edges for a uniform image', () => {
    const means = computeEdgeBandMeans(uniformImage(128));
    expect(means.N).toBeCloseTo(128, 0);
    expect(means.E).toBeCloseTo(128, 0);
    expect(means.S).toBeCloseTo(128, 0);
    expect(means.W).toBeCloseTo(128, 0);
  });

  it('reports a large N/S difference for a vertical gradient', () => {
    const means = computeEdgeBandMeans(verticalGradientImage());
    expect(Math.abs(means.N - means.S)).toBeGreaterThan(DIRECTIONAL_ASYMMETRY_THRESHOLD * 2);
    // Horizontal edges should still be close to each other (no horizontal gradient).
    expect(Math.abs(means.E - means.W)).toBeLessThan(5);
  });

  it('reports a large E/W difference for a horizontal gradient', () => {
    const means = computeEdgeBandMeans(horizontalGradientImage());
    expect(Math.abs(means.E - means.W)).toBeGreaterThan(DIRECTIONAL_ASYMMETRY_THRESHOLD * 2);
    expect(Math.abs(means.N - means.S)).toBeLessThan(5);
  });
});

describe('deriveAllowedTransforms', () => {
  it('allows all 4 transforms for a uniform (non-directional) image', () => {
    const allowed = deriveAllowedTransforms(uniformImage(100));
    expect(allowed).toEqual(['none', 'flipV', 'flipH', 'flipHV']);
  });

  it('restricts flipV and flipHV (but keeps flipH) for a vertical-gradient image', () => {
    const allowed = deriveAllowedTransforms(verticalGradientImage());
    expect(allowed).toContain('none');
    expect(allowed).toContain('flipH');
    expect(allowed).not.toContain('flipV');
    expect(allowed).not.toContain('flipHV');
  });

  it('restricts flipH and flipHV (but keeps flipV) for a horizontal-gradient image', () => {
    const allowed = deriveAllowedTransforms(horizontalGradientImage());
    expect(allowed).toContain('none');
    expect(allowed).toContain('flipV');
    expect(allowed).not.toContain('flipH');
    expect(allowed).not.toContain('flipHV');
  });

  it('always includes "none" regardless of directionality', () => {
    expect(deriveAllowedTransforms(uniformImage(0))).toContain('none');
    expect(deriveAllowedTransforms(verticalGradientImage())).toContain('none');
  });

  it('is a pure function: same pixels always yield the same result', () => {
    const img = verticalGradientImage();
    expect(deriveAllowedTransforms(img)).toEqual(deriveAllowedTransforms(img));
  });
});

describe('applyTransform', () => {
  it('"none" returns a copy with identical pixels (not the same reference)', () => {
    const img = verticalGradientImage();
    const out = applyTransform(img, 'none');
    expect(out).not.toBe(img);
    expect(Buffer.from(out.data)).toEqual(Buffer.from(img.data));
  });

  it('flipV mirrors top/bottom: transformed top-edge mean equals original bottom-edge mean', () => {
    const img = verticalGradientImage();
    const flipped = applyTransform(img, 'flipV');
    const originalMeans = computeEdgeBandMeans(img);
    const flippedMeans = computeEdgeBandMeans(flipped);
    expect(flippedMeans.N).toBeCloseTo(originalMeans.S, 0);
    expect(flippedMeans.S).toBeCloseTo(originalMeans.N, 0);
  });

  it('flipH mirrors left/right: transformed west-edge mean equals original east-edge mean', () => {
    const img = horizontalGradientImage();
    const flipped = applyTransform(img, 'flipH');
    const originalMeans = computeEdgeBandMeans(img);
    const flippedMeans = computeEdgeBandMeans(flipped);
    expect(flippedMeans.W).toBeCloseTo(originalMeans.E, 0);
    expect(flippedMeans.E).toBeCloseTo(originalMeans.W, 0);
  });

  it('flipHV is equivalent to flipV then flipH (both axes mirrored)', () => {
    const img = verticalGradientImage();
    const direct = applyTransform(img, 'flipHV');
    const sequential = applyTransform(applyTransform(img, 'flipV'), 'flipH');
    expect(Buffer.from(direct.data)).toEqual(Buffer.from(sequential.data));
  });

  it('applying a transform twice (flipV, flipV) restores the original pixels', () => {
    const img = verticalGradientImage();
    const roundTrip = applyTransform(applyTransform(img, 'flipV'), 'flipV');
    expect(Buffer.from(roundTrip.data)).toEqual(Buffer.from(img.data));
  });
});

describe('validateDeclaredTransforms — the "seam closure" gate', () => {
  it('reports no issues when every declared transform is derived-safe', () => {
    const img = uniformImage(100);
    const issues = validateDeclaredTransforms(img, ['none', 'flipH', 'flipV', 'flipHV'], 'test');
    expect(issues).toEqual([]);
  });

  it('flags a declared transform NOT backed by the pixels (directionally unsafe)', () => {
    const img = verticalGradientImage();
    const issues = validateDeclaredTransforms(img, ['none', 'flipV'], 'floorPool[gradient]');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.code).toBe('transform-unsafe');
    expect(issues[0]!.message).toContain('floorPool[gradient]');
  });

  it('flags an unrecognized transform id', () => {
    const img = uniformImage(50);
    const issues = validateDeclaredTransforms(
      img,
      // @ts-expect-error deliberately invalid for this test
      ['none', 'rotate90'],
      'test',
    );
    expect(issues.some((i) => i.code === 'transform-unknown')).toBe(true);
  });
});
