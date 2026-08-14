#!/usr/bin/env node
/**
 * Cloud combo × hill-climb EVAL RUNNER for the Floor-1 AI tournament.
 *
 * Runs entirely IN-PROCESS per combo (the search loop stays local; only the
 * finalist config crosses a job boundary), using the existing `worker-pool.ts`
 * for (weapon × seed) parallelism — so a single cloud job self-parallelises
 * without a config×seed matrix (see the plan's post-adversarial-review revision).
 *
 * Four stages:
 *   --stage search          LEGACY, kept for local/small-scale iteration. For ONE
 *                            combo, coordinate-ascent over its tunable knobs on
 *                            the TRAIN seeds IN-PROCESS (all of a round's
 *                            candidates share one 4-worker pool), emitting every
 *                            evaluated run + the tuned best config. Wall time
 *                            scales as (candidates × weapons × seeds / workers),
 *                            which is why the cloud workflow no longer uses this
 *                            stage for its round loop (see search-baseline/
 *                            search-eval below) — it remains for local smoke runs.
 *   --stage search-baseline For ONE combo, evaluate ONLY its SSOT base config on
 *                            the TRAIN seeds. Emits a plain shard (one config);
 *                            the workflow wraps it into a round-0 checkpoint via
 *                            `round-plan.ts --mode init`.
 *   --stage search-eval     For ONE combo and ONE candidate config (given via
 *                            --config-id/--config-json), evaluate it on the TRAIN
 *                            seeds. Emits a plain shard (one config). This is the
 *                            unit of work each parallel round-eval matrix job
 *                            runs — fanning a round's candidates into independent
 *                            jobs is what bounds wall time by (candidates /
 *                            concurrency) instead of (candidates × weapons ×
 *                            seeds / workers).
 *   --stage validate        For ONE combo, evaluate its tuned finalist (from a
 *                            search artifact OR a round checkpoint — same shape)
 *                            on the FULL panel incl. holdout, plus the untuned
 *                            LEGACY+LEGACY incumbent control (so every validate
 *                            shard carries a flip baseline; the aggregator
 *                            collapses the identical incumbent copies as a
 *                            determinism proof). Unchanged by the round redesign.
 *
 * The SSOT tournament win is `isOfficialWin(stats, FLOOR1_TIME_BUDGET_MS)`:
 * `outcome==='victory' && (gameTimeMs - safeRoomMs) < FLOOR1_TIME_BUDGET_MS`
 * (matches the official gate + ab-* harnesses). Safe-room time is credited
 * because the floor-collapse deadline PAUSES while the player rests in a safe
 * room, so a clear that is over budget in raw game time but under it in active
 * time is a legitimate win. The composite score reuses `scoreRun` on RAW time
 * (so the search gradient never rewards safe-room idling); a clear whose ACTIVE
 * time exceeds the 6-min budget is scored as a NON-win (its outcome is
 * downgraded before scoring) so the headline Σ-score metric can never reward a
 * config for a run the tournament counts as a loss.
 *
 * Deterministic RESULTS: seeded runs only. The scored facts — every `scoreRun`
 * input, `RunRow` field, and emitted artifact row — read neither `Math.random` nor
 * the wall clock, so identical inputs always yield byte-identical outputs. `Date.now`
 * appears only in human-readable "elapsed Ns" progress logs, which never feed scoring
 * or any emitted artifact.
 *
 * Usage
 * -----
 *   npm run ai:sweep-eval -- --stage search          --combo riskRewardFused+legacy --train-seeds 1-80 --workers 4 --rounds 3 --out search.json
 *   npm run ai:sweep-eval -- --stage search-baseline --combo riskRewardFused+legacy --train-seeds 1-80 --workers 4 --out baseline.json
 *   npm run ai:sweep-eval -- --stage search-eval     --combo riskRewardFused+legacy --config-id <id> --config-json '{"...":...}' --train-seeds 1-80 --workers 4 --out shard.json
 *   npm run ai:sweep-eval -- --stage validate        --combo riskRewardFused+legacy --search-artifact search.json --seeds 1-100 --workers 4 --out validate.json
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { BehaviorTreeAI } from '../../../src/game/ai/bt-ai-provider.js';
import {
  FLOOR1_ACTIVE_TIME_BUDGET_MS,
  FLOOR1_DEFAULT_MAX_FRAMES,
} from '../../../src/game/ai/floor1-run-budget.js';
import { runHeadless } from '../../../src/game/ai/headless-runner.js';
import { AIDecisionMode, AIPathingMode, type RunStats } from '../../../src/game/ai/types.js';
import {
  LEGACY_COMBO_ID,
  type Combo,
  type SweepConfig,
  type TunableKnob,
  baseConfigForCombo,
  comboId,
  configId,
  knobsForCombo,
  neighbors,
  parseComboId,
  rangeFor,
} from './gen-configs.js';
import {
  SHARD_SCHEMA_VERSION,
  assertRowSafeRoomInRange,
  assertSearchArtifactProvenance,
  buildLeaderboard,
  deriveRunFacts,
  isBetterQualifiedCandidate,
  selectQualifiedWinner,
  type LeaderboardRow,
  type RunRow,
  type ShardArtifact,
  type ShardMeta,
} from './aggregate-shards.js';
import { halveSteps, stableStringify } from './round-plan.js';
import {
  runWorkerPool,
  type WorkerPoolTaskPayload,
  type WorkerTaskFailure,
  type WorkerTaskSuccess,
  workerOptionsForModule,
} from './worker-pool.js';
import { parseNonNegativeInt, parsePositiveInt, parseSeeds } from './winrate-sweep-args.js';

/** Floor 1 design win budget: 6 minutes of game time. The SSOT win threshold. */
const FLOOR1_TIME_BUDGET_MS = FLOOR1_ACTIVE_TIME_BUDGET_MS;
/** Slack frame budget (≈1.1× the win budget) so a near-6-min clear isn't cut mid-run. */
const MAX_FRAMES = FLOOR1_DEFAULT_MAX_FRAMES;
/** Hard wall-time cap per run so a pathological config can't hang a job forever. */
const WALL_CAP_MS = 20 * 60 * 1000;

