/**
 * Statistics for the velocity lab.
 *
 * Design rules that this module exists to enforce:
 * - **No fake p-values.** Agent trials are few and high-variance. We report a
 *   bootstrap interval on the median difference plus a non-parametric effect
 *   size, and we say "inconclusive" loudly rather than manufacturing
 *   significance from n=3.
 * - **Deterministic.** The bootstrap is driven by `SeededRandom`, never
 *   `Math.random()`, so a report can be regenerated bit-for-bit.
 * - **One-factor rule.** An experiment may vary the environment or the model
 *   configuration, never both — otherwise a measured delta is unattributable.
 */
import { SeededRandom, hashStringToSeed } from '../../../src/shared/random.js';
import type {
  ArmSpec,
  ComparableMetric,
  Comparison,
  ExperimentSpec,
  MetricSummary,
} from './types.js';

/** Bootstrap resample count. Fixed so reports are comparable across runs. */
export const BOOTSTRAP_SAMPLES = 2000;

/** Below this many passing trials per arm, no comparison can be conclusive. */
export const MIN_SAMPLES_FOR_VERDICT = 3;

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

export function summarize(values: readonly number[]): MetricSummary {
  if (values.length === 0) {
    return { n: 0, median: Number.NaN, mean: Number.NaN, min: Number.NaN, max: Number.NaN };
  }
  const total = values.reduce((acc, v) => acc + v, 0);
  return {
    n: values.length,
    median: median(values),
    mean: total / values.length,
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

/**
 * Cliff's delta: the probability that a treatment value exceeds a baseline
 * value, minus the reverse. Non-parametric, robust at tiny n, and unitless —
 * which is exactly what we need when comparing token counts to turn counts.
 */
export function cliffsDelta(baseline: readonly number[], treatment: readonly number[]): number {
  if (baseline.length === 0 || treatment.length === 0) return Number.NaN;
  let greater = 0;
  let less = 0;
  for (const t of treatment) {
    for (const b of baseline) {
      if (t > b) greater++;
      else if (t < b) less++;
    }
  }
  return (greater - less) / (treatment.length * baseline.length);
}

/** Standard Romano/Vargha-Delaney magnitude thresholds for Cliff's delta. */
export function effectSizeLabel(delta: number): Comparison['effectSizeLabel'] {
  const magnitude = Math.abs(delta);
  if (!Number.isFinite(magnitude) || magnitude < 0.147) return 'negligible';
  if (magnitude < 0.33) return 'small';
  if (magnitude < 0.474) return 'medium';
  return 'large';
}

function resample(values: readonly number[], rng: SeededRandom): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length; i++) {
    out.push(values[rng.nextInt(0, values.length - 1)] as number);
  }
  return out;
}

/**
 * Percentile bootstrap 95% interval on (median(treatment) - median(baseline)).
 * Seeded by the metric name so every metric gets an independent but
 * reproducible resampling stream.
 */
export function bootstrapMedianDeltaCi95(
  baseline: readonly number[],
  treatment: readonly number[],
  seedKey: string,
  samples: number = BOOTSTRAP_SAMPLES,
): [number, number] {
  if (baseline.length === 0 || treatment.length === 0) return [Number.NaN, Number.NaN];
  const rng = new SeededRandom(hashStringToSeed(seedKey));
  const deltas: number[] = [];
  for (let i = 0; i < samples; i++) {
    deltas.push(median(resample(treatment, rng)) - median(resample(baseline, rng)));
  }
  deltas.sort((a, b) => a - b);
  const lowIndex = Math.floor(0.025 * (deltas.length - 1));
  const highIndex = Math.ceil(0.975 * (deltas.length - 1));
  return [deltas[lowIndex] as number, deltas[highIndex] as number];
}

export function compareArms(
  metric: ComparableMetric,
  baselineArm: string,
  baseline: readonly number[],
  treatmentArm: string,
  treatment: readonly number[],
): Comparison {
  const baselineMedian = median(baseline);
  const treatmentMedian = median(treatment);
  const ci95 = bootstrapMedianDeltaCi95(
    baseline,
    treatment,
    `${metric}:${baselineArm}:${treatmentArm}`,
  );
  const delta = cliffsDelta(baseline, treatment);
  const hasSamples =
    baseline.length >= MIN_SAMPLES_FOR_VERDICT && treatment.length >= MIN_SAMPLES_FOR_VERDICT;
  const ciExcludesZero =
    Number.isFinite(ci95[0]) && Number.isFinite(ci95[1]) && (ci95[0] > 0 || ci95[1] < 0);

  return {
    metric,
    baselineArm,
    treatmentArm,
    baselineMedian,
    treatmentMedian,
    medianDelta: treatmentMedian - baselineMedian,
    ci95,
    cliffsDelta: delta,
    effectSizeLabel: effectSizeLabel(delta),
    conclusive: hasSamples && ciExcludesZero,
  };
}

const MODEL_FIELDS = ['model', 'reasoningEffort', 'contextTier', 'agent'] as const;
const ENVIRONMENT_FIELDS = ['setup'] as const;

function fingerprint(arm: ArmSpec, fields: readonly (keyof ArmSpec)[]): string {
  return JSON.stringify(fields.map((field) => arm[field] ?? null));
}

/**
 * The one-factor rule. An experiment that changes the environment *and* the
 * model in the same comparison produces a delta nobody can attribute, so the
 * harness refuses to run it and tells you to split it into two experiments.
 */
export function assertOneFactor(spec: ExperimentSpec): void {
  if (spec.arms.length < 2) {
    throw new Error(`Experiment "${spec.id}" needs at least 2 arms; got ${spec.arms.length}.`);
  }
  const ids = new Set<string>();
  for (const arm of spec.arms) {
    if (ids.has(arm.id))
      throw new Error(`Duplicate arm id "${arm.id}" in experiment "${spec.id}".`);
    ids.add(arm.id);
  }

  // The factor being varied is free; every OTHER factor must be held constant.
  const heldConstant = spec.factor === 'model' ? ENVIRONMENT_FIELDS : MODEL_FIELDS;
  const first = spec.arms[0] as ArmSpec;
  const baseline = fingerprint(first, heldConstant);
  for (const arm of spec.arms.slice(1)) {
    if (fingerprint(arm, heldConstant) !== baseline) {
      throw new Error(
        `Two-factor experiment rejected: "${spec.id}" declares factor="${spec.factor}", but arm ` +
          `"${arm.id}" also differs from "${first.id}" in [${heldConstant.join(', ')}]. ` +
          `A delta from a two-factor change is unattributable — split this into two experiments.`,
      );
    }
  }

  // A single-factor experiment where nothing actually varies is a no-op.
  const varying = spec.factor === 'model' ? MODEL_FIELDS : ENVIRONMENT_FIELDS;
  const varyingBaseline = fingerprint(first, varying);
  const anyVaries = spec.arms.slice(1).some((arm) => fingerprint(arm, varying) !== varyingBaseline);
  if (!anyVaries) {
    throw new Error(
      `Experiment "${spec.id}" declares factor="${spec.factor}" but no arm varies ` +
        `[${varying.join(', ')}]. Nothing would be measured.`,
    );
  }
}
