import type { CombatPressureSummary } from '../../../src/shared/combat-pressure-types.js';

/** Separate descriptive evidence; never participates in v2 scoring or gates. */
export type CombatPressureDiagnostic =
  | { readonly status: 'measured'; readonly summary: CombatPressureSummary }
  | { readonly status: 'unmeasured'; readonly reason: string; readonly summary: null };

const NUMERIC_FIELDS = [
  'observedMs',
  'excludedSafeMs',
  'excludedInvalidMs',
  'threatenedMs',
  'unthreatenedMs',
  'peakLocalThreatCount',
  'netHealthLoss',
  'peakNetHealthLoss1s',
  'recoveryWindows',
  'recoveryWindowMs',
  'meaningfulDowntimeWindows',
  'meaningfulDowntimeMs',
] as const;

export function combatPressureDiagnostic(
  value: unknown,
  chainedFloorIds?: unknown,
): CombatPressureDiagnostic {
  const missing = (reason: string): CombatPressureDiagnostic => ({
    status: 'unmeasured',
    reason,
    summary: null,
  });
  // Flattened chained runs may retain only the last leg's summary via object spread.
  // Until producers explicitly aggregate intervals, that evidence cannot describe the run.
  if (chainedFloorIds !== undefined) {
    if (
      !Array.isArray(chainedFloorIds) ||
      chainedFloorIds.length === 0 ||
      !chainedFloorIds.every((id: unknown) => typeof id === 'string' && id.trim().length > 0)
    ) {
      return missing('Local combat pressure chain metadata is malformed.');
    }
    if (chainedFloorIds.length > 1) {
      return missing('Local combat pressure is unmeasured for flattened multi-leg runs.');
    }
  }
  if (value === undefined || value === null)
    return missing('Local combat pressure evidence is absent.');
  if (typeof value !== 'object') return missing('Local combat pressure evidence is malformed.');
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || (record.status !== 'measured' && record.status !== 'unmeasured')) {
    return missing('Local combat pressure version or status is unsupported.');
  }
  if (
    !NUMERIC_FIELDS.every(
      (key) => typeof record[key] === 'number' && Number.isFinite(record[key]) && record[key] >= 0,
    )
  ) {
    return missing('Local combat pressure fields must be finite and nonnegative.');
  }
  const s = record as unknown as CombatPressureSummary;
  const tolerance = Math.max(1, s.observedMs) * 1e-9;
  if (
    !Number.isInteger(s.peakLocalThreatCount) ||
    !Number.isInteger(s.recoveryWindows) ||
    !Number.isInteger(s.meaningfulDowntimeWindows) ||
    Math.abs(s.threatenedMs + s.unthreatenedMs - s.observedMs) > tolerance ||
    s.recoveryWindowMs > s.unthreatenedMs + tolerance ||
    s.meaningfulDowntimeMs > s.unthreatenedMs + tolerance ||
    s.peakNetHealthLoss1s > s.netHealthLoss + tolerance ||
    s.threatenedMs > 0 !== s.peakLocalThreatCount > 0 ||
    (s.recoveryWindows === 0) !== (s.recoveryWindowMs === 0) ||
    (s.meaningfulDowntimeWindows === 0) !== (s.meaningfulDowntimeMs === 0) ||
    s.recoveryWindowMs + tolerance < s.recoveryWindows * 2000 ||
    s.meaningfulDowntimeMs + tolerance < s.meaningfulDowntimeWindows * 3000 ||
    (s.status === 'measured') !== s.observedMs > 0
  )
    return missing('Local combat pressure evidence violates interval or window conservation.');
  if (s.status === 'unmeasured')
    return missing('No valid unsafe observation intervals were measured.');
  const summary: CombatPressureSummary = {
    version: 1,
    status: 'measured',
    ...Object.fromEntries(NUMERIC_FIELDS.map((key) => [key, s[key]])),
  } as CombatPressureSummary;
  return { status: 'measured', summary };
}