const FLOOR1_WEAPONS = ['sword', 'bow', 'baseball-bat'];

interface EvalTask {
  combo: string;
  configId: string;
  config: SweepConfig;
  weapon: string;
  seed: number;
}

interface EvalShared {
  maxFrames: number;
  budgetMs: number;
  wallCapMs: number;
  floorId: string;
}

/** Execute one headless run and reduce it to a scored, win-classified row. */
async function runOne(task: EvalTask, shared: EvalShared): Promise<RunRow> {
  const ai = new BehaviorTreeAI({ ...task.config, seed: task.seed });
  const stats: RunStats = await runHeadless(ai, {
    seed: task.seed,
    maxFrames: shared.maxFrames,
    maxWallTimeMs: shared.wallCapMs,
    forceWeaponId: task.weapon,
    floorId: shared.floorId,
  });
  // Derive the SSOT win + composite score through the shared helper the fan-in
  // verifier (aggregate-shards) also uses, so a row's (officialWin, score) can
  // never drift between producer and aggregator. Only an over-budget victory is
  // downgraded (scored as a timeout to strip its victory/time bonus).
  const { officialWin, score } = deriveRunFacts(stats, shared.budgetMs);
  return {
    combo: task.combo,
    configId: task.configId,
    weapon: task.weapon,
    seed: task.seed,
    outcome: stats.outcome,
    officialWin,
    gameTimeMs: stats.gameTimeMs,
    safeRoomMs: stats.safeRoomMs,
    score,
    xp: stats.totalXp,
    gold: stats.totalGold,
    minHealthPercent: stats.health.minHealthPercent,
    finalLevel: stats.finalLevel,
  };
}

/** Run a batch of tasks, using the worker pool when concurrency > 1. */
async function runTasks(tasks: EvalTask[], shared: EvalShared, workers: number): Promise<RunRow[]> {
  const concurrency = Math.max(1, Math.min(workers, tasks.length));
  if (concurrency === 1) {
    const rows: RunRow[] = [];
    for (const task of tasks) {
      rows.push(await runOne(task, shared));
    }
    return rows;
  }
  return runWorkerPool<EvalTask, EvalShared, RunRow>({
    workerUrl: new URL(import.meta.url),
    tasks,
    shared,
    maxWorkers: workers,
    workerOptions: workerOptionsForModule(import.meta.url),
  });
}

/** Expand configs × weapons × seeds into the flat task list. */
function buildTasks(
  configs: readonly { id: string; config: SweepConfig }[],
  combo: string,
  weapons: readonly string[],
  seeds: readonly number[],
): EvalTask[] {
  const tasks: EvalTask[] = [];
  for (const { id, config } of configs) {
    for (const weapon of weapons) {
      for (const seed of seeds) {
        tasks.push({ combo, configId: id, config, weapon, seed });
      }
    }
  }
  return tasks;
}

/** Σ aligned composite score for a config's rows — the search heuristic. */
function totalScoreOf(rows: readonly RunRow[], id: string): number {
  return rows.filter((r) => r.configId === id).reduce((a, r) => a + r.score, 0);
}

function winsOf(rows: readonly RunRow[], id: string): number {
  return rows.filter((r) => r.configId === id && r.officialWin).length;
}

/**
 * Pure gate-aware promotion decision for the legacy `--stage search` hill
 * climb: a candidate may only replace the search's current position if it
 * ALSO passes {@link selectQualifiedWinner}'s hard safety gate (>=90%
 * official wins AND strictly MORE total wins than the FIXED original baseline
 * `incumbentConfigId` — never the search's current position, which would let
 * the gate itself drift; win→loss flips are allowed as long as total wins
 * still strictly increase, per the human-approved net-win promotion rule),
 * exactly mirroring `applyRoundResult`'s round-to-round promotion in
 * `round-plan.ts`. Extracted as a pure function (taking already-evaluated
 * rows, not running anything) so it is unit testable without headless game
 * runs — the exact wiring bug class a review would otherwise only catch by
 * re-deriving this logic by hand.
 *
 * `incumbentCombo` defaults to `comboStr` when omitted (the `riskRewardFused+legacy`
 * case where combo IS the incumbent). For non-incumbent combos whose incumbent
 * baseline rows are threaded in from `searchCombo`, pass `LEGACY_COMBO_ID`
 * so `buildLeaderboard` can locate the incumbent rows by their actual combo
 * tag — without this, `winsVsIncumbentDelta` is always `null` and every
 * candidate is disqualified by panel mismatch.
 *
 * Returns `null` when no candidate both qualifies and ranks ahead of the
 * current position under the full tie-break ordering (steps should be halved
 * by the caller in that case).
 */
