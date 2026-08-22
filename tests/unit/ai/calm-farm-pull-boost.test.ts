/**
 * Calm-clock farm boost — issue #3275 item 2.
 *
 * The collapse-panic profile already scales the opportunistic loot/enemy pulls
 * *down* as the deadline approaches. `resolveCalmFarmPullBoost` is the missing
 * other half: while the clock is applying no pressure at all, a confident run
 * leans harder into loot and XP on its way to an objective.
 *
 * The safety property under test is that the boost is strictly one-sided — it
 * must be inactive the moment panic exists, so extra farming can never eat into
 * the exit margin the panic ramp is protecting.
 */

import { describe, expect, it } from 'vitest';
import { resolveCalmFarmPullBoost } from '../../../src/game/ai/bt-ai-provider.js';

const CALM = { panic: 0, beeline: false };

describe('resolveCalmFarmPullBoost', () => {
  it('applies the configured boost while the clock is quiet', () => {
    expect(resolveCalmFarmPullBoost(CALM, 1.35)).toBe(1.35);
  });

  it('is off the instant the panic ramp starts', () => {
    expect(resolveCalmFarmPullBoost({ panic: 0.01, beeline: false }, 1.35)).toBe(1);
    expect(resolveCalmFarmPullBoost({ panic: 1, beeline: false }, 1.35)).toBe(1);
  });

  it('is off during the exit beeline even at zero panic', () => {
    expect(resolveCalmFarmPullBoost({ panic: 0, beeline: true }, 1.35)).toBe(1);
  });

  it('treats a missing, non-finite, or non-boosting value as no boost', () => {
    expect(resolveCalmFarmPullBoost(CALM, undefined)).toBe(1);
    expect(resolveCalmFarmPullBoost(CALM, Number.NaN)).toBe(1);
    expect(resolveCalmFarmPullBoost(CALM, Number.POSITIVE_INFINITY)).toBe(1);
    expect(resolveCalmFarmPullBoost(CALM, 1)).toBe(1);
  });

  it('never scales the pulls down — a cohort opts out, it cannot opt below 1', () => {
    expect(resolveCalmFarmPullBoost(CALM, 0)).toBe(1);
    expect(resolveCalmFarmPullBoost(CALM, -5)).toBe(1);
    expect(resolveCalmFarmPullBoost(CALM, 0.5)).toBe(1);
  });
});
