export interface CombatPressureObservation {
  elapsedMs: number;
  safe: boolean;
  valid: boolean;
  localThreatCount: number;
  health: number;
  maxHealth: number;
}

/** Descriptive mechanics evidence only; never an enjoyment or success score. */
export interface CombatPressureSummary {
  version: 1;
  status: 'measured' | 'unmeasured';
  observedMs: number;
  excludedSafeMs: number;
  excludedInvalidMs: number;
  threatenedMs: number;
  unthreatenedMs: number;
  peakLocalThreatCount: number;
  /** Net health decreases between valid adjacent observations, not damage events. */
  netHealthLoss: number;
  /** Maximum net health loss in a trailing 1000ms window. */
  peakNetHealthLoss1s: number;
  recoveryWindows: number;
  recoveryWindowMs: number;
  meaningfulDowntimeWindows: number;
  meaningfulDowntimeMs: number;
}