export function selectSearchPromotion(
  allRows: readonly RunRow[],
  configs: Readonly<Record<string, SweepConfig>>,
  comboStr: string,
  incumbentConfigId: string,
  candidateIds: ReadonlySet<string>,
  budgetMs: number,
  currentConfigId: string,
  incumbentCombo?: string,
): { bestId: string; bestScore: number } | null {
  const leaderboard = buildLeaderboard(allRows, {
    incumbentCombo: incumbentCombo ?? comboStr,
    incumbentConfigId,
    configs,
    budgetMs,
  });
  const candidateRows = leaderboard.filter((r) => candidateIds.has(r.configId) && !r.isIncumbent);
  const { winner: qualifiedWinner } = selectQualifiedWinner(candidateRows);
  if (!qualifiedWinner) return null;
  // Compare using the full tie-break ordering (score → clear time → HP → XP →
  // gold) so a tie-equal candidate with a better secondary metric is not
  // wrongly rejected by a score-only comparison.
  const currentRow: LeaderboardRow | undefined = leaderboard.find(
    (r) => r.configId === currentConfigId,
  );
  if (isBetterQualifiedCandidate(qualifiedWinner, currentRow)) {
    return { bestId: qualifiedWinner.configId, bestScore: qualifiedWinner.totalScore };
  }
  return null;
}

interface SearchResult {
  rows: RunRow[];
  configs: Record<string, SweepConfig>;
  bestConfigId: string;
}

/**
 * Validate an externally-loaded `--legacy-baseline` artifact BEFORE injecting
 * its rows into a search's `allRows`/`configs`. Unlike shard rows fanned in via
 * {@link mergeShards} (which apply the same guards internally), this artifact
 * crosses a JSON.parse boundary straight into `searchCombo` with no provenance
 * check, so a stale/pre-v{@link SHARD_SCHEMA_VERSION} or wrong-floor/wrong-combo
 * baseline would silently seed a mis-calibrated incumbent that the emitted
 * search artifact's fresh metadata stamp would then hide from `--stage
 * validate`'s downstream `assertSearchArtifactProvenance` check. Reuses the
 * exact same schema/stage/floor/budget/frame guard as the search→validate
 * boundary, plus per-row `safeRoomMs` sanity (a pre-v2 baseline could parse
 * as valid JSON yet lack `safeRoomMs`, silently reverting win recomputation to
 * raw-time semantics and undercounting the incumbent). Also validates the
 * artifact's sole config/id is the CANONICAL incumbent base config — not merely
 * "exactly one config, tagged combo=riskRewardFused+legacy" — because a same-build
 * `--stage search-eval` shard for a *tuned* `riskRewardFused+legacy` candidate also
 * has one config, `meta.stage='search'`, incumbent-tagged rows, and valid row
 * facts, so it would otherwise pass every prior check and silently replace
 * the fixed incumbent with a tuned (non-canonical) incumbent variant.
 *
 * @param expected the caller's calibration to check the artifact against — floor/
 *   budget/frames PLUS the current-build fingerprint (see
 *   {@link currentBuildFingerprint}), threaded in by the caller (rather than
 *   computed internally here) so callers can inject a deterministic fixture in
 *   tests instead of depending on the actual host's OS/Node/dependency hash.
 * @returns the artifact's sole configId (the LEGACY baseline's config).
 */
export function assertLegacyBaselineProvenance(
  artifact: ShardArtifact,
  expected: {
    floorId: string;
    budgetMs: number;
    maxFrames: number;
    runnerOs: string;
    nodeVersion: string;
    packageLockHash: string;
    workflowSha: string;
  },
): string {
  const legacyIds = Object.keys(artifact.configs);
  const legacyId = legacyIds[0];
  if (!legacyId || legacyIds.length !== 1) {
    throw new Error(
      `--legacy-baseline artifact must contain exactly one config, got ${legacyIds.length}.`,
    );
  }
  const canonicalLegacyConfig = baseConfigForCombo({
    pathing: AIPathingMode.RISK_REWARD_FUSED,
    decision: AIDecisionMode.LEGACY,
  });
  const canonicalLegacyConfigId = configId(canonicalLegacyConfig);
  if (legacyId !== canonicalLegacyConfigId) {
    throw new Error(
      `--legacy-baseline artifact configId '${legacyId}' is not the canonical incumbent base config ` +
        `(expected '${canonicalLegacyConfigId}'). A tuned riskRewardFused+legacy shard must not be used as ` +
        `the fixed incumbent. Produce it via '--stage search-baseline --combo ${LEGACY_COMBO_ID}'.`,
    );
  }
  // Also verify the stored config BODY is *exactly* the canonical LEGACY base
  // config — the key check above catches a mis-keyed artifact, but the body
  // could still carry tuned values if the canonical key string was supplied
  // manually while the config object itself was a tuned variant. Comparing
  // via `configId()` would miss sub-4dp drift: configId() rounds every
  // numeric knob to 4dp (see gen-configs.ts `round4`), so a tuned value like
  // canonical+0.00001 would round to the identical id and slip past an
  // id-based body check while still being a non-canonical runtime config.
  // `stableStringify` performs no rounding, so it catches any body drift,
  // however small.
  const canonicalLegacyBody = stableStringify(canonicalLegacyConfig);
  const storedBody = stableStringify(artifact.configs[legacyId]!);
  if (storedBody !== canonicalLegacyBody) {
    throw new Error(
      `--legacy-baseline artifact config body does not match the canonical incumbent base config. ` +
        `Config key '${legacyId}' is correct, but the stored config body's values differ from ` +
        `the untuned canonical incumbent base. The config body must be exactly the canonical ` +
        `incumbent base, not a tuned variant under a canonical-looking key.`,
    );
  }
  const rowCombos = new Set(artifact.rows.map((r) => r.combo));
  if (rowCombos.size !== 1 || !rowCombos.has(LEGACY_COMBO_ID)) {
    throw new Error(
      `--legacy-baseline artifact rows must all be tagged combo='${LEGACY_COMBO_ID}', got: ` +
        `${[...rowCombos].join(', ')}. Produce it via ` +
        `'--stage search-baseline --combo ${LEGACY_COMBO_ID}'.`,
    );
  }
  assertSearchArtifactProvenance(artifact.meta as ShardMeta | undefined, LEGACY_COMBO_ID, {
    combo: LEGACY_COMBO_ID,
    floorId: expected.floorId,
    budgetMs: expected.budgetMs,
    maxFrames: expected.maxFrames,
    runnerOs: expected.runnerOs,
    nodeVersion: expected.nodeVersion,
    packageLockHash: expected.packageLockHash,
    workflowSha: expected.workflowSha,
  });
  for (const row of artifact.rows) {
    if (row.configId !== legacyId) {
      throw new Error(
        `--legacy-baseline artifact rows must all reference the sole configId '${legacyId}', got row configId '${row.configId}'.`,
      );
    }
    assertRowSafeRoomInRange(row);
  }
  return legacyId;
}

