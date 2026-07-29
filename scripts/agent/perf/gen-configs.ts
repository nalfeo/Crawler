#!/usr/bin/env node
/**
 * PURE candidate/grid generation for the cloud combo × hill-climb eval pipeline.
 *
 * The eval pipeline searches, for every (pathing × decision) COMBO, the AIConfig
 * knob-set that maximises the Floor-1 tournament objective. This module owns the
 * side-effect-free building blocks that decision needs:
 *
 *   - `enumerateCombos()` — the active pathing×decision cells (RISK_REWARD_FUSED+LEGACY
 *     first, so it is always the incumbent/control the leaderboard compares against).
 *   - `KNOB_RANGES` — search bounds DERIVED FROM THE CURRENT SSOT (`DEFAULT_CONFIG`
 *     in `bt-ai-tuning.ts`), NOT the stale `hill-climb.ts` ranges (which disagree
 *     with SSOT by up to 8× on scanRadius/rangedSafeDistance/grabRadius and set
 *     collectPullWeight to 0). Ranges are SSOT-centred bands.
 *   - `baseConfigForCombo()` — the SSOT default knob-set with a combo's two modes
 *     applied; the search seed and the leaderboard's per-combo control.
 *   - `neighbors()` — coordinate-ascent ± step probes (the search LOOP lives in
 *     `sweep-eval.ts`, which needs headless evals between rounds; this module only
 *     produces the candidate geometry so it stays pure + unit-testable).
 *   - `configId()` — a stable, combo-aware identity used for dedup + leaderboard
 *     grouping.
 *   - `assertMatrixWithinCap()` — the preflight cardinality guard that hard-fails
 *     an oversized cloud matrix before any runner is spun up (GitHub caps a matrix
 *     at 256 jobs; we stay well under).
 *
 * Everything here is deterministic and free of Math.random / Date.now, so the
 * same inputs always yield the same candidate set on every runner.
 */
import { fileURLToPath } from 'node:url';
import {
  AIDecisionMode,
  AIPathingMode,
  type AIConfig,
  type AIDecisionModeValue,
  type AIPathingModeValue,
} from '../../../src/game/ai/types.js';
import { DEFAULT_CONFIG } from '../../../src/game/ai/bt-ai-tuning.js';

/** A pathing × decision cell of the A/B grid. */
export interface Combo {
  pathing: AIPathingModeValue;
  decision: AIDecisionModeValue;
}

/** Stable, human-readable id for a combo, e.g. `"riskRewardFused+legacy"`. */
export function comboId(combo: Combo): string {
  return `${combo.pathing}+${combo.decision}`;
}

/** The canonical id for the RISK_REWARD_FUSED+LEGACY combo — the tournament's reference incumbent. */
export const LEGACY_COMBO_ID = 'riskRewardFused+legacy';

/**
 * All pathing×decision combos, with RISK_REWARD_FUSED+LEGACY first so it is always the
 * incumbent/control the tournament ranks every tuned combo against (the flip is
 * only ever away from RISK_REWARD_FUSED, human-gated).
 */
export function enumerateCombos(): Combo[] {
  const pathings: AIPathingModeValue[] = [AIPathingMode.RISK_REWARD_FUSED];
  const decisions: AIDecisionModeValue[] = [AIDecisionMode.LEGACY];
  const combos: Combo[] = [];
  for (const pathing of pathings) {
    for (const decision of decisions) {
      combos.push({ pathing, decision });
    }
  }
  // RISK_REWARD_FUSED+LEGACY is already first (pathings[0]×decisions[0]).
  return combos;
}

/** Parse a `comboId` string back into a Combo, throwing on an unknown cell. */
export function parseComboId(id: string): Combo {
  const match = enumerateCombos().find((c) => comboId(c) === id);
  if (!match) {
    throw new Error(
      `Unknown combo id ${JSON.stringify(id)}; expected one of ${enumerateCombos()
        .map(comboId)
        .join(', ')}`,
    );
  }
  return match;
}

/** Numeric AIConfig knobs the eval pipeline tunes. */
export type TunableKnob =
  | 'aggression'
  | 'retreatThreshold'
  | 'dodgeWeight'
  | 'rangedSafeDistance'
  | 'collectPullWeight'
  | 'farmPullWeight'
  | 'scanRadius'
  | 'retreatDangerRadius'
  | 'opportunisticGrabRadius';

