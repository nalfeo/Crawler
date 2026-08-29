/**
 * Status-effect presentation policy (`src/engine/status-effect-visuals.ts`).
 *
 * Pure resolver: live effects → one visual treatment. Determinism matters here
 * because the treatment must not depend on the order effects were applied in.
 */
import { describe, expect, it } from 'vitest';
import {
  hasActiveSpeedStatus,
  resolveStatusVisual,
} from '../../src/engine/status-effect-visuals.js';
import type { StatusEffect } from '../../src/shared/status-effect-types.js';

function effect(partial: Partial<StatusEffect> & Pick<StatusEffect, 'stat' | 'op' | 'value'>) {
  return {
    durationMs: 1_000,
    remainingMs: 1_000,
    sourceType: 'ability',
    sourceId: 'test',
    stackRule: { mode: 'replace' },
    ...partial,
  } as StatusEffect;
}

describe('resolveStatusVisual', () => {
  it('returns null when there are no effects', () => {
    expect(resolveStatusVisual([])).toBeNull();
  });

  it('reads a multiplicative speed reduction as a slow', () => {
    const visual = resolveStatusVisual([effect({ stat: 'speed', op: 'multiply', value: 0.4 })]);
    expect(visual?.kind).toBe('slow');
    // The icy tint the speed-status treatment shipped with, preserved verbatim.
    expect(visual?.tint).toBe(0xaadfff);
  });

  it('reads a speed increase as haste, not a slow', () => {
    expect(resolveStatusVisual([effect({ stat: 'speed', op: 'multiply', value: 1.3 })])?.kind).toBe(
      'haste',
    );
    expect(resolveStatusVisual([effect({ stat: 'speed', op: 'add', value: 2 })])?.kind).toBe(
      'haste',
    );
  });

  it('derives polarity from op and value for attackSpeed', () => {
    expect(
      resolveStatusVisual([effect({ stat: 'attackSpeed', op: 'multiply', value: 0.75 })])?.kind,
    ).toBe('weakened');
    expect(
      resolveStatusVisual([effect({ stat: 'attackSpeed', op: 'multiply', value: 1.25 })])?.kind,
    ).toBe('empowered');
  });

  it('reads additive hpRegen as regen or wither by sign', () => {
    expect(resolveStatusVisual([effect({ stat: 'hpRegen', op: 'add', value: 3 })])?.kind).toBe(
      'regen',
    );
    expect(resolveStatusVisual([effect({ stat: 'hpRegen', op: 'add', value: -3 })])?.kind).toBe(
      'wither',
    );
  });

  it('ignores no-op effects (add 0, multiply 1, multiply-only hpRegen)', () => {
    expect(resolveStatusVisual([effect({ stat: 'speed', op: 'add', value: 0 })])).toBeNull();
    expect(resolveStatusVisual([effect({ stat: 'speed', op: 'multiply', value: 1 })])).toBeNull();
    expect(
      resolveStatusVisual([effect({ stat: 'hpRegen', op: 'multiply', value: 0.5 })]),
    ).toBeNull();
  });

  it('ignores expired effects', () => {
    expect(
      resolveStatusVisual([effect({ stat: 'speed', op: 'multiply', value: 0.4, remainingMs: 0 })]),
    ).toBeNull();
  });

  it('keeps persistent (Infinity) effects visible', () => {
    expect(
      resolveStatusVisual([
        effect({
          stat: 'speed',
          op: 'multiply',
          value: 0.4,
          durationMs: null,
          remainingMs: Infinity,
        }),
      ])?.kind,
    ).toBe('slow');
  });

  it('prefers the debuff and is independent of application order', () => {
    const slow = effect({ stat: 'speed', op: 'multiply', value: 0.4 });
    const regen = effect({ stat: 'hpRegen', op: 'add', value: 5 });
    expect(resolveStatusVisual([slow, regen])?.kind).toBe('slow');
    expect(resolveStatusVisual([regen, slow])?.kind).toBe('slow');
  });
});

describe('hasActiveSpeedStatus', () => {
  it('is true only for a live speed effect', () => {
    expect(hasActiveSpeedStatus([effect({ stat: 'speed', op: 'multiply', value: 0.4 })])).toBe(
      true,
    );
    expect(hasActiveSpeedStatus([effect({ stat: 'hpRegen', op: 'add', value: 5 })])).toBe(false);
    expect(
      hasActiveSpeedStatus([effect({ stat: 'speed', op: 'multiply', value: 0.4, remainingMs: 0 })]),
    ).toBe(false);
  });
});