/**
 * Coordinate-ascent search for one combo over the TRAIN seeds. Starts from the
 * combo's SSOT base config, probes ±step neighbours of each tunable knob, moves
 * to the best-scoring neighbour, and halves steps when a round finds no
 * improvement — bounded by `rounds`.
 */
async function searchCombo(
  combo: Combo,
  opts: {
    trainSeeds: number[];
    weapons: string[];
    workers: number;
    rounds: number;
    secondary: boolean;
    floorId: string;
    /** When provided and the combo is not `riskRewardFused+legacy`, this PRE-VALIDATED
     *  (see {@link assertLegacyBaselineProvenance}) shard's rows/config are
     *  injected into `allRows`/`configs` and used as the safety-gate incumbent
     *  — exactly mirroring {@link initCheckpoint} in `round-plan.ts`. This is
     *  an OPTIMIZATION to reuse one incumbent baseline across multiple combo
     *  searches in a session — NOT a correctness requirement: when omitted,
     *  `searchCombo` evaluates the incumbent baseline itself so the gate is
     *  threaded correctly by default either way. */
    legacyBaseline?: ShardArtifact;
  },
): Promise<SearchResult> {
  const shared: EvalShared = {
    maxFrames: MAX_FRAMES,
    budgetMs: FLOOR1_TIME_BUDGET_MS,
    wallCapMs: WALL_CAP_MS,
    floorId: opts.floorId,
  };
  const comboStr = comboId(combo);
  const knobs = knobsForCombo(combo, opts.secondary);
  const steps: Partial<Record<TunableKnob, number>> = {};
  for (const knob of knobs) {
    steps[knob] = rangeFor(knob).step;
  }

  const configs: Record<string, SweepConfig> = {};
  const allRows: RunRow[] = [];
  const evaluated = new Set<string>();

  const register = (config: SweepConfig): { id: string; config: SweepConfig } => {
    const id = configId(config);
    configs[id] = config;
    return { id, config };
  };

  // Baseline.
  const base = register(baseConfigForCombo(combo));
  evaluated.add(base.id);
  allRows.push(
    ...(await runTasks(
      buildTasks([base], comboStr, opts.weapons, opts.trainSeeds),
      shared,
      opts.workers,
    )),
  );
  let currentId = base.id;
  let currentScore = totalScoreOf(allRows, currentId);
  console.log(
    `[${comboStr}] baseline ${base.id.slice(0, 48)} score=${currentScore.toExponential(3)} wins=${winsOf(allRows, currentId)}/${opts.weapons.length * opts.trainSeeds.length}`,
  );

  // Incumbent for the safety gate: use the incumbent for non-incumbent
  // combos so that the in-search net-win check mirrors the final graduation
  // gate (`selectQualifiedWinner`), exactly like `round-plan.ts`'s
  // `initCheckpoint`. For `riskRewardFused+legacy` the combo IS the incumbent,
  // so no separate baseline is needed.
  //
  // `opts.legacyBaseline` lets a caller sweeping multiple non-incumbent combos in
  // one session pass a PRE-COMPUTED incumbent shard to avoid re-running the
  // incumbent baseline once per combo. It is an optimization, NOT a correctness
  // requirement: when omitted, this function computes the incumbent baseline
  // itself (one extra headless eval pass) so the safety gate is threaded
  // correctly by default, with no opt-in flag required to avoid silently
  // falling back to the pre-fix bug (gating against the combo's own
  // baseline instead of the fixed incumbent).
  const comboIsLegacy = comboStr === LEGACY_COMBO_ID;
  let incumbentConfigId = base.id;
  let incumbentCombo = comboStr;
  if (!comboIsLegacy) {
    if (opts.legacyBaseline) {
      const legacyId = assertLegacyBaselineProvenance(opts.legacyBaseline, {
        floorId: opts.floorId,
        budgetMs: shared.budgetMs,
        maxFrames: shared.maxFrames,
        ...currentBuildFingerprint(),
      });
      incumbentConfigId = legacyId;
      Object.assign(configs, opts.legacyBaseline.configs);
      allRows.push(...opts.legacyBaseline.rows);
    } else {
      // No pre-computed shard supplied — evaluate the LEGACY baseline
      // ourselves (register() already merges it into `configs`) so the
      // gate is correct by default rather than silently falling back to
      // the pre-fix behaviour of gating against the combo's own baseline.
      const legacyBase = register(
        baseConfigForCombo({
          pathing: AIPathingMode.RISK_REWARD_FUSED,
          decision: AIDecisionMode.LEGACY,
        }),
      );
      const legacyRows = await runTasks(
        buildTasks([legacyBase], LEGACY_COMBO_ID, opts.weapons, opts.trainSeeds),
        shared,
        opts.workers,
      );
      allRows.push(...legacyRows);
      incumbentConfigId = legacyBase.id;
      console.log(
        `[${comboStr}] auto-computed LEGACY incumbent ${legacyBase.id.slice(0, 48)} wins=${winsOf(legacyRows, legacyBase.id)}/${opts.weapons.length * opts.trainSeeds.length} (pass --legacy-baseline to reuse across combos and skip this)`,
      );
    }
    incumbentCombo = LEGACY_COMBO_ID;
  }

  for (let round = 0; round < opts.rounds; round++) {
    const currentConfig = configs[currentId]!;
    const candidates = neighbors(currentConfig, knobs, steps)
      .map(register)
      .filter((c) => !evaluated.has(c.id));
    if (candidates.length === 0) {
      if (!halveSteps(steps, knobs)) {
        console.log(`[${comboStr}] round ${round + 1}: all steps at min — converged.`);
        break;
      }
      console.log(`[${comboStr}] round ${round + 1}: no new candidates — halved steps.`);
      continue;
    }
    for (const c of candidates) {
      evaluated.add(c.id);
    }
    const rows = await runTasks(
      buildTasks(candidates, comboStr, opts.weapons, opts.trainSeeds),
      shared,
      opts.workers,
    );
    allRows.push(...rows);

    // Gate promotion through the SAME hard safety gate used for round-plan.ts
    // and final graduation (see selectSearchPromotion doc comment): a
    // higher-scoring neighbour must ALSO have >=90% wins AND strictly MORE
    // total wins than the FIXED original incumbent (incumbentConfigId — the
    // LEGACY config ID for every non-LEGACY combo, whether supplied via
    // --legacy-baseline or auto-computed above; base.id only when the combo
    // itself IS legacy+legacy) before it can replace currentId — win→loss
    // flips are allowed as long as total wins still strictly increase
    // (human-approved net-win promotion rule). Naive score-only promotion
    // here would reintroduce the exact GH-run-29597840666 bug this module
    // exists to fix, just in the legacy local-smoke-run path instead of CI.
    const candidateIds = new Set(candidates.map((c) => c.id));
    const promotion = selectSearchPromotion(
      allRows,
      configs,
      comboStr,
      incumbentConfigId,
      candidateIds,
      shared.budgetMs,
      currentId,
      incumbentCombo,
    );

    if (promotion) {
      const { bestId, bestScore } = promotion;
      console.log(
        `[${comboStr}] round ${round + 1}: ✅ ${currentScore.toExponential(3)} → ${bestScore.toExponential(3)} via ${bestId.slice(0, 48)}`,
      );
      currentId = bestId;
      currentScore = bestScore;
    } else if (!halveSteps(steps, knobs)) {
      console.log(`[${comboStr}] round ${round + 1}: no improvement, steps at min — converged.`);
      break;
    } else {
      console.log(`[${comboStr}] round ${round + 1}: no improvement — halved steps.`);
    }
  }

  console.log(
    `[${comboStr}] BEST ${currentId.slice(0, 48)} score=${currentScore.toExponential(3)} wins=${winsOf(allRows, currentId)}/${opts.weapons.length * opts.trainSeeds.length}`,
  );
  return { rows: allRows, configs, bestConfigId: currentId };
}

