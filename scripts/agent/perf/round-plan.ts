#!/usr/bin/env node
/**
 * PURE round-planning + checkpointing for the cloud combo × hill-climb eval
 * pipeline. This is what turns the old ONE-JOB-PER-COMBO coordinate-ascent
 * search (which flattened every round's candidates × weapons × seeds into a
 * single 4-worker task queue, so wall time scaled as totalTasks/4) into a
 * FAN-OUT design: each round's candidates become independent matrix jobs, so
 * wall time per round is bounded by (candidates / concurrency), not by
 * (candidates × weapons × seeds / workers).
 *
 * Three pure operations, mirroring the three round-DAG steps in
 * `.github/workflows/ai-sweep.yml`:
 *
 *   - {@link initCheckpoint}   Wrap a combo's baseline shard (from
 *                              `sweep-eval --stage search-baseline`) into a
 *                              round-0 `RoundCheckpoint`. One per combo.
 *   - {@link planRoundMatrix}  Flatten every still-open combo's next-round
 *                              candidate neighbours into ONE matrix-ready
 *                              list (each entry independently evaluable by
 *                              `sweep-eval --stage search-eval`), capped for
 *                              GitHub Actions matrix safety.
 *   - {@link applyRoundResult} Merge a round's evaluated candidate shards back
 *                              into a combo's checkpoint: adopt the best
 *                              improving candidate, or halve steps toward
 *                              convergence. This IS the checkpoint — every
 *                              round's `RoundCheckpoint` is a complete,
 *                              self-contained artifact, so a downstream
 *                              timeout/failure never discards a prior round's
 *                              progress (the last successfully-uploaded
 *                              checkpoint is always valid input to `validate`).
 *
 * `RoundCheckpoint` is a superset of the legacy `SearchArtifact` shape
 * (`{ meta, combo, bestConfigId, configs, rows }` via {@link toSearchArtifact}),
 * so `sweep-eval --stage validate` needs NO changes to consume it.
 *
 * Deterministic and free of Math.random / Date.now — same discipline as
 * gen-configs.ts / aggregate-shards.ts, which this module is built on top of.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertMatrixWithinCap,
  comboId,
  configId,
  knobsForCombo,
  neighbors,
  parseComboId,
  rangeFor,
  type Combo,
  type SweepConfig,
  type TunableKnob,
} from './gen-configs.js';
import { buildLeaderboard, selectQualifiedWinner } from './aggregate-shards.js';
import type { RunRow, ShardArtifact, ShardMeta } from './aggregate-shards.js';

/** Σ composite score for one config's rows — the search hill-climb heuristic. */
function totalScoreOf(rows: readonly RunRow[], id: string): number {
  return rows.filter((r) => r.configId === id).reduce((a, r) => a + r.score, 0);
}

/**
 * Halve every knob's step; return whether any step is still ≥ its minStep
 * (i.e. there is more room to refine). Moved here (out of sweep-eval.ts,
 * unchanged in behaviour) so both the legacy monolithic `--stage search` loop
 * and the new per-round checkpoint advance share one implementation.
 */
export function halveSteps(
  steps: Partial<Record<TunableKnob, number>>,
  knobs: readonly TunableKnob[],
): boolean {
  let anyAboveMin = false;
  for (const knob of knobs) {
    const range = rangeFor(knob);
    const next = (steps[knob] ?? range.step) / 2;
    steps[knob] = next;
    if (next >= range.minStep) {
      anyAboveMin = true;
    }
  }
  return anyAboveMin;
}

/**
 * A combo's full search state after N completed rounds. A superset of the
 * legacy `SearchArtifact` — {@link toSearchArtifact} projects it back down for
 * the unchanged `validate` stage.
 */
export interface RoundCheckpoint {
  meta: ShardMeta;
  combo: string;
  /** Number of rounds folded into this checkpoint so far (0 = baseline only). */
  round: number;
  bestConfigId: string;
  bestScore: number;
  /**
   * The baseline/incumbent config id — set once in {@link initCheckpoint} and
   * NEVER reassigned across rounds (baseline rows are seeded into `rows` at
   * round 0 and never removed). Lets every later round evaluate promotion
   * candidates against the SAME hard safety gate that governs final
   * graduation (`selectQualifiedWinner`: >=90% official wins AND zero
   * incumbent win→loss flips, THEN highest score) instead of promoting on
   * composite score alone — see `applyRoundResult`.
   */
  incumbentConfigId: string;
  /** Current per-knob step size (halves on a round with no improvement). */
  steps: Partial<Record<TunableKnob, number>>;
  /** True once every knob's step has fallen below its minStep — no more candidates. */
  converged: boolean;
  /** Every config evaluated so far (baseline + all candidates across all rounds), keyed by id. */
  configs: Record<string, SweepConfig>;
  /** Every evaluated run across all rounds so far. */
  rows: RunRow[];
}

