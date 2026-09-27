import type {
  CombatPressureObservation,
  CombatPressureSummary,
} from '../../shared/combat-pressure-types.js';

/** Fixed hypotheses: samples <=250ms apart, recovery >=2s, downtime >=3s. */
export function createCombatPressureCollector() {
  let previous: CombatPressureObservation | undefined;
  let losses: { time: number; amount: number }[] = [];
  let hadThreat = false;
  let quietMs = 0;
  let recoveryMs = 0;
  const stats: CombatPressureSummary = {
    version: 1,
    status: 'unmeasured',
    observedMs: 0,
    excludedSafeMs: 0,
    excludedInvalidMs: 0,
    threatenedMs: 0,
    unthreatenedMs: 0,
    peakLocalThreatCount: 0,
    netHealthLoss: 0,
    peakNetHealthLoss1s: 0,
    recoveryWindows: 0,
    recoveryWindowMs: 0,
    meaningfulDowntimeWindows: 0,
    meaningfulDowntimeMs: 0,
  };
  function breakContinuity() {
    losses = [];
    hadThreat = false;
    quietMs = 0;
    recoveryMs = 0;
  }
  function valid(o: CombatPressureObservation) {
    return (
      o.valid &&
      Number.isFinite(o.elapsedMs) &&
      Number.isFinite(o.health) &&
      Number.isFinite(o.maxHealth) &&
      o.maxHealth > 0 &&
      o.health >= 0 &&
      Number.isInteger(o.localThreatCount) &&
      o.localThreatCount >= 0
    );
  }
  function observe(o: CombatPressureObservation) {
    const before = previous;
    previous = { ...o };
    if (!before) return;
    const dt = o.elapsedMs - before.elapsedMs;
    if (!Number.isFinite(dt) || dt <= 0) {
      breakContinuity();
      return;
    }
    if (!valid(o) || !valid(before) || dt > 250) {
      stats.excludedInvalidMs += dt;
      breakContinuity();
      return;
    }
    if (o.safe || before.safe) {
      stats.excludedSafeMs += dt;
      breakContinuity();
      return;
    }
    stats.status = 'measured';
    stats.observedMs += dt;
    stats.peakLocalThreatCount = Math.max(stats.peakLocalThreatCount, o.localThreatCount);
    const loss = Math.max(0, before.health - o.health);
    stats.netHealthLoss += loss;
    losses = losses.filter((entry) => entry.time > o.elapsedMs - 1000);
    if (loss > 0) losses.push({ time: o.elapsedMs, amount: loss });
    stats.peakNetHealthLoss1s = Math.max(
      stats.peakNetHealthLoss1s,
      losses.reduce((sum, entry) => sum + entry.amount, 0),
    );
    if (o.localThreatCount > 0) {
      stats.threatenedMs += dt;
      hadThreat = true;
      quietMs = 0;
      recoveryMs = 0;
      return;
    }
    stats.unthreatenedMs += dt;
    if (!hadThreat) return; // Initial exploration is not combat downtime.
    if (loss > 0) {
      quietMs = 0;
      recoveryMs = 0;
      return;
    }
    const priorQuiet = quietMs;
    quietMs += dt;
    if (priorQuiet < 3000 && quietMs >= 3000) {
      stats.meaningfulDowntimeWindows++;
      stats.meaningfulDowntimeMs += quietMs;
    } else if (priorQuiet >= 3000) stats.meaningfulDowntimeMs += dt;
    // Recovery opportunity means below full health, not actual healing.
    if (o.health < o.maxHealth && before.health < before.maxHealth) {
      const priorRecovery = recoveryMs;
      recoveryMs += dt;
      if (priorRecovery < 2000 && recoveryMs >= 2000) {
        stats.recoveryWindows++;
        stats.recoveryWindowMs += recoveryMs;
      } else if (priorRecovery >= 2000) stats.recoveryWindowMs += dt;
    } else recoveryMs = 0;
  }
  return { observe, summarize: (): CombatPressureSummary => ({ ...stats }) };
}