function packageLockHash(): string {
  try {
    const url = new URL('../../../package-lock.json', import.meta.url);
    return createHash('sha256').update(readFileSync(url)).digest('hex');
  } catch {
    return 'unknown';
  }
}

function localWorkflowSha(packageLock: string): string {
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const dirty = spawnSync('git', ['status', '--porcelain', '--untracked-files=no'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const headSha =
    head.status === 0 && typeof head.stdout === 'string' && head.stdout.trim().length > 0
      ? head.stdout.trim()
      : 'unknown-head';
  const dirtyHash =
    dirty.status === 0 && typeof dirty.stdout === 'string'
      ? createHash('sha256').update(dirty.stdout).digest('hex').slice(0, 12)
      : packageLock.slice(0, 12);
  return `local:${headSha}:${dirtyHash}`;
}

/**
 * The current process's build fingerprint (OS/arch, Node runtime, dependency
 * hash, code revision). Shared by {@link buildMeta} (stamped onto every shard
 * this process emits) and every `assertSearchArtifactProvenance` call site
 * (checked against an externally-loaded artifact's stamped fingerprint) so a
 * schema/floor/budget-matching artifact from a different build is still
 * rejected — see {@link assertSearchArtifactProvenance}'s doc comment.
 *
 * `nodeVersion` is truncated to the major version (e.g. `'v22'`) rather than
 * the full `process.version` (e.g. `'v22.4.1'`): `.github/actions/setup-node`
 * pins only the major version, so `actions/setup-node@v4` can legitimately
 * resolve a different patch release per job within the SAME multi-hour
 * workflow run (round-DAG jobs run sequentially across rounds). Comparing the
 * full patch version would spuriously reject an otherwise-valid same-run
 * shard the moment a Node patch release lands mid-run; the major version is
 * still a meaningful compatibility signal without that fragility.
 */
export function currentBuildFingerprint(): Pick<
  ShardMeta,
  'runnerOs' | 'nodeVersion' | 'packageLockHash' | 'workflowSha'
> {
  const lockHash = packageLockHash();
  const workflowSha = process.env.GITHUB_SHA?.trim();
  return {
    runnerOs: `${process.platform}-${process.arch}`,
    nodeVersion: process.version.match(/^v\d+/)?.[0] ?? process.version,
    packageLockHash: lockHash,
    workflowSha: workflowSha && workflowSha.length > 0 ? workflowSha : localWorkflowSha(lockHash),
  };
}

export function buildMeta(stage: string, floorId: string): ShardMeta {
  return {
    schemaVersion: SHARD_SCHEMA_VERSION,
    budgetMs: FLOOR1_TIME_BUDGET_MS,
    floorId,
    maxFrames: MAX_FRAMES,
    stage,
    ...currentBuildFingerprint(),
  };
}

type SearchArtifact = ShardArtifact & { combo: string; bestConfigId: string };

type Stage = 'search' | 'search-baseline' | 'search-eval' | 'validate';
const STAGES: readonly Stage[] = ['search', 'search-baseline', 'search-eval', 'validate'];

/**
 * `meta.stage` value stamped onto every standalone-config shard (both
 * `--stage search-baseline` and `--stage search-eval`) via {@link evalStandalone},
 * AND `parseArgs`'s default `--stage` (consumed by `--print-meta`). Naming this
 * ONE constant instead of two independent `'search'` literals is deliberate:
 * `round-plan.ts`'s `assertResumeCompatible` strictly compares `meta.stage`
 * between a resumed checkpoint (whose `meta` is `baseline.meta`, i.e. this
 * value) and `--print-meta`'s output (also this value, when no explicit
 * `--stage` is passed) — see `ai-sweep.yml`'s "Compute this run's expected
 * provenance" step, which calls `sweep-eval.ts --print-meta` with no `--stage`
 * flag. If these two call sites ever used independent literals, a future edit
 * to one without the other would silently reject every cross-run resume
 * checkpoint on the `stage` axis. See `sweep-eval-search-promotion.test.ts`'s
 * `STANDALONE_SHARD_STAGE` regression test.
 */
export const STANDALONE_SHARD_STAGE: Stage = 'search';

interface CliArgs {
  stage: Stage;
  combo: string | null;
  configId: string | null;
  configJson: string | null;
  trainSeeds: number[];
  seeds: number[];
  weapons: string[];
  workers: number;
  rounds: number;
  secondary: boolean;
  floorId: string;
  searchArtifact: string | null;
  includeIncumbent: boolean;
  legacyBaseline: string | null;
  out: string | null;
  /** Print this runner's `ShardMeta` calibration (schemaVersion/budget/frames/
   *  runner/node/package-lock/workflow-sha) as JSON and exit — no combo/eval
   *  work performed. Used by the ai-sweep.yml cross-run `resume_run_id` path
   *  to compute "this run's expected provenance" for `round-plan.ts --mode
   *  resume-check`, without duplicating `buildMeta`'s field list anywhere else. */
  printMeta: boolean;
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    stage: STANDALONE_SHARD_STAGE,
    combo: null,
    configId: null,
    configJson: null,
    trainSeeds: parseSeeds('1-80'),
    seeds: parseSeeds('1-100'),
    weapons: FLOOR1_WEAPONS,
    workers: Math.max(1, availableParallelism()),
    rounds: 3,
    secondary: false,
    floorId: 'floor1',
    searchArtifact: null,
    includeIncumbent: true,
    legacyBaseline: null,
    out: null,
    printMeta: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--stage' && next) {
      if (!STAGES.includes(next as Stage)) {
        throw new Error(`--stage must be one of ${STAGES.join('|')}, got ${JSON.stringify(next)}`);
      }
      args.stage = next as Stage;
      i++;
    } else if (arg === '--combo' && next) {
      args.combo = next;
      i++;
    } else if (arg === '--config-id' && next) {
      args.configId = next;
      i++;
    } else if (arg === '--config-json' && next) {
      args.configJson = next;
      i++;
    } else if (arg === '--train-seeds' && next) {
      args.trainSeeds = parseSeeds(next);
      i++;
    } else if (arg === '--seeds' && next) {
      args.seeds = parseSeeds(next);
      i++;
    } else if (arg === '--weapons' && next) {
      args.weapons = next.split(',').map((w) => w.trim());
      i++;
    } else if (arg === '--workers' && next) {
      args.workers = parsePositiveInt('--workers', next);
      i++;
    } else if (arg === '--rounds' && next) {
      args.rounds = parseNonNegativeInt('--rounds', next);
      i++;
    } else if (arg === '--secondary') {
      args.secondary = true;
    } else if (arg === '--floor' && next) {
      args.floorId = next;
      i++;
    } else if (arg === '--search-artifact' && next) {
      args.searchArtifact = next;
      i++;
    } else if (arg === '--no-incumbent') {
      args.includeIncumbent = false;
    } else if (arg === '--legacy-baseline' && next) {
      args.legacyBaseline = next;
      i++;
    } else if (arg === '--out' && next) {
      args.out = next;
      i++;
    } else if (arg === '--print-meta') {
      args.printMeta = true;
    }
  }
  if (!args.combo && !args.printMeta) {
    throw new Error('--combo is required (e.g. --combo legacy+legacy)');
  }
  if (args.stage === 'search-eval' && (!args.configId || !args.configJson)) {
    throw new Error('--stage search-eval requires --config-id <id> --config-json <json>');
  }
  if (args.floorId !== 'floor1') {
    throw new Error(
      `--floor '${args.floorId}' is not supported: this sweep is Floor-1-calibrated ` +
        `(the 6-minute budget and safe-room active-time credit are Floor-1-specific). ` +
        `Non-Floor-1 win semantics are undefined here.`,
    );
  }
  return args;
}

