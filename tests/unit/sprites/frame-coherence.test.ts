import { describe, expect, it } from 'vitest';
import { PNG } from 'pngjs';
import {
  checkFrameCoherence,
  DEFAULT_MAX_BASELINE_DELTA_PX,
  DEFAULT_MAX_MASS_DELTA_RATIO,
  DEFAULT_MAX_PALETTE_DISTANCE,
} from '../../../scripts/sprites/sensors/frame-coherence.js';

const SIZE = 32;

/** Skin/outfit-like palette used by the "same character" fixtures. */
const BODY = [80, 60, 40] as const; // brown skin tone
const OUTFIT = [40, 90, 160] as const; // blue tunic

/** A totally different palette used by the deliberately-incoherent fixture. */
const OTHER_BODY = [230, 200, 60] as const; // bright yellow
const OTHER_OUTFIT = [200, 30, 30] as const; // red

/**
 * Builds a simple humanoid-ish silhouette: a torso block (outfit color) plus
 * a "leg" that shifts horizontally by `legOffset` pixels — simulating a walk
 * cycle's leg swing while keeping the rest of the silhouette identical.
 */
function buildFrame(opts: {
  body: readonly [number, number, number];
  outfit: readonly [number, number, number];
  legOffset: number;
  extraOpaquePixels?: number;
  verticalShift?: number;
}): Buffer {
  const png = new PNG({ width: SIZE, height: SIZE });
  const dy = opts.verticalShift ?? 0;
  const setPixel = (x: number, y: number, rgb: readonly [number, number, number]) => {
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    const idx = (y * SIZE + x) * 4;
    png.data[idx] = rgb[0];
    png.data[idx + 1] = rgb[1];
    png.data[idx + 2] = rgb[2];
    png.data[idx + 3] = 255;
  };
  // Head (body color).
  for (let y = 4 + dy; y < 10 + dy; y++) {
    for (let x = 12; x < 20; x++) setPixel(x, y, opts.body);
  }
  // Torso (outfit color).
  for (let y = 10 + dy; y < 20 + dy; y++) {
    for (let x = 10; x < 22; x++) setPixel(x, y, opts.outfit);
  }
  // Leg (body color), swings with legOffset.
  for (let y = 20 + dy; y < 28 + dy; y++) {
    for (let x = 14 + opts.legOffset; x < 18 + opts.legOffset; x++) setPixel(x, y, opts.body);
  }
  // Optional extra blob to simulate a stray/incoherent addition (e.g. a
  // dropped prop or an extra limb) without changing palette.
  if (opts.extraOpaquePixels) {
    let remaining = opts.extraOpaquePixels;
    for (let y = 0; y < SIZE && remaining > 0; y++) {
      for (let x = 0; x < SIZE && remaining > 0; x++) {
        if (png.data[(y * SIZE + x) * 4 + 3] === 255) continue;
        setPixel(x, y, opts.body);
        remaining -= 1;
      }
    }
  }
  return PNG.sync.write(png);
}