/** Build the round-0 checkpoint from a combo's baseline shard (`--stage search-baseline`). */
export function initCheckpoint(
  combo: Combo,
  knobs: readonly TunableKnob[],
  baseline: ShardArtifact,
): RoundCheckpoint {
  const comboStr = comboId(combo);
  const baseIds = Object.keys(baseline.configs);
  const baseId = baseIds[0];
  if (!baseId || baseIds.length !== 1) {
    throw new Error(
      `initCheckpoint(${comboStr}): baseline shard must contain exactly one config, got ${baseIds.length}`,
    );
  }
  const steps: Partial<Record<TunableKnob, number>> = {};
  for (const knob of knobs) {
    steps[knob] = rangeFor(knob).step;
  }
  return {
    meta: baseline.meta,
    combo: comboStr,
    round: 0,
    bestConfigId: baseId,
    bestScore: totalScoreOf(baseline.rows, baseId),
    incumbentConfigId: baseId,
    steps,
    converged: false,
    configs: { ...baseline.configs },
    rows: [...baseline.rows],
  };
}

/**
 * The still-unevaluated neighbour candidates of a checkpoint's current best
 * config. Empty once converged, or once every neighbour at the current step
 * has already been evaluated in an earlier round (coordinate-ascent moving
 * back over already-visited ground).
 */
export function planCandidates(
  checkpoint: RoundCheckpoint,
  knobs: readonly TunableKnob[],
): { id: string; config: SweepConfig }[] {
  if (checkpoint.converged) {
    return [];
  }
  const currentConfig = checkpoint.configs[checkpoint.bestConfigId];
  if (!currentConfig) {
    throw new Error(
      `planCandidates(${checkpoint.combo}): missing config for bestConfigId ${checkpoint.bestConfigId}`,
    );
  }
  const evaluated = new Set(Object.keys(checkpoint.configs));
  return neighbors(currentConfig, knobs, checkpoint.steps)
    .map((config) => ({ id: configId(config), config }))
    .filter((c) => !evaluated.has(c.id));
}

/** One matrix-ready candidate: independently evaluable by `sweep-eval --stage search-eval`. */
export interface FlatCandidate {
  combo: string;
  configId: string;
  config: SweepConfig;
}

export interface CheckpointWithKnobs {
  checkpoint: RoundCheckpoint;
  knobs: readonly TunableKnob[];
}

/**
 * Flatten every still-open combo's next-round candidates into ONE
 * matrix-ready list (mixed across combos — each entry carries its own
 * `combo`), and hard-fail BEFORE any runner spins up if the combined count
 * would exceed a safe GitHub Actions matrix cap (same guard `preflight`
 * already applies to the combo matrix; default cap kept in sync with
 * `assertMatrixWithinCap`'s own default of 200, well under GitHub's hard
 * 256-job matrix limit).
 */
export function planRoundMatrix(
  checkpoints: readonly CheckpointWithKnobs[],
  cap = 200,
): FlatCandidate[] {
  const out: FlatCandidate[] = [];
  for (const { checkpoint, knobs } of checkpoints) {
    for (const c of planCandidates(checkpoint, knobs)) {
      out.push({ combo: checkpoint.combo, configId: c.id, config: c.config });
    }
  }
  if (out.length > 0) {
    assertMatrixWithinCap(out.length, cap);
  }
  return out;
}

/** Fields that must match a checkpoint's own provenance for a candidate shard to be mergeable. */
function assertShardCompatible(checkpoint: RoundCheckpoint, shard: ShardArtifact): void {
  if (shard.meta.schemaVersion !== checkpoint.meta.schemaVersion) {
    throw new Error(
      `applyRoundResult(${checkpoint.combo}): shard schemaVersion ${shard.meta.schemaVersion} != checkpoint ${checkpoint.meta.schemaVersion}`,
    );
  }
  if (shard.meta.floorId !== checkpoint.meta.floorId) {
    throw new Error(
      `applyRoundResult(${checkpoint.combo}): shard floorId '${shard.meta.floorId}' != checkpoint '${checkpoint.meta.floorId}'`,
    );
  }
  if (shard.meta.budgetMs !== checkpoint.meta.budgetMs) {
    throw new Error(
      `applyRoundResult(${checkpoint.combo}): shard budgetMs ${shard.meta.budgetMs} != checkpoint ${checkpoint.meta.budgetMs}`,
    );
  }
  if (shard.meta.maxFrames !== checkpoint.meta.maxFrames) {
    throw new Error(
      `applyRoundResult(${checkpoint.combo}): shard maxFrames ${shard.meta.maxFrames} != checkpoint ${checkpoint.meta.maxFrames}`,
    );
  }
}