/**
 * Evaluate exactly ONE config (baseline or a single round candidate) across
 * weapons × trainSeeds, emitting a plain single-config shard. Shared by
 * `--stage search-baseline` and `--stage search-eval` — the two stages that
 * replace the old monolithic per-combo round loop with independently
 * schedulable units of work (one GitHub Actions matrix job each).
 */
async function evalStandalone(
  comboStr: string,
  id: string,
  config: SweepConfig,
  opts: { trainSeeds: number[]; weapons: string[]; workers: number; floorId: string },
  stage: string,
): Promise<ShardArtifact> {
  const shared: EvalShared = {
    maxFrames: MAX_FRAMES,
    budgetMs: FLOOR1_TIME_BUDGET_MS,
    wallCapMs: WALL_CAP_MS,
    floorId: opts.floorId,
  };
  const rows = await runTasks(
    buildTasks([{ id, config }], comboStr, opts.weapons, opts.trainSeeds),
    shared,
    opts.workers,
  );
  return { meta: buildMeta(stage, opts.floorId), configs: { [id]: config }, rows };
}

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.printMeta) {
    // No combo/eval work — just this runner's calibration, reusing the exact
    // same buildMeta() every other stage stamps onto its shards, so there is
    // zero duplicated schemaVersion/budget/frame/runner/node/lock/sha logic
    // for the resume-import job to drift from.
    console.log(JSON.stringify(buildMeta(args.stage, args.floorId), null, 2));
    return;
  }
  const combo = parseComboId(args.combo!);
  const start = Date.now();

  if (args.stage === 'search') {
    console.log(
      `🔎 SEARCH ${comboId(combo)} · train seeds ${args.trainSeeds.length} · weapons ${args.weapons.join(',')} · workers ${args.workers} · rounds ${args.rounds}${args.secondary ? ' · +secondary' : ''}`,
    );
    const legacyBaseline = args.legacyBaseline
      ? (JSON.parse(readFileSync(args.legacyBaseline, 'utf8')) as ShardArtifact)
      : undefined;
    const result = await searchCombo(combo, {
      trainSeeds: args.trainSeeds,
      weapons: args.weapons,
      workers: args.workers,
      rounds: args.rounds,
      secondary: args.secondary,
      floorId: args.floorId,
      legacyBaseline,
    });
    const artifact: SearchArtifact = {
      meta: buildMeta('search', args.floorId),
      combo: comboId(combo),
      bestConfigId: result.bestConfigId,
      configs: result.configs,
      rows: result.rows,
    };
    emit(artifact, args.out);
    console.log(`⏱  ${((Date.now() - start) / 1000).toFixed(0)}s · ${result.rows.length} runs`);
    return;
  }

  if (args.stage === 'search-baseline') {
    const base = baseConfigForCombo(combo);
    const id = configId(base);
    console.log(
      `🔎 SEARCH-BASELINE ${comboId(combo)} · ${id.slice(0, 48)} · train seeds ${args.trainSeeds.length} · weapons ${args.weapons.join(',')} · workers ${args.workers}`,
    );
    // meta.stage is intentionally STANDALONE_SHARD_STAGE for both search-baseline
    // and search-eval shards: the `validate` stage and `initCheckpoint`/
    // `applyRoundResult` consume them identically, and the stage field does not
    // distinguish baseline vs candidate in either code path. The invoked CLI
    // stage ('search-baseline' / 'search-eval') is logged to stdout above for
    // human debugging instead. See STANDALONE_SHARD_STAGE's docstring for why
    // this must stay the same literal `--print-meta`'s default `--stage` uses.
    const artifact = await evalStandalone(
      comboId(combo),
      id,
      base,
      {
        trainSeeds: args.trainSeeds,
        weapons: args.weapons,
        workers: args.workers,
        floorId: args.floorId,
      },
      STANDALONE_SHARD_STAGE,
    );
    emit(artifact, args.out);
    console.log(`⏱  ${((Date.now() - start) / 1000).toFixed(0)}s · ${artifact.rows.length} runs`);
    return;
  }

  if (args.stage === 'search-eval') {
    const id = args.configId!;
    const config = JSON.parse(args.configJson!) as SweepConfig;
    console.log(
      `🔎 SEARCH-EVAL ${comboId(combo)} · ${id.slice(0, 48)} · train seeds ${args.trainSeeds.length} · weapons ${args.weapons.join(',')} · workers ${args.workers}`,
    );
    // meta.stage is intentionally STANDALONE_SHARD_STAGE for both search-baseline
    // and search-eval shards — see note in the search-baseline branch above.
    const artifact = await evalStandalone(
      comboId(combo),
      id,
      config,
      {
        trainSeeds: args.trainSeeds,
        weapons: args.weapons,
        workers: args.workers,
        floorId: args.floorId,
      },
      STANDALONE_SHARD_STAGE,
    );
    emit(artifact, args.out);
    console.log(`⏱  ${((Date.now() - start) / 1000).toFixed(0)}s · ${artifact.rows.length} runs`);
    return;
  }

  // validate
  if (!args.searchArtifact) {
    throw new Error('--search-artifact <path> is required for --stage validate');
  }
  const search = JSON.parse(readFileSync(args.searchArtifact, 'utf8')) as SearchArtifact;
  // The finalist config crosses the search→validate boundary WITHOUT passing
  // through the aggregate fan-in guard, so vet its provenance here: a stale
  // (pre-safe-room) or mismatched artifact must not seed v2 validation rows.
  assertSearchArtifactProvenance(search.meta as ShardMeta | undefined, search.combo, {
    combo: comboId(combo),
    floorId: args.floorId,
    budgetMs: FLOOR1_TIME_BUDGET_MS,
    maxFrames: MAX_FRAMES,
    ...currentBuildFingerprint(),
  });
  const finalist = search.configs[search.bestConfigId];
  if (!finalist) {
    throw new Error(`Search artifact missing config for bestConfigId ${search.bestConfigId}`);
  }
  const configs: Record<string, SweepConfig> = { [search.bestConfigId]: finalist };
  const toEval: { id: string; config: SweepConfig }[] = [
    { id: search.bestConfigId, config: finalist },
  ];
  const incumbent = baseConfigForCombo({
    pathing: AIPathingMode.RISK_REWARD_FUSED,
    decision: AIDecisionMode.LEGACY,
  });
  const incumbentId = configId(incumbent);
  if (args.includeIncumbent && incumbentId !== search.bestConfigId) {
    configs[incumbentId] = incumbent;
    toEval.push({ id: incumbentId, config: incumbent });
  }
  console.log(
    `✅ VALIDATE ${comboId(combo)} · finalist + ${args.includeIncumbent ? 'incumbent' : 'no incumbent'} · seeds ${args.seeds.length} · weapons ${args.weapons.join(',')} · workers ${args.workers}`,
  );
  const shared: EvalShared = {
    maxFrames: MAX_FRAMES,
    budgetMs: FLOOR1_TIME_BUDGET_MS,
    wallCapMs: WALL_CAP_MS,
    floorId: args.floorId,
  };
  // The finalist rows are tagged with the combo under test; the incumbent rows
  // are always tagged riskRewardFused+legacy so the aggregator groups + dedups them.
  const rows: RunRow[] = [];
  rows.push(
    ...(await runTasks(
      buildTasks([toEval[0]!], comboId(combo), args.weapons, args.seeds),
      shared,
      args.workers,
    )),
  );
  if (toEval.length > 1) {
    rows.push(
      ...(await runTasks(
        buildTasks(
          [toEval[1]!],
          comboId({ pathing: AIPathingMode.RISK_REWARD_FUSED, decision: AIDecisionMode.LEGACY }),
          args.weapons,
          args.seeds,
        ),
        shared,
        args.workers,
      )),
    );
  }
  const artifact: ShardArtifact = { meta: buildMeta('validate', args.floorId), configs, rows };
  emit(artifact, args.out);
  console.log(`⏱  ${((Date.now() - start) / 1000).toFixed(0)}s · ${rows.length} runs`);
}