export interface KnobRange {
  key: TunableKnob;
  min: number;
  max: number;
  /** Initial coordinate-ascent step. */
  step: number;
  /** Stop refining a knob once its step falls below this. */
  minStep: number;
}

/**
 * Search bounds as SSOT-centred bands around `DEFAULT_CONFIG` (bt-ai-tuning.ts).
 * DELIBERATELY not reused from hill-climb.ts, whose ranges are stale relative to
 * the current defaults. `DEFAULT_MID` below asserts each band actually contains
 * its SSOT default so a future SSOT change that drifts outside a band is caught.
 */
export const KNOB_RANGES: readonly KnobRange[] = [
  { key: 'aggression', min: 0, max: 2, step: 0.5, minStep: 0.25 }, // SSOT 1
  { key: 'retreatThreshold', min: 0.05, max: 0.4, step: 0.05, minStep: 0.025 }, // SSOT 0.1
  { key: 'dodgeWeight', min: 0, max: 0.75, step: 0.125, minStep: 0.0625 }, // SSOT 0.25
  { key: 'rangedSafeDistance', min: 8, max: 40, step: 6, minStep: 3 }, // SSOT 15
  { key: 'collectPullWeight', min: 0, max: 1, step: 0.15, minStep: 0.075 }, // SSOT 0.5
  { key: 'farmPullWeight', min: 0, max: 0.3, step: 0.05, minStep: 0.025 }, // SSOT 0.12
  { key: 'scanRadius', min: 25, max: 100, step: 15, minStep: 7.5 }, // SSOT 50 (secondary)
  { key: 'retreatDangerRadius', min: 10, max: 60, step: 10, minStep: 5 }, // SSOT 20 (secondary)
  { key: 'opportunisticGrabRadius', min: 8, max: 40, step: 6, minStep: 3 }, // SSOT 18 (secondary)
];

/**
 * Primary knobs — tuned in the coarse pass for every combo (highest expected
 * leverage on win-rate + clear quality per the user's stated goals).
 */
export const PRIMARY_KNOBS: readonly TunableKnob[] = [
  'aggression',
  'retreatThreshold',
  'dodgeWeight',
  'rangedSafeDistance',
  'collectPullWeight',
  'farmPullWeight',
];

/** Secondary knobs — only added in the refine pass on the leading combos. */
export const SECONDARY_KNOBS: readonly TunableKnob[] = [
  'scanRadius',
  'retreatDangerRadius',
  'opportunisticGrabRadius',
];

const RANGE_BY_KEY: ReadonlyMap<TunableKnob, KnobRange> = new Map(
  KNOB_RANGES.map((range) => [range.key, range]),
);

/** Look up a knob's range, throwing if it is somehow missing (never at runtime). */
export function rangeFor(knob: TunableKnob): KnobRange {
  const range = RANGE_BY_KEY.get(knob);
  if (!range) {
    throw new Error(`No KNOB_RANGES entry for ${knob}`);
  }
  return range;
}

/**
 * A candidate knob-set. Flattened into a Partial<AIConfig> so a runner can build
 * the AI directly with `new BehaviorTreeAI({ seed, ...config })`. `pathingMode`
 * and `decisionMode` are always present (they define the combo).
 */
export type SweepConfig = Partial<AIConfig> & {
  pathingMode: AIPathingModeValue;
  decisionMode: AIDecisionModeValue;
};

/**
 * The tunable knobs applicable to a combo.
 */
export function knobsForCombo(_combo: Combo, includeSecondary = false): TunableKnob[] {
  const knobs: TunableKnob[] = [...PRIMARY_KNOBS];
  if (includeSecondary) {
    knobs.push(...SECONDARY_KNOBS);
  }
  return knobs;
}

/**
 * The base (search-seed) config for a combo: the current SSOT default value of
 * every tunable knob, plus the combo's two modes. This doubles as the combo's
 * tuned-search starting point AND the incumbent control's config when combo is
 * RISK_REWARD_FUSED+LEGACY.
 */
