/**
 * apple-calibration-lib.ts — pure, dependency-free logic for the apple
 * calibration health check.
 *
 * Kept free of `node:fs` / `process` so the parsing and aggregation maths can
 * be unit-tested directly. The thin `apple-calibration.ts` wrapper owns all
 * file I/O and reporting.
 *
 * Historical apple logs use a few legacy shapes that this module normalizes:
 *   - field aliases: `estimate` / `estimated` → `estimated_apples`,
 *     `actual` → `actual_apples`, `slug` → `session`
 *   - apple-emoji counts: `"🍎🍎"` → `2`
 *   - the `on-target` verdict, a synonym for `exact`
 *   - a missing `delta`, derived from `actual_apples - estimated_apples`
 *
 * Entries that still lack a usable estimate/actual after normalization are
 * rejected (return `null`) so they can never poison the aggregate with `NaN`.
 */

export type Verdict = 'exact' | 'under' | 'over' | 'miss';

export const VALID_VERDICTS: readonly Verdict[] = ['exact', 'under', 'over', 'miss'];

/** A `|delta|` at or above this counts as a calibration miss. */
export const MISS_THRESHOLD = 2;

const APPLE_EMOJI = '🍎';

/** Canonical, fully-resolved apple entry consumed by the calibration maths. */
export interface AppleEntry {
  readonly date?: string;
  readonly session: string;
  readonly estimated_apples: number;
  readonly actual_apples: number;
  readonly delta: number;
  readonly verdict: Verdict;
  readonly hello_kitties: number;
}

export type RawAppleEntry = Record<string, unknown>;

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Coerce an apple count that may be a number, a numeric string, or a string of
 * 🍎 emojis (legacy handoff format) into a finite number. Returns `undefined`
 * when the value cannot be interpreted.
 */
export function coerceApples(value: unknown): number | undefined {
  if (isFiniteNumber(value)) return value;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  if (trimmed.includes(APPLE_EMOJI)) {
    const count = trimmed.split(APPLE_EMOJI).length - 1;
    return count > 0 ? count : undefined;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

/** Map an `actual - estimated` delta to the canonical verdict (complexity-policy.md). */
export function verdictFromDelta(delta: number): Verdict {
  if (Math.abs(delta) >= MISS_THRESHOLD) return 'miss';
  if (delta > 0) return 'under';
  if (delta < 0) return 'over';
  return 'exact';
}

/**
 * Normalize a verdict string. The legacy `on-target` label is an alias for
 * `exact`. Unknown strings return `undefined` so the caller can derive the
 * verdict from the delta instead.
 */
export function normalizeVerdict(value: unknown): Verdict | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if (v === 'on-target' || v === 'on target') return 'exact';
  return (VALID_VERDICTS as readonly string[]).includes(v) ? (v as Verdict) : undefined;
}

/** Emoji for a verdict. Falls back to ❓ so an unexpected value never prints `undefined`. */
export function verdictEmoji(v: Verdict): string {
  switch (v) {
    case 'exact':
      return '🎯';
    case 'under':
      return '📉';
    case 'over':
      return '📈';
    case 'miss':
      return '💥';
    default:
      return '❓';
  }
}

/** True when an entry's delta counts as a calibration miss. */
export function isMiss(delta: number): boolean {
  return Math.abs(delta) >= MISS_THRESHOLD;
}

/**
 * Resolve a raw log entry — which may use legacy field aliases, emoji apple
 * counts, the `on-target` verdict, or omit `delta` — into a canonical
 * {@link AppleEntry}. Returns `null` when the entry lacks a usable estimate or
 * actual, so malformed rows are excluded from the aggregate rather than
 * corrupting it with `NaN`.
 */
export function normalizeEntry(raw: RawAppleEntry): AppleEntry | null {
  const estimated = coerceApples(raw.estimated_apples ?? raw.estimated ?? raw.estimate);
  const actual = coerceApples(raw.actual_apples ?? raw.actual);
  if (estimated === undefined || actual === undefined) return null;

  const delta = isFiniteNumber(raw.delta) ? raw.delta : actual - estimated;
  const verdict = normalizeVerdict(raw.verdict) ?? verdictFromDelta(delta);
  const helloKitties = isFiniteNumber(raw.hello_kitties) ? raw.hello_kitties : round2(actual / 5);
  const session = asNonEmptyString(raw.session) ?? asNonEmptyString(raw.slug) ?? '(unknown)';
  const date = asNonEmptyString(raw.date);

  return {
    ...(date ? { date } : {}),
    session,
    estimated_apples: estimated,
    actual_apples: actual,
    delta,
    verdict,
    hello_kitties: helloKitties,
  };
}

export interface LevelStats {
  readonly count: number;
  readonly meanDelta: number;
  readonly missRate: number;
}

export interface CalibrationStats {
  readonly totalSessions: number;
  readonly meanDelta: number;
  readonly missCount: number;
  readonly missRate: number;
  readonly byLevel: Map<number, LevelStats>;
  readonly byVerdict: Map<Verdict, number>;
}

/**
 * Aggregate calibration statistics over canonical entries. Every returned
 * number is finite (0 for an empty input), so the report can never surface
 * `NaN`.
 */
export function computeCalibration(entries: readonly AppleEntry[]): CalibrationStats {
  const totalSessions = entries.length;
  const sumDelta = entries.reduce((s, e) => s + e.delta, 0);
  const meanDelta = totalSessions === 0 ? 0 : sumDelta / totalSessions;
  const missCount = entries.filter((e) => isMiss(e.delta)).length;
  const missRate = totalSessions === 0 ? 0 : missCount / totalSessions;

  const levels = new Map<number, AppleEntry[]>();
  for (const e of entries) {
    const bucket = levels.get(e.estimated_apples) ?? [];
    bucket.push(e);
    levels.set(e.estimated_apples, bucket);
  }
  const byLevel = new Map<number, LevelStats>();
  for (const [level, bucket] of levels) {
    const lSum = bucket.reduce((s, e) => s + e.delta, 0);
    const lMiss = bucket.filter((e) => isMiss(e.delta)).length;
    byLevel.set(level, {
      count: bucket.length,
      meanDelta: lSum / bucket.length,
      missRate: lMiss / bucket.length,
    });
  }

  const byVerdict = new Map<Verdict, number>();
  for (const e of entries) {
    byVerdict.set(e.verdict, (byVerdict.get(e.verdict) ?? 0) + 1);
  }

  return { totalSessions, meanDelta, missCount, missRate, byLevel, byVerdict };
}