/**
 * Merge this round's evaluated candidate shards into a combo's checkpoint and
 * advance the search: promote the highest-scoring candidate that ALSO passes
 * the approved hard safety gate (>=90% official wins AND zero win→loss flips
 * vs the incumbent — the same {@link selectQualifiedWinner} gate that governs
 * final graduation in `aggregate-shards.ts`), or — when nothing qualifying
 * improved — halve the step sizes and mark `converged` once every knob's step
 * has fallen below its minStep.
 *
 * This is the round-plan half of the fix for the real bug the 2026-07 untuned
 * graduation run (GitHub run 29597840666) exposed: a config can out-score the
 * incumbent while quietly flipping incumbent wins into losses, and a
 * score-only hill-climb would happily chase that config round after round.
 * Gating promotion on `selectQualifiedWinner` means the search's own
 * trajectory can never walk toward (or settle on) a config the final gate
 * would reject.
 *
 * `options.plannedCount` (when supplied) lets the caller distinguish "this
 * round genuinely produced fewer/no improving candidates" (a real search
 * dead-end — halve steps, converge if at the floor) from "some of this
 * round's PLANNED candidates never produced a shard at all" (an infra
 * failure — a matrix leg failed or was cancelled). In the infra-failure case
 * we deliberately do NOT halve/converge: `planCandidates` re-derives the
 * SAME neighbour set from `checkpoint.configs` next round (the missing
 * candidate's config was never absorbed), so leaving `steps`/`converged`
 * untouched simply retries the same candidates rather than falsely recording
 * "the algorithm learned there's no improvement here" from partial data.
 * Legacy/test callers that omit `plannedCount` keep the original
 * always-halve-on-no-improvement behaviour.
 *
 * `options.plannedCount === 'unknown'` is a DISTINCT sentinel from `0`:
 * `0` means "the planner ran successfully and legitimately decided this
 * combo needed no new candidates" (already converged — halving is correct),
 * while `'unknown'` means "the planner job itself never produced a
 * candidates manifest at all" (e.g. `roundN-candidates` crashed before
 * uploading its artifact) — we cannot tell whether 0 or N candidates were
 * planned for this combo, so we must NOT infer convergence from that
 * silence. `'unknown'` always forces the infra-failure (no halve/converge)
 * path, regardless of `candidateShards.length`.
 */