export function baseConfigForCombo(combo: Combo): SweepConfig {
  const config: SweepConfig = {
    pathingMode: combo.pathing,
    decisionMode: combo.decision,
  };
  for (const knob of knobsForCombo(combo, true)) {
    config[knob] = DEFAULT_CONFIG[knob];
  }
  return config;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Round to 4 dp for stable identity/formatting (kills float drift in ids). */
function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

/**
 * Deterministic, combo-aware identity of a config: the two modes plus every
 * tunable knob it sets as `key=value` (sorted, 4-dp). Two configs with the same
 * id are the same point in search space, so the aggregator can dedup on it.
 */
export function configId(config: SweepConfig): string {
  const parts: string[] = [`p=${config.pathingMode}`, `d=${config.decisionMode}`];
  const knobParts: string[] = [];
  for (const range of KNOB_RANGES) {
    const value = config[range.key];
    if (typeof value === 'number') {
      knobParts.push(`${range.key}=${round4(value).toFixed(4)}`);
    }
  }
  knobParts.sort();
  return [...parts, ...knobParts].join(',');
}

/**
 * Coordinate-ascent neighbours of `config`: for each tunable knob, one probe at
 * +step and one at −step, clamped to the knob's range. Probes that don't move
 * (already at a boundary, or step below half the knob's minStep) are dropped, and
 * duplicate points are collapsed by `configId`.
 *
 * `steps` may override the per-knob step (the search halves steps as it
 * converges); knobs absent from `steps` use their `KNOB_RANGES` default step.
 */
export function neighbors(
  config: SweepConfig,
  knobs: readonly TunableKnob[],
  steps?: Partial<Record<TunableKnob, number>>,
): SweepConfig[] {
  const out: SweepConfig[] = [];
  const seen = new Set<string>([configId(config)]);
  for (const knob of knobs) {
    const range = rangeFor(knob);
    const step = steps?.[knob] ?? range.step;
    if (step < range.minStep) {
      continue; // fully refined on this knob
    }
    const current =
      typeof config[knob] === 'number' ? (config[knob] as number) : DEFAULT_CONFIG[knob];
    for (const direction of [1, -1] as const) {
      const next = round4(clamp(current + direction * step, range.min, range.max));
      if (Math.abs(next - current) < range.minStep * 0.5) {
        continue; // clamped at boundary — no real move
      }
      const candidate: SweepConfig = { ...config, [knob]: next };
      const id = configId(candidate);
      if (seen.has(id)) {
        continue;
      }
      seen.add(id);
      out.push(candidate);
    }
  }
  return out;
}

/**
 * GitHub Actions caps a workflow matrix at 256 jobs and private-repo plans cap
 * concurrent jobs well below that. Hard-fail an oversized run BEFORE spinning up
 * any runner. Default cap is a conservative 200.
 */
export function assertMatrixWithinCap(jobCount: number, cap = 200): void {
  if (!Number.isInteger(jobCount) || jobCount <= 0) {
    throw new Error(`Matrix job count must be a positive integer, got ${jobCount}`);
  }
  if (jobCount > cap) {
    throw new Error(
      `Matrix would spawn ${jobCount} jobs, exceeding the safe cap of ${cap}. ` +
        `Reduce combos/shards or raise the cap deliberately (GitHub hard limit is 256).`,
    );
  }
}

// ---------------------------------------------------------------------------
// CLI (guarded so importing this module for its pure helpers never runs it).
// Prints the candidate set / matrix plan as JSON for inspection or for a
// workflow step to consume.
// ---------------------------------------------------------------------------
interface CliArgs {
  combo: string | null;
  includeSecondary: boolean;
  neighbors: boolean;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { combo: null, includeSecondary: false, neighbors: false };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--combo' && next) {
      args.combo = next;
      i++;
    } else if (arg === '--secondary') {
      args.includeSecondary = true;
    } else if (arg === '--neighbors') {
      args.neighbors = true;
    }
  }
  return args;
}

function runCli(argv: readonly string[]): void {
  const args = parseCliArgs(argv);
  if (args.combo) {
    const combo = parseComboId(args.combo);
    const base = baseConfigForCombo(combo);
    const knobs = knobsForCombo(combo, args.includeSecondary);
    const payload = {
      combo: comboId(combo),
      knobs,
      base,
      baseId: configId(base),
      ...(args.neighbors
        ? { neighbors: neighbors(base, knobs).map((c) => ({ id: configId(c), config: c })) }
        : {}),
    };
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  const combos = enumerateCombos();
  console.log(
    JSON.stringify(
      {
        combos: combos.map((c) => ({
          id: comboId(c),
          knobs: knobsForCombo(c, args.includeSecondary),
          base: baseConfigForCombo(c),
        })),
        count: combos.length,
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv);
}
