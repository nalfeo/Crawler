import { describe, expect, it } from 'vitest';
import { createCombatPressureCollector } from '../../src/game/ai/combat-pressure.js';
import type { CombatPressureObservation } from '../../src/shared/combat-pressure-types.js';

function fixture() {
  const collector = createCombatPressureCollector();
  let elapsedMs = 0;
  let health = 100;
  function step(overrides: Partial<CombatPressureObservation> = {}, dt = 100) {
    elapsedMs += dt;
    health = overrides.health ?? health;
    collector.observe({
      elapsedMs,
      health,
      maxHealth: 100,
      safe: false,
      valid: true,
      localThreatCount: 0,
      ...overrides,
    });
  }
  step({}, 0);
  return { collector, step };
}

describe('local combat pressure temporal evidence', () => {
  it('keeps initial quiet exploration separate from post-threat downtime and recovery', () => {
    const { collector, step } = fixture();
    for (let i = 0; i < 40; i++) step();
    expect(collector.summarize().meaningfulDowntimeWindows).toBe(0);
    step({ localThreatCount: 2, health: 80 });
    for (let i = 0; i < 19; i++) step();
    expect(collector.summarize().recoveryWindows).toBe(0);
    step();
    expect(collector.summarize().recoveryWindows).toBe(1);
    for (let i = 0; i < 10; i++) step();
    expect(collector.summarize()).toMatchObject({
      status: 'measured',
      threatenedMs: 100,
      unthreatenedMs: 7000,
      observedMs: 7100,
      peakLocalThreatCount: 2,
      recoveryWindowMs: 3000,
      meaningfulDowntimeWindows: 1,
      meaningfulDowntimeMs: 3000,
    });
  });
  it('excludes safe rooms and invalid gaps and breaks temporal windows across them', () => {
    const { collector, step } = fixture();
    step({ localThreatCount: 1, health: 80 });
    step({ safe: true, health: 20 });
    step();
    step({}, 1000);
    for (let i = 0; i < 40; i++) step();
    expect(collector.summarize()).toMatchObject({
      excludedSafeMs: 200,
      excludedInvalidMs: 1000,
      netHealthLoss: 20,
      recoveryWindows: 0,
      meaningfulDowntimeWindows: 0,
    });
  });
  it('reports rolling net-loss bursts, drops expired losses, and resets on invalid samples', () => {
    const { collector, step } = fixture();
    step({ health: 90 });
    step({ health: 70 });
    for (let i = 0; i < 10; i++) step();
    step({ health: 40 });
    expect(collector.summarize()).toMatchObject({ netHealthLoss: 60, peakNetHealthLoss1s: 30 });
    step({ valid: false, health: 10 });
    step({ health: 5 });
    expect(collector.summarize().netHealthLoss).toBe(60);
  });
  it('requires valid adjacent observations and returns detached snapshots', () => {
    const { collector, step } = fixture();
    step({ valid: false });
    expect(collector.summarize().status).toBe('unmeasured');
    step();
    step();
    const summary = collector.summarize();
    summary.observedMs = 1234;
    expect(collector.summarize().observedMs).toBe(100);
  });
  it('does not call full-health quiet time a recovery opportunity', () => {
    const { collector, step } = fixture();
    step({ localThreatCount: 1 });
    for (let i = 0; i < 30; i++) step();
    expect(collector.summarize()).toMatchObject({
      recoveryWindows: 0,
      meaningfulDowntimeWindows: 1,
    });
  });
});