function emit(artifact: ShardArtifact, out: string | null): void {
  const json = JSON.stringify(artifact, null, 2);
  if (out) {
    writeFileSync(out, json);
    console.log(`💾 ${out}`);
  } else {
    console.log(json);
  }
}

// Guard on BOTH !isMainThread AND a real task payload: this module's own
// runWorkerPool always sends a WorkerPoolTaskPayload, but a plain module
// import from a non-main worker thread with no payload (e.g. this file
// being imported for unit tests inside Vitest's own worker-thread pool)
// must be a no-op, not attempt to run an undefined task.
if (!isMainThread && workerData != null) {
  const payload = workerData as WorkerPoolTaskPayload<EvalTask, EvalShared>;
  runOne(payload.task, payload.shared)
    .then((result) => {
      parentPort?.postMessage({
        taskIndex: payload.taskIndex,
        result,
      } satisfies WorkerTaskSuccess<RunRow>);
    })
    .catch((error) => {
      parentPort?.postMessage({
        taskIndex: payload.taskIndex,
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      } satisfies WorkerTaskFailure);
    });
} else if (
  isMainThread &&
  (process.env.CRAWLER_PREBUNDLED_ENTRY === 'sweep-eval' ||
    (process.env.CRAWLER_PREBUNDLED_ENTRY === undefined &&
      process.argv[1] != null &&
      fileURLToPath(import.meta.url) === process.argv[1]))
) {
  main(process.argv).catch((err) => {
    console.error('Fatal:', err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
