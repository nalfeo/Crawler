import { describe, it, expect } from 'vitest';
import {
  stackKey,
  isValidSpec,
  computeEffectiveValue,
  computeEffectiveSpeed,
} from '../../src/core/status-effects.js';
import type { StatusEffect, StatusEffectSpec } from '../../src/shared/status-effect-types.js';

/**
 * Pure-math coverage for the status-effect helpers (no world, no ticking):
 * stack identity, spec validation, and the product-of-factors effective-value
 * math with clamps. Determinism is inherent — these are total functions of
 * their inputs.
 */

function spec(overrides: Partial<StatusEffectSpec> = {}): StatusEffectSpec {
  return {
    stat: 'speed',
    op: 'multiply',
    value: 0.5,
    durationMs: 1000,
    sourceType: 'trap',
    sourceId: 'chill',
    stackRule: { mode: 'replace' },
    ...overrides,
  };
}

/** A live effect from a spec (helper for the pure compute functions). */
function effect(overrides: Partial<StatusEffect> = {}): StatusEffect {
  const base = spec(overrides);
  return { ...base, remainingMs: overrides.remainingMs ?? base.durationMs ?? Infinity };
}

describe('stackKey', () => {
  it('is sourceType:sourceId:stat:op', () => {
    expect(stackKey(spec())).toBe('trap:chill:speed:multiply');
  });

  it('distinguishes effects differing in any of the four fields', () => {
    const base = spec();
    expect(stackKey(base)).not.toBe(stackKey(spec({ op: 'add' })));
    expect(stackKey(base)).not.toBe(stackKey(spec({ stat: 'hpRegen' })));
    expect(stackKey(base)).not.toBe(stackKey(spec({ sourceId: 'other' })));
    expect(stackKey(base)).not.toBe(stackKey(spec({ sourceType: 'aura' })));
  });
});

describe('isValidSpec', () => {
  it('accepts a well-formed timed spec and a persistent spec', () => {
    expect(isValidSpec(spec())).toBe(true);
    expect(isValidSpec(spec({ durationMs: null }))).toBe(true);
  });

  it('rejects non-finite values', () => {
    expect(isValidSpec(spec({ value: Number.NaN }))).toBe(false);
    expect(isValidSpec(spec({ value: Infinity }))).toBe(false);
  });

  it('rejects negative multiply factors but allows negative add deltas', () => {
    expect(isValidSpec(spec({ op: 'multiply', value: -0.5 }))).toBe(false);
    expect(isValidSpec(spec({ op: 'add', value: -25 }))).toBe(true);
  });

  it('rejects non-positive finite durations', () => {
    expect(isValidSpec(spec({ durationMs: 0 }))).toBe(false);
    expect(isValidSpec(spec({ durationMs: -100 }))).toBe(false);
  });

  it('rejects a non-finite duration (Infinity/NaN) — persistence is null only', () => {
    // Infinity would be a persistent effect masquerading as timed; only `null`
    // means persistent.
    expect(isValidSpec(spec({ durationMs: Infinity }))).toBe(false);
    expect(isValidSpec(spec({ durationMs: Number.NaN }))).toBe(false);
  });

  it('validates the stack cap: accepts a positive-integer maxStacks', () => {
    expect(isValidSpec(spec({ stackRule: { mode: 'stack', maxStacks: 1 } }))).toBe(true);
    expect(isValidSpec(spec({ stackRule: { mode: 'stack', maxStacks: 3 } }))).toBe(true);
  });

  it('rejects a stack rule with a non-positive, non-integer, or non-finite cap', () => {
    expect(isValidSpec(spec({ stackRule: { mode: 'stack', maxStacks: 0 } }))).toBe(false);
    expect(isValidSpec(spec({ stackRule: { mode: 'stack', maxStacks: -2 } }))).toBe(false);
    expect(isValidSpec(spec({ stackRule: { mode: 'stack', maxStacks: 2.5 } }))).toBe(false);
    expect(isValidSpec(spec({ stackRule: { mode: 'stack', maxStacks: Number.NaN } }))).toBe(false);
    expect(isValidSpec(spec({ stackRule: { mode: 'stack', maxStacks: Infinity } }))).toBe(false);
  });
});

describe('computeEffectiveValue (product-of-factors)', () => {
  it('worked example: (base + Σadd) * Π multiply', () => {
    // base 100, ×0.8, ×0.5, +20  =>  (100 + 20) * (0.8 * 0.5) = 120 * 0.4 = 48
    const effects: StatusEffect[] = [
      effect({ op: 'multiply', value: 0.8, sourceId: 'a' }),
      effect({ op: 'multiply', value: 0.5, sourceId: 'b' }),
      effect({ op: 'add', value: 20, sourceId: 'c' }),
    ];
    expect(computeEffectiveValue(100, effects, 'speed')).toBeCloseTo(48, 10);
  });

  it('returns the base unchanged when no effects match the stat', () => {
    const effects: StatusEffect[] = [effect({ stat: 'hpRegen', op: 'add', value: 5 })];
    expect(computeEffectiveValue(100, effects, 'speed')).toBe(100);
    expect(computeEffectiveValue(0, [], 'speed')).toBe(0);
  });

  it('only folds in effects whose stat matches', () => {
    const effects: StatusEffect[] = [
      effect({ stat: 'speed', op: 'multiply', value: 0.5 }),
      effect({ stat: 'hpRegen', op: 'add', value: 99 }),
    ];
    expect(computeEffectiveValue(100, effects, 'speed')).toBe(50);
    expect(computeEffectiveValue(0, effects, 'hpRegen')).toBe(99);
  });

  it('applies clamps inclusively', () => {
    const slow: StatusEffect[] = [effect({ op: 'multiply', value: 0.1 })];
    expect(computeEffectiveValue(100, slow, 'speed', { min: 20, max: 300 })).toBe(20);
    const fast: StatusEffect[] = [effect({ op: 'add', value: 1000 })];
    expect(computeEffectiveValue(100, fast, 'speed', { min: 0, max: 250 })).toBe(250);
  });
});

describe('computeEffectiveSpeed', () => {
  it('defaults to a [0, base*3] clamp', () => {
    const huge: StatusEffect[] = [effect({ op: 'add', value: 10_000 })];
    expect(computeEffectiveSpeed(100, huge)).toBe(300);
    const negating: StatusEffect[] = [effect({ op: 'add', value: -10_000 })];
    expect(computeEffectiveSpeed(100, negating)).toBe(0);
  });

  it('honours explicit clamp bounds (e.g. a future hate-ramp)', () => {
    const effects: StatusEffect[] = [effect({ op: 'add', value: 40 })];
    // base 60, +40 => 100, clamped to [baseSpeed=60, playerSpeed=90] => 90
    expect(computeEffectiveSpeed(60, effects, { min: 60, max: 90 })).toBe(90);
  });

  it('never produces a negative speed from multiplicative slows', () => {
    const slows: StatusEffect[] = [
      effect({ op: 'multiply', value: 0.2 }),
      effect({ op: 'multiply', value: 0.2 }),
    ];
    expect(computeEffectiveSpeed(100, slows)).toBeGreaterThanOrEqual(0);
  });
});