describe('checkFrameCoherence', () => {
  it('passes a coherent 3-frame walk cycle (same palette, small leg swing)', () => {
    const frames = [
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: -2 }),
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 0 }),
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 2 }),
    ];

    const result = checkFrameCoherence(frames);

    expect(result.ok).toBe(true);
    expect(result.pairs).toHaveLength(2);
    for (const pair of result.pairs) {
      expect(pair.ok).toBe(true);
      expect(pair.reasons).toEqual([]);
      expect(pair.paletteDistance).toBeLessThanOrEqual(DEFAULT_MAX_PALETTE_DISTANCE);
      expect(pair.massDeltaRatio).toBeLessThanOrEqual(DEFAULT_MAX_MASS_DELTA_RATIO);
    }
  });

  it('fails when a later frame swaps to a completely different palette', () => {
    const frames = [
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: -2 }),
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 0 }),
      // Frame 2 drifted to a different character/outfit entirely.
      buildFrame({ body: OTHER_BODY, outfit: OTHER_OUTFIT, legOffset: 2 }),
    ];

    const result = checkFrameCoherence(frames);

    expect(result.ok).toBe(false);
    expect(result.reason).toBeDefined();
    // Frame 0<->1 (both coherent) must still pass; only the drifted pair fails.
    expect(result.pairs[0]!.ok).toBe(true);
    expect(result.pairs[1]!.ok).toBe(false);
    expect(result.pairs[1]!.paletteDistance).toBeGreaterThan(DEFAULT_MAX_PALETTE_DISTANCE);
  });

  it('fails when a frame has a wildly different silhouette mass', () => {
    const frames = [
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 0 }),
      // Same palette, but a large stray blob roughly triples opaque pixel count.
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 0, extraOpaquePixels: 400 }),
    ];

    const result = checkFrameCoherence(frames);

    expect(result.ok).toBe(false);
    expect(result.pairs[0]!.massDeltaRatio).toBeGreaterThan(DEFAULT_MAX_MASS_DELTA_RATIO);
  });

  it('fails when a later frame bobs vertically off the shared floor line', () => {
    const frames = [
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: -2 }),
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 0 }),
      // Same palette and mass, but the whole character floats upward —
      // the "same floor line" prompt instruction was ignored.
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 2, verticalShift: -8 }),
    ];

    const result = checkFrameCoherence(frames);

    expect(result.ok).toBe(false);
    expect(result.pairs[0]!.ok).toBe(true);
    expect(result.pairs[1]!.ok).toBe(false);
    expect(result.pairs[1]!.baselineDeltaPx).toBeGreaterThan(DEFAULT_MAX_BASELINE_DELTA_PX);
    expect(result.pairs[1]!.reasons.join(' ')).toMatch(/baseline/);
  });

  it('respects custom thresholds passed via options', () => {
    const frames = [
      buildFrame({ body: BODY, outfit: OUTFIT, legOffset: -2 }),
      buildFrame({ body: OTHER_BODY, outfit: OTHER_OUTFIT, legOffset: 0 }),
    ];

    // Wide open thresholds: even a full palette swap passes.
    const lenient = checkFrameCoherence(frames, {
      maxPaletteDistance: 1,
      maxMassDeltaRatio: 1,
    });
    expect(lenient.ok).toBe(true);

    // Zero tolerance: verify the knob is actually wired through by requiring
    // an exact palette match, which this drifted pair can't satisfy.
    const strict = checkFrameCoherence(frames, {
      maxPaletteDistance: 0,
      maxMassDeltaRatio: 1,
    });
    expect(strict.ok).toBe(false);
  });

  it('reports zero mass delta ratio (not 100%) for two fully-transparent frames (multi-model review finding, gemini-3.1-pro)', () => {
    const empty = new PNG({ width: SIZE, height: SIZE });
    const frames = [PNG.sync.write(empty), PNG.sync.write(empty)];

    const result = checkFrameCoherence(frames);

    // Two empty frames are identical on mass (0 vs 0) — the math must not
    // report a bogus 100% delta ratio just because `Math.max(0, 0, 1)`
    // forces a nonzero denominator. The pair still fails overall because
    // the baseline signal independently flags a frame with no opaque
    // pixels as a severe drift (infinite floor-line delta).
    expect(result.pairs[0]!.massDeltaRatio).toBe(0);
    expect(result.ok).toBe(false);
    expect(result.pairs[0]!.reasons.join(' ')).toMatch(/baseline/);
  });

  it('trivially passes with fewer than 2 frames', () => {
    expect(checkFrameCoherence([]).ok).toBe(true);
    expect(checkFrameCoherence([buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 0 })]).ok).toBe(
      true,
    );
  });

  describe('loop seam (final→first pair)', () => {
    it('does NOT check loop seam without loop:true', () => {
      // Without loop:true, a drifted final→first seam is not caught.
      const frames = [
        buildFrame({ body: BODY, outfit: OUTFIT, legOffset: -2 }),
        buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 0 }),
        // Last frame drifts drastically — only caught when loop:true.
        buildFrame({ body: OTHER_BODY, outfit: OTHER_OUTFIT, legOffset: 2 }),
      ];
      const result = checkFrameCoherence(frames);
      // Interior pairs 0→1 pass; 1→2 fails. But we still only check N-1 pairs.
      expect(result.pairs).toHaveLength(2);
    });

    it('fails a looping sequence whose final→first seam has a drifted palette', () => {
      // Frames 0 and 1 are coherent; frame 2 (the last) has a completely
      // different palette. Without loop:true, only pairs 0→1 and 1→2 are
      // checked and 1→2 would fail anyway. With loop:true, the extra pair
      // 2→0 is also checked and must independently reflect the seam drift.
      const frames = [
        buildFrame({ body: BODY, outfit: OUTFIT, legOffset: -2 }),
        buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 0 }),
        buildFrame({ body: OTHER_BODY, outfit: OTHER_OUTFIT, legOffset: 2 }),
      ];
      const result = checkFrameCoherence(frames, { loop: true });
      expect(result.pairs).toHaveLength(3); // includes the loop seam
      const loopSeamPair = result.pairs.find((p) => p.frameA === 2 && p.frameB === 0);
      expect(loopSeamPair).toBeDefined();
      expect(loopSeamPair!.ok).toBe(false);
    });

    it('catches a seam that would drift past thresholds only at the loop boundary', () => {
      // All interior consecutive pairs are coherent. Only frame2→frame0
      // has a large vertical shift (loop seam). Without loop:true this
      // passes; with loop:true it is rejected.
      const coherentBase = { body: BODY, outfit: OUTFIT } as const;
      const frames = [
        buildFrame({ ...coherentBase, legOffset: -2 }), // frame 0 — normal
        buildFrame({ ...coherentBase, legOffset: 0 }), // frame 1 — normal
        buildFrame({ ...coherentBase, legOffset: 2, verticalShift: -10 }), // frame 2 — shifted up
      ];

      const noLoop = checkFrameCoherence(frames, { loop: false });
      // frame 1→2 fails because of the vertical shift
      expect(noLoop.pairs).toHaveLength(2);

      const withLoop = checkFrameCoherence(frames, { loop: true });
      // Adds the seam pair (frame2→frame0), both 1→2 and 2→0 fail
      expect(withLoop.pairs).toHaveLength(3);
      const seamPair = withLoop.pairs.find((p) => p.frameA === 2 && p.frameB === 0);
      expect(seamPair).toBeDefined();
      // The seam compares the vertically shifted frame 2 against the normal
      // frame 0 — the baseline delta must be ≥ the vertical shift amount.
      expect(seamPair!.baselineDeltaPx).toBeGreaterThan(DEFAULT_MAX_BASELINE_DELTA_PX);
    });

    it('passes a coherent looping cycle including the loop seam', () => {
      const frames = [
        buildFrame({ body: BODY, outfit: OUTFIT, legOffset: -2 }),
        buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 0 }),
        buildFrame({ body: BODY, outfit: OUTFIT, legOffset: 2 }),
      ];
      const result = checkFrameCoherence(frames, { loop: true });
      expect(result.pairs).toHaveLength(3); // 0→1, 1→2, 2→0
      expect(result.ok).toBe(true);
      const seamPair = result.pairs.find((p) => p.frameA === 2 && p.frameB === 0);
      expect(seamPair).toBeDefined();
      expect(seamPair!.ok).toBe(true);
    });
  });
});