export function applyRoundResult(
  checkpoint: RoundCheckpoint,
  round: number,
  knobs: readonly TunableKnob[],
  candidateShards: readonly ShardArtifact[],
  options: { plannedCount?: number | 'unknown' } = {},
): RoundCheckpoint {
  // Idempotent no-op once converged. `planCandidates` never plans anything
  // for a converged checkpoint, so a converged combo should never see
  // non-empty candidateShards here either; short-circuiting avoids
  // repeatedly halving an already-minimal step size on every remaining
  // bounded round (harmless numerically, but confusing to read/debug).
  if (checkpoint.converged) {
    return { ...checkpoint, round };
  }

  const configs = { ...checkpoint.configs };
  const rows = [...checkpoint.rows];
  const seenRowKeys = new Set(rows.map((r) => `${r.configId}\u0000${r.weapon}\u0000${r.seed}`));
  const newCandidateIds = new Set<string>();

  for (const shard of candidateShards) {
    assertShardCompatible(checkpoint, shard);
    for (const [id, config] of Object.entries(shard.configs)) {
      const existing = configs[id];
      if (existing && JSON.stringify(existing) !== JSON.stringify(config)) {
        throw new Error(
          `applyRoundResult(${checkpoint.combo}): conflicting config definition for id ${id} — determinism violation across shards.`,
        );
      }
      configs[id] = config;
      newCandidateIds.add(id);
    }
    for (const r of shard.rows) {
      const key = `${r.configId}\u0000${r.weapon}\u0000${r.seed}`;
      if (seenRowKeys.has(key)) {
        continue; // identical/duplicate cross-shard row — benign, skip.
      }
      seenRowKeys.add(key);
      rows.push(r);
      newCandidateIds.add(r.configId);
    }
  }

  const leaderboard = buildLeaderboard(rows, {
    incumbentCombo: checkpoint.combo,
    incumbentConfigId: checkpoint.incumbentConfigId,
    configs,
    budgetMs: checkpoint.meta.budgetMs,
  });
  const newCandidateRows = leaderboard.filter(
    (r) => newCandidateIds.has(r.configId) && !r.isIncumbent,
  );
  const { winner: qualifiedWinner } = selectQualifiedWinner(newCandidateRows);

  let bestId = checkpoint.bestConfigId;
  let bestScore = checkpoint.bestScore;
  if (qualifiedWinner && qualifiedWinner.totalScore > bestScore) {
    bestId = qualifiedWinner.configId;
    bestScore = qualifiedWinner.totalScore;
  }
  const improved = bestId !== checkpoint.bestConfigId;

  const steps = { ...checkpoint.steps };
  let converged: boolean = checkpoint.converged;
  if (!improved) {
    let infraIncomplete: boolean;
    if (options.plannedCount === 'unknown') {
      // The planner job never produced a candidates manifest for this combo
      // at all (e.g. roundN-candidates crashed/never uploaded) — we cannot
      // tell "0 planned" from "N planned, all lost", so always treat as an
      // infra failure rather than risk falsely recording convergence.
      infraIncomplete = true;
    } else if (options.plannedCount !== undefined) {
      const missing = Math.max(0, options.plannedCount - candidateShards.length);
      infraIncomplete = options.plannedCount > 0 && missing > 0;
    } else {
      infraIncomplete = false;
    }
    if (!infraIncomplete) {
      converged = !halveSteps(steps, knobs);
    }
    // else: infra failure with incomplete/unknown data this round — leave
    // steps/converged untouched so the same neighbours are retried.
  }

  return {
    ...checkpoint,
    round,
    bestConfigId: bestId,
    bestScore,
    steps,
    converged,
    configs,
    rows,
  };
}

/** Legacy `SearchArtifact` shape the unchanged `validate` stage consumes. */
export interface SearchArtifactLike {
  meta: ShardMeta;
  combo: string;
  bestConfigId: string;
  configs: Record<string, SweepConfig>;
  rows: RunRow[];
}

/** Project a checkpoint down to the legacy `SearchArtifact` shape — pure reshape, no data loss to `validate`. */
export function toSearchArtifact(checkpoint: RoundCheckpoint): SearchArtifactLike {
  return {
    meta: checkpoint.meta,
    combo: checkpoint.combo,
    bestConfigId: checkpoint.bestConfigId,
    configs: checkpoint.configs,
    rows: checkpoint.rows,
  };
}

// ---------------------------------------------------------------------------
// CLI (guarded so importing this module for its pure helpers never runs it).
// Three modes mirror the three round-DAG workflow steps:
//   --mode init   <combo> --baseline <shard.json> [--secondary] --out <checkpoint.json>
//   --mode plan   --round N [--secondary] [--cap N] --out <matrix.json> <checkpoint.json...>
//   --mode select --round N [--secondary] [--planned-count N|unknown] --checkpoint <checkpoint.json> --out <checkpoint.json> [<shard.json...>]
// ---------------------------------------------------------------------------

function knobsFor(comboStr: string, secondary: boolean): TunableKnob[] {
  return knobsForCombo(parseComboId(comboStr), secondary);
}

interface CliArgs {
  mode: 'init' | 'plan' | 'select' | null;
  combo: string | null;
  baseline: string | null;
  checkpoint: string | null;
  round: number | null;
  secondary: boolean;
  cap: number;
  plannedCount: number | 'unknown' | null;
  out: string | null;
  files: string[];
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    mode: null,
    combo: null,
    baseline: null,
    checkpoint: null,
    round: null,
    secondary: false,
    cap: 200,
    plannedCount: null,
    out: null,
    files: [],
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = argv[i + 1];
    if (arg === '--mode' && next) {
      if (next !== 'init' && next !== 'plan' && next !== 'select') {
        throw new Error(`--mode must be init|plan|select, got ${JSON.stringify(next)}`);
      }
      args.mode = next;
      i++;
    } else if (arg === '--combo' && next) {
      args.combo = next;
      i++;
    } else if (arg === '--baseline' && next) {
      args.baseline = next;
      i++;
    } else if (arg === '--checkpoint' && next) {
      args.checkpoint = next;
      i++;
    } else if (arg === '--round' && next) {
      args.round = Number.parseInt(next, 10);
      i++;
    } else if (arg === '--secondary') {
      args.secondary = true;
    } else if (arg === '--cap' && next) {
      args.cap = Number.parseInt(next, 10);
      i++;
    } else if (arg === '--planned-count' && next) {
      args.plannedCount = next === 'unknown' ? 'unknown' : Number.parseInt(next, 10);
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    } else if (!arg.startsWith('--')) {
      args.files.push(arg);
    }
  }
  return args;
}

