/**
 * Unit coverage for the cloud eval pipeline's PURE candidate generator
 * (`scripts/agent/perf/gen-configs.ts`).
 *
 * These are the deterministic building blocks the combo × hill-climb sweep is
 * built on, so their invariants are locked here rather than only observed in a
 * cloud run:
 *   - the single incumbent combo (RISK_REWARD_FUSED+LEGACY) is returned first;
 *   - the base config is the CURRENT SSOT (`DEFAULT_CONFIG`), not stale
 *     hill-climb ranges, and every search band actually contains its SSOT value;
 *   - coordinate-ascent neighbours stay in-range, clamp at boundaries, dedup,
 *     and stop once a knob's step falls below its `minStep`;
 *   - the preflight cardinality guard hard-fails an oversized cloud matrix.
 */
import { describe, expect, it } from 'vitest';
import {
  assertMatrixWithinCap,
  baseConfigForCombo,
  comboId,
  configId,
  enumerateCombos,
  KNOB_RANGES,
  knobsForCombo,
  neighbors,
  parseComboId,
  PRIMARY_KNOBS,
  rangeFor,
  SECONDARY_KNOBS,
  type Combo,
  type SweepConfig,
} from '../../../scripts/agent/perf/gen-configs.js';
import { DEFAULT_CONFIG } from '../../../src/game/ai/bt-ai-tuning.js';
import { AIDecisionMode, AIPathingMode } from '../../../src/game/ai/types.js';

const RISK_REWARD_LEGACY: Combo = {
  pathing: AIPathingMode.RISK_REWARD_FUSED,
  decision: AIDecisionMode.LEGACY,
};

describe('enumerateCombos', () => {
  it('yields exactly the 1 pathing × decision cell', () => {
    const combos = enumerateCombos();
    expect(combos).toHaveLength(1);
    const ids = combos.map(comboId);
    expect(new Set(ids).size).toBe(1); // all unique
  });

  it('lists RISK_REWARD_FUSED+LEGACY first so it is the incumbent/control', () => {
    const first = enumerateCombos()[0];
    expect(first).toEqual(RISK_REWARD_LEGACY);
    expect(comboId(first!)).toBe('riskRewardFused+legacy');
  });

  it('covers the 1 pathing mode and 1 decision mode', () => {
    const combos = enumerateCombos();
    expect(new Set(combos.map((c) => c.pathing)).size).toBe(1);
    expect(new Set(combos.map((c) => c.decision)).size).toBe(1);
  });
});

describe('comboId / parseComboId', () => {
  it('round-trips every combo', () => {
    for (const combo of enumerateCombos()) {
      expect(parseComboId(comboId(combo))).toEqual(combo);
    }
  });

  it('throws on an unknown combo id', () => {
    expect(() => parseComboId('teleport+legacy')).toThrow(/Unknown combo id/);
  });
});

describe('knobsForCombo', () => {
  it('always includes the primary knobs', () => {
    const knobs = knobsForCombo(RISK_REWARD_LEGACY);
    for (const k of PRIMARY_KNOBS) {
      expect(knobs).toContain(k);
    }
  });

  it('adds the secondary knobs only when requested', () => {
    expect(knobsForCombo(RISK_REWARD_LEGACY, false)).not.toContain(SECONDARY_KNOBS[0]);
    const withSecondary = knobsForCombo(RISK_REWARD_LEGACY, true);
    for (const k of SECONDARY_KNOBS) {
      expect(withSecondary).toContain(k);
    }
  });
});

describe('baseConfigForCombo', () => {
  it('applies the combo modes and seeds every knob from the SSOT default', () => {
    const config = baseConfigForCombo(RISK_REWARD_LEGACY);
    expect(config.pathingMode).toBe(AIPathingMode.RISK_REWARD_FUSED);
    expect(config.decisionMode).toBe(AIDecisionMode.LEGACY);
    for (const knob of knobsForCombo(RISK_REWARD_LEGACY, true)) {
      expect(config[knob]).toBe(DEFAULT_CONFIG[knob]);
    }
  });
});

