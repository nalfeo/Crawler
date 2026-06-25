import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CORPSE_GREY,
  SKULL_BASE_ALPHA,
  SKULL_FADE_MS,
  SKULL_RISE_PX,
  computeCorpseDecay,
  corpseTint,
} from '../../src/engine/corpse-decay.js';

const NO_TINT = 0xffffff;

describe('corpseTint', () => {
  it('returns the identity tint at zero desaturation', () => {
    expect(corpseTint(0)).toBe(NO_TINT);
  });

  it('returns the full grey target at full desaturation', () => {
    expect(corpseTint(1)).toBe(CORPSE_GREY);
  });

  it('clamps out-of-range desaturation', () => {
    expect(corpseTint(-5)).toBe(NO_TINT);
    expect(corpseTint(5)).toBe(CORPSE_GREY);
  });

  it('lerps each channel halfway at 0.5', () => {
    // white (0xff) -> 0x9a / 0x9a / 0xa0
    expect(corpseTint(0.5)).toBe(0xcdcdd0);
  });
});

describe('computeCorpseDecay', () => {
  it('is fully opaque, full colour, and full skull at the instant of death', () => {
    const d = computeCorpseDecay(3000, 3000);
    expect(d.skullAlpha).toBeCloseTo(SKULL_BASE_ALPHA);
    expect(d.skullRisePx).toBe(0);
    expect(d.corpseAlpha).toBe(1);
    expect(d.desaturation).toBe(0);
    expect(d.tint).toBe(NO_TINT);
  });

  it('floats the skull up and half-fades it partway through the skull window', () => {
    // 450ms elapsed of a 900ms skull fade.
    const d = computeCorpseDecay(3000 - 450, 3000);
    expect(d.skullAlpha).toBeCloseTo(SKULL_BASE_ALPHA * 0.5);
    expect(d.skullRisePx).toBeCloseTo(SKULL_RISE_PX * 0.5);
  });

  it('fully removes the skull once its short window elapses, long before the corpse', () => {
    // SKULL_FADE_MS elapsed, but only 900/3000 of the corpse linger.
    const d = computeCorpseDecay(3000 - SKULL_FADE_MS, 3000);
    expect(d.skullAlpha).toBe(0);
    expect(d.skullRisePx).toBeCloseTo(SKULL_RISE_PX);
    // Corpse is still fully present, just partway desaturated.
    expect(d.corpseAlpha).toBe(1);
    expect(d.desaturation).toBeCloseTo(0.6);
  });

  it('reaches full grey by the desaturation-ramp midpoint while still opaque', () => {
    const d = computeCorpseDecay(1500, 3000); // half the linger elapsed
    expect(d.desaturation).toBe(1);
    expect(d.tint).toBe(CORPSE_GREY);
    expect(d.corpseAlpha).toBe(1); // fade hasn't started yet
    expect(d.skullAlpha).toBe(0); // skull long gone
  });

  it('fades the corpse out over the back half of the linger', () => {
    const d = computeCorpseDecay(750, 3000); // three-quarters elapsed
    expect(d.corpseAlpha).toBeCloseTo(0.5);
    expect(d.desaturation).toBe(1);
  });

  it('is fully gone the instant the timer expires', () => {
    const d = computeCorpseDecay(0, 3000);
    expect(d.skullAlpha).toBe(0);
    expect(d.corpseAlpha).toBe(0);
  });

  it('treats a non-positive total as a fully-elapsed corpse', () => {
    const d = computeCorpseDecay(500, 0);
    expect(d.skullAlpha).toBe(0);
    expect(d.corpseAlpha).toBe(0);
    expect(d.desaturation).toBe(1);
  });

  it('caps the skull fade to the linger on unusually short lingers', () => {
    // 400ms linger is shorter than the 900ms default skull fade; the skull
    // should still be fully gone by the time the corpse is removed.
    const atExpiry = computeCorpseDecay(0, 400);
    expect(atExpiry.skullAlpha).toBe(0);
    const halfway = computeCorpseDecay(200, 400);
    expect(halfway.skullAlpha).toBeCloseTo(SKULL_BASE_ALPHA * 0.5);
  });

  it('clamps when remaining exceeds the total', () => {
    const d = computeCorpseDecay(1500, 1000);
    expect(d.corpseAlpha).toBe(1);
    expect(d.skullAlpha).toBeCloseTo(SKULL_BASE_ALPHA);
    expect(d.tint).toBe(NO_TINT);
  });

  it('keeps all outputs in range for any remaining/total (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (totalMs, ratio) => {
          const d = computeCorpseDecay(totalMs * ratio, totalMs);
          expect(d.skullAlpha).toBeGreaterThanOrEqual(0);
          expect(d.skullAlpha).toBeLessThanOrEqual(SKULL_BASE_ALPHA);
          expect(d.skullRisePx).toBeGreaterThanOrEqual(0);
          expect(d.skullRisePx).toBeLessThanOrEqual(SKULL_RISE_PX);
          expect(d.corpseAlpha).toBeGreaterThanOrEqual(0);
          expect(d.corpseAlpha).toBeLessThanOrEqual(1);
          expect(d.desaturation).toBeGreaterThanOrEqual(0);
          expect(d.desaturation).toBeLessThanOrEqual(1);
          expect(d.tint).toBeGreaterThanOrEqual(0);
          expect(d.tint).toBeLessThanOrEqual(NO_TINT);
        },
      ),
    );
  });

  it('only ever decays — skull/corpse never brighten and never sink back down (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 60_000 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (totalMs, a, b) => {
          const earlier = Math.max(a, b) * totalMs; // more remaining = earlier
          const later = Math.min(a, b) * totalMs;
          const dEarlier = computeCorpseDecay(earlier, totalMs);
          const dLater = computeCorpseDecay(later, totalMs);
          expect(dLater.skullAlpha).toBeLessThanOrEqual(dEarlier.skullAlpha + 1e-9);
          expect(dLater.skullRisePx).toBeGreaterThanOrEqual(dEarlier.skullRisePx - 1e-9);
          expect(dLater.corpseAlpha).toBeLessThanOrEqual(dEarlier.corpseAlpha + 1e-9);
          expect(dLater.desaturation).toBeGreaterThanOrEqual(dEarlier.desaturation - 1e-9);
        },
      ),
    );
  });
});
