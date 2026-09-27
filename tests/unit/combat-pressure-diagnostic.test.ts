import { describe, expect, it } from 'vitest';
import { combatPressureDiagnostic } from '../../scripts/agent/health/combat-pressure-diagnostic.js';
import { createCombatPressureCollector } from '../../src/game/ai/combat-pressure.js';

describe('combat pressure report evidence', () => {
  function measured() {
    const collector = createCombatPressureCollector();
    for (let elapsedMs = 0; elapsedMs <= 4000; elapsedMs += 100) {
      collector.observe({
        elapsedMs,
        safe: false,
        valid: true,
        localThreatCount: elapsedMs < 500 ? 1 : 0,
        health: 50,
        maxHealth: 100,
      });
    }
    return collector.summarize();
  }

  it('preserves actual descriptive collector evidence including overlapping recovery and downtime', () => {
    const summary = measured();
    expect(summary.recoveryWindows).toBe(1);
    expect(summary.meaningfulDowntimeWindows).toBe(1);
    expect(combatPressureDiagnostic(summary)).toEqual({ status: 'measured', summary });
  });

  it.each([undefined, null, {}, { version: 2 }, createCombatPressureCollector().summarize()])(
    'keeps absent or unmeasured evidence null: %j',
    (value) => {
      expect(combatPressureDiagnostic(value)).toMatchObject({
        status: 'unmeasured',
        summary: null,
      });
    },
  );

  it.each([
    { observedMs: NaN },
    { excludedSafeMs: Infinity },
    { netHealthLoss: -1 },
    { version: 2 },
    { status: 'healthy' },
    { status: 'unmeasured' },
    { threatenedMs: 5000 },
    { recoveryWindowMs: 5000 },
    { meaningfulDowntimeMs: 5000 },
    { peakNetHealthLoss1s: 10 },
    { peakLocalThreatCount: 1.5 },
    { recoveryWindows: 2 },
    { meaningfulDowntimeWindows: 0 },
  ])('rejects malformed or contradictory evidence: %j', (changes) => {
    expect(combatPressureDiagnostic({ ...measured(), ...changes })).toMatchObject({
      status: 'unmeasured',
      summary: null,
    });
  });
});