function emit(value: unknown, out: string | null): void {
  const json = JSON.stringify(value, null, 2);
  if (out) {
    writeFileSync(out, json);
    console.log(`💾 ${out}`);
  } else {
    console.log(json);
  }
}

function runCli(argv: readonly string[]): void {
  const args = parseCliArgs(argv);
  if (!args.mode) {
    console.error(
      'Usage: ai:round-plan --mode init|plan|select ... (see round-plan.ts header for per-mode flags)',
    );
    process.exit(1);
    return;
  }

  if (args.mode === 'init') {
    if (!args.combo || !args.baseline) {
      throw new Error('--mode init requires --combo <id> --baseline <shard.json>');
    }
    const combo = parseComboId(args.combo);
    const knobs = knobsFor(args.combo, args.secondary);
    const baseline = JSON.parse(readFileSync(args.baseline, 'utf8')) as ShardArtifact;
    const checkpoint = initCheckpoint(combo, knobs, baseline);
    console.log(
      `[${checkpoint.combo}] round 0 checkpoint: best=${checkpoint.bestConfigId.slice(0, 48)} score=${checkpoint.bestScore.toExponential(3)}`,
    );
    emit(checkpoint, args.out);
    return;
  }

  if (args.mode === 'plan') {
    if (args.round === null) {
      throw new Error('--mode plan requires --round N');
    }
    if (args.files.length === 0) {
      throw new Error('--mode plan requires one or more checkpoint JSON files as positional args');
    }
    const inputs: CheckpointWithKnobs[] = args.files.map((f) => {
      const checkpoint = JSON.parse(readFileSync(f, 'utf8')) as RoundCheckpoint;
      return { checkpoint, knobs: knobsFor(checkpoint.combo, args.secondary) };
    });
    const candidates = planRoundMatrix(inputs, args.cap);
    const hasCandidates = candidates.length > 0;
    const byCombo = new Map<string, number>();
    for (const c of candidates) {
      byCombo.set(c.combo, (byCombo.get(c.combo) ?? 0) + 1);
    }
    console.log(
      `Round ${args.round}: ${candidates.length} candidate(s) across ${inputs.length} checkpoint(s)` +
        (hasCandidates
          ? ` — ${[...byCombo.entries()].map(([c, n]) => `${c}:${n}`).join(', ')}`
          : ' — all converged, nothing to evaluate this round.'),
    );
    emit({ round: args.round, hasCandidates, candidates }, args.out);
    return;
  }

  // select
  if (args.round === null) {
    throw new Error('--mode select requires --round N');
  }
  if (!args.checkpoint) {
    throw new Error('--mode select requires --checkpoint <checkpoint.json>');
  }
  const checkpoint = JSON.parse(readFileSync(args.checkpoint, 'utf8')) as RoundCheckpoint;
  const knobs = knobsFor(checkpoint.combo, args.secondary);
  const shards = args.files.map((f) => JSON.parse(readFileSync(f, 'utf8')) as ShardArtifact);
  const updated = applyRoundResult(checkpoint, args.round, knobs, shards, {
    plannedCount: args.plannedCount ?? undefined,
  });
  const improved = updated.bestConfigId !== checkpoint.bestConfigId;
  console.log(
    `[${updated.combo}] round ${args.round}: merged ${shards.length} shard(s) — ` +
      (improved
        ? `✅ ${checkpoint.bestScore.toExponential(3)} → ${updated.bestScore.toExponential(3)} via ${updated.bestConfigId.slice(0, 48)}`
        : updated.converged
          ? 'no improvement, steps at min — converged.'
          : 'no improvement — halved steps.'),
  );
  emit(updated, args.out);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  runCli(process.argv);
}