describe('KNOB_RANGES', () => {
  it('centres every band on a value that actually contains its SSOT default', () => {
    for (const range of KNOB_RANGES) {
      const ssot = DEFAULT_CONFIG[range.key];
      expect(typeof ssot).toBe('number');
      expect(ssot).toBeGreaterThanOrEqual(range.min);
      expect(ssot).toBeLessThanOrEqual(range.max);
      expect(range.minStep).toBeLessThanOrEqual(range.step);
    }
  });

  it('rangeFor returns the matching entry and throws for an unknown knob', () => {
    expect(rangeFor('aggression').key).toBe('aggression');
    // @ts-expect-error deliberately passing an invalid knob to prove the guard.
    expect(() => rangeFor('nonexistentKnob')).toThrow(/No KNOB_RANGES entry/);
  });
});

describe('configId', () => {
  it('is stable and independent of knob insertion order', () => {
    const a: SweepConfig = {
      pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      decisionMode: AIDecisionMode.LEGACY,
      aggression: 1,
      dodgeWeight: 0.25,
    };
    const b: SweepConfig = {
      pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      decisionMode: AIDecisionMode.LEGACY,
      dodgeWeight: 0.25,
      aggression: 1,
    };
    expect(configId(a)).toBe(configId(b));
  });

  it('changes when a tunable knob value changes', () => {
    const base = baseConfigForCombo(RISK_REWARD_LEGACY);
    const bumped: SweepConfig = { ...base, aggression: (base.aggression ?? 1) + 0.5 };
    expect(configId(bumped)).not.toBe(configId(base));
  });
});

describe('neighbors', () => {
  it('probes +step and -step for a mid-range knob, staying in range', () => {
    const base: SweepConfig = {
      pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      decisionMode: AIDecisionMode.LEGACY,
      aggression: 1,
    };
    const out = neighbors(base, ['aggression']);
    const values = out.map((c) => c.aggression).sort();
    expect(values).toEqual([0.5, 1.5]); // 1 ± step(0.5)
    for (const c of out) {
      expect(c.aggression!).toBeGreaterThanOrEqual(0);
      expect(c.aggression!).toBeLessThanOrEqual(2);
    }
  });

  it('drops the boundary direction that cannot move (clamped)', () => {
    const base: SweepConfig = {
      pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      decisionMode: AIDecisionMode.LEGACY,
      aggression: 0, // min of the band
    };
    const out = neighbors(base, ['aggression']);
    // -step is clamped to 0 (no move) → only the +step probe survives.
    expect(out).toHaveLength(1);
    expect(out[0]!.aggression).toBe(0.5);
  });

  it('honours a per-knob step override and stops refining below minStep', () => {
    const base: SweepConfig = {
      pathingMode: AIPathingMode.RISK_REWARD_FUSED,
      decisionMode: AIDecisionMode.LEGACY,
      aggression: 1,
    };
    // aggression minStep is 0.25; a 0.1 step is below it → knob is skipped.
    expect(neighbors(base, ['aggression'], { aggression: 0.1 })).toHaveLength(0);
    // A 0.25 step (== minStep) is still probed.
    const refined = neighbors(base, ['aggression'], { aggression: 0.25 });
    expect(refined.map((c) => c.aggression).sort()).toEqual([0.75, 1.25]);
  });

  it('produces only unique candidates (deduped by configId)', () => {
    const base = baseConfigForCombo(RISK_REWARD_LEGACY);
    const out = neighbors(base, knobsForCombo(RISK_REWARD_LEGACY, true));
    const ids = out.map(configId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain(configId(base)); // never re-emits the centre
  });
});

describe('assertMatrixWithinCap', () => {
  it('permits a matrix at or under the cap', () => {
    expect(() => assertMatrixWithinCap(8)).not.toThrow();
    expect(() => assertMatrixWithinCap(200)).not.toThrow();
  });

  it('throws when the matrix exceeds the cap', () => {
    expect(() => assertMatrixWithinCap(201)).toThrow(/exceeding the safe cap/);
  });

  it('respects a caller-supplied cap', () => {
    expect(() => assertMatrixWithinCap(9, 8)).toThrow(/exceeding the safe cap of 8/);
  });

  it('rejects a non-positive or non-integer job count', () => {
    expect(() => assertMatrixWithinCap(0)).toThrow(/positive integer/);
    expect(() => assertMatrixWithinCap(-1)).toThrow(/positive integer/);
    expect(() => assertMatrixWithinCap(3.5)).toThrow(/positive integer/);
  });
});
