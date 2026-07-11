/**
 * Batch orchestrator for the sprite pipeline (Phase 3 build 6).
 *
 * Wraps `runFull` so a directory of briefs can be processed in one
 * command, with a single cross-run `JudgeBudget` + `JudgeCache` instance
 * threaded through every brief. This is the build that makes the cost
 * ceiling actually do work: without batch, the budget is a per-process
 * formality.
 *
 * Design rules:
 *
 *   1. Composable, not coupled. This module imports `runFull` and
 *      treats it as a black box. It does NOT modify the per-brief
 *      pipeline. PR #52 (gallery skeleton) is editing `generate-one.ts`
 *      and `run-artifacts.ts` concurrently; the batch layer must avoid
 *      both files entirely.
 *
 *   2. Sequential by default. `concurrency` accepts >=1 but only `1`
 *      is honoured here — Azure rate-limit accounting + budget
 *      consistency get hairy when N briefs race on the same shared
 *      budget. We accept the flag so the API doesn't churn when we
 *      eventually relax this (probably with a small worker pool).
 *
 *   3. One bad brief never kills the batch. Per-brief errors are
 *      caught, captured in `BatchBriefResult.error`, and the loop
 *      continues. The CLI prints the full stack to stderr as it
 *      happens so the human still sees the failure live.
 *
 *   4. Incremental persistence. After EVERY brief (success, failure,
 *      or skip) we rewrite `batch-summary.json` with the partial
 *      results. A Ctrl-C mid-batch leaves a valid summary describing
 *      what got done — the gallery (PR #52, follow-up) reads this
 *      file to populate its batch view.
 *
 *   5. Budget gate is pre-flight, per BRIEF. Once `wouldExceed()`
 *      returns true we stop starting new briefs — but a brief already
 *      in flight runs to completion. The per-variant budget gate
 *      inside `runFull` handles mid-brief exhaustion; this layer
 *      only decides whether to even start.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runFull } from './run-full.js';
import type { RunFullOptions, RunFullResult } from './run-full.js';
import type { JudgeBudget } from './cost-tracker.js';
import { resolveRates } from './cost-tracker.js';
import type { JudgeCache } from './judge-cache.js';
import type { RunSummary } from './run-artifacts.js';

/**
 * Options the batch passes through to each `runFull` call. We deliberately
 * accept the strict subset that varies across briefs/tests, so the batch type
 * doesn't drift if `RunFullOptions` grows new fields the batch shouldn't touch.
 */
export type RunFullFactory = (options: RunFullOptions) => Promise<RunFullResult>;

export interface BatchOptions {
  readonly briefPaths: ReadonlyArray<string>;
  readonly repoRoot: string;
  /** Output root for per-brief runs. Defaults to `<repoRoot>/generated`. */
  readonly outputRoot?: string;
  /** Shared across all briefs in the batch — this is the whole point. */
  readonly judgeBudget: JudgeBudget | null;
  readonly judgeCache: JudgeCache | null;
  /** Pass-through generate-one wiring. */
  readonly provider: RunFullOptions['provider'];
  readonly textProvider?: RunFullOptions['textProvider'];
  readonly visionProvider?: RunFullOptions['visionProvider'];
  /** Reserved for future parallel execution. Currently must be 1. */
  readonly concurrency?: number;
  /** Clock injection for deterministic batch IDs + timestamps. */
  readonly now?: () => Date;
  /**
   * Per-brief progress sink, fired after each brief completes (success,
   * failure, or skip). The CLI uses this for the live one-line stderr
   * trace; tests use it to assert sequencing.
   */
  readonly onBriefComplete?: (result: BatchBriefResult, index: number, total: number) => void;
  /**
   * Test seam: substitute the real `runFull` for a stub. Defaults to the
   * production import. Lets the batch unit tests assert non-invocation
   * without spinning up a full mock provider stack.
   */
  readonly generate?: RunFullFactory;
  /**
   * Where to write `batch-summary.json`. Defaults to
   * `<outputRoot>/runs/_batch/<batchId>/batch-summary.json`. When null,
   * persistence is skipped (handy for tests that don't care about disk).
   */
  readonly batchDir?: string | null;
}

export interface BatchBudgetSnapshot {
  /** Cap as configured for this batch. May be `Infinity`. */
  readonly budgetUsd: number;
  readonly spentUsd: number;
  readonly remainingUsd: number;
  /** Calls actually issued by this batch (sums across briefs). */
  readonly callsThisRun: number;
  /** Per-variant skips inside `runFull` due to over-budget. */
  readonly callsSkipped: number;
}

export interface BatchCacheStats {
  readonly hits: number;
  readonly misses: number;
  readonly bypassed: number;
}

export interface BatchTotals {
  readonly briefsAttempted: number;
  readonly briefsSucceeded: number;
  readonly briefsFailed: number;
  readonly briefsSkippedOverBudget: number;
  readonly variantsJudged: number;
  readonly variantsSkipped: number;
}

export type BatchBriefStatus = 'succeeded' | 'failed' | 'skipped-over-budget';

export interface BatchBriefError {
  readonly message: string;
  readonly stack?: string;
}

export interface BatchBriefResult {
  readonly briefPath: string;
  /**
   * Brief identifier derived from the run's `summary.brief` when available,
   * falling back to the filename without extension. The CLI uses this in
   * progress lines.
   */
  readonly briefId: string;
  readonly status: BatchBriefStatus;
  /** Absolute run dir, or empty string when the brief was skipped/failed pre-run. */
  readonly runDir: string;
  readonly summary?: RunSummary;
  readonly error?: BatchBriefError;
  readonly elapsedMs: number;
}

export interface BatchSummary {
  readonly batchId: string;
  readonly startedAt: string;
  /**
   * Null while the batch is still in flight (partial-write between
   * briefs). Populated once the loop exits, even on early termination.
   */
  readonly finishedAt: string | null;
  readonly briefs: ReadonlyArray<BatchBriefResult>;
  readonly judgeBudget: BatchBudgetSnapshot | null;
  readonly judgeCache: BatchCacheStats;
  readonly totals: BatchTotals;
}

interface BatchPaths {
  readonly batchDir: string;
  readonly summaryPath: string;
}

function makeBatchId(now: Date, seed: string): string {
  const iso = now.toISOString().replace(/[:.]/g, '-').replace(/-+Z$/, 'Z');
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 6);
  return `${iso}-${hash}`;
}

function batchPaths(outputRoot: string, batchId: string): BatchPaths {
  const batchDir = path.join(outputRoot, 'runs', '_batch', batchId);
  return { batchDir, summaryPath: path.join(batchDir, 'batch-summary.json') };
}

/**
 * Run a batch end-to-end. Returns the final summary AND has written the
 * same payload to `<batchDir>/batch-summary.json` (unless `batchDir` is
 * explicitly null).
 */
export async function runBatch(options: BatchOptions): Promise<BatchSummary> {
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`runBatch: concurrency must be a positive integer, got ${concurrency}`);
  }
  if (concurrency !== 1) {
    // Documented limitation — see the module header. Surfacing as a hard
    // error rather than silently dropping the flag so a future enabler
    // can grep for the throw site.
    throw new Error(
      `runBatch: concurrency > 1 not yet supported (got ${concurrency}). ` +
        `Sequential execution keeps Azure rate limits and budget accounting deterministic.`,
    );
  }
  const now = options.now ?? (() => new Date());
  const outputRoot = options.outputRoot ?? path.join(options.repoRoot, 'generated');
  const startedAt = now();
  const batchId = makeBatchId(startedAt, options.briefPaths.join('\n'));
  const paths =
    options.batchDir === null
      ? null
      : options.batchDir !== undefined
        ? {
            batchDir: options.batchDir,
            summaryPath: path.join(options.batchDir, 'batch-summary.json'),
          }
        : batchPaths(outputRoot, batchId);
  const generate = options.generate ?? runFull;

  const briefs: BatchBriefResult[] = [];
  const writeSnapshot = (finishedAt: string | null): BatchSummary => {
    const snapshot = composeSummary({
      batchId,
      startedAt: startedAt.toISOString(),
      finishedAt,
      briefs,
      judgeBudget: options.judgeBudget,
      judgeCache: options.judgeCache,
    });
    if (paths) {
      mkdirSync(paths.batchDir, { recursive: true });
      writeFileSync(paths.summaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    }
    return snapshot;
  };
  // Write an empty snapshot up front so the batch dir exists even if the
  // loop terminates before the first brief completes (e.g. all skipped).
  writeSnapshot(null);

  for (let i = 0; i < options.briefPaths.length; i++) {
    const briefPath = options.briefPaths[i]!;
    const start = Date.now();

    // Pre-flight budget gate. We treat exhaustion as a hard stop on new
    // work — even briefs that don't use the judge get skipped, because
    // the batch CLI exists primarily to drive judged briefs and the
    // alternative (peeking inside each YAML to decide) couples this
    // layer to the schema.
    if (options.judgeBudget && options.judgeBudget.wouldExceed()) {
      const result: BatchBriefResult = {
        briefPath,
        briefId: briefIdFromPath(briefPath),
        status: 'skipped-over-budget',
        runDir: '',
        elapsedMs: Date.now() - start,
      };
      briefs.push(result);
      writeSnapshot(null);
      options.onBriefComplete?.(result, i, options.briefPaths.length);
      continue;
    }

    try {
      const generateOptions: RunFullOptions = {
        briefPath,
        provider: options.provider,
        textProvider: options.textProvider ?? null,
        visionProvider: options.visionProvider ?? null,
        judgeBudget: options.judgeBudget,
        judgeCache: options.judgeCache,
        repoRoot: options.repoRoot,
        outputRoot,
        ...(options.now ? { now: options.now } : {}),
      };
      const run = await generate(generateOptions);
      const result: BatchBriefResult = {
        briefPath,
        briefId: run.summary.brief || briefIdFromPath(briefPath),
        status: 'succeeded',
        runDir: run.runDir,
        summary: run.summary,
        elapsedMs: Date.now() - start,
      };
      briefs.push(result);
      writeSnapshot(null);
      options.onBriefComplete?.(result, i, options.briefPaths.length);
    } catch (err) {
      const errorPayload: BatchBriefError =
        err instanceof Error
          ? { message: err.message, ...(err.stack ? { stack: err.stack } : {}) }
          : { message: String(err) };
      const result: BatchBriefResult = {
        briefPath,
        briefId: briefIdFromPath(briefPath),
        status: 'failed',
        runDir: '',
        error: errorPayload,
        elapsedMs: Date.now() - start,
      };
      briefs.push(result);
      writeSnapshot(null);
      options.onBriefComplete?.(result, i, options.briefPaths.length);
    }
  }

  return writeSnapshot(now().toISOString());
}

interface ComposeArgs {
  readonly batchId: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly briefs: ReadonlyArray<BatchBriefResult>;
  readonly judgeBudget: JudgeBudget | null;
  readonly judgeCache: JudgeCache | null;
}

function composeSummary(args: ComposeArgs): BatchSummary {
  const totals = computeTotals(args.briefs);
  const budgetSnap = args.judgeBudget ? args.judgeBudget.snapshot() : null;
  return {
    batchId: args.batchId,
    startedAt: args.startedAt,
    finishedAt: args.finishedAt,
    briefs: args.briefs.map((b) => ({ ...b })),
    judgeBudget: budgetSnap
      ? {
          budgetUsd: budgetSnap.budgetUsd,
          spentUsd: budgetSnap.spentUsd,
          remainingUsd:
            typeof budgetSnap.remainingUsd === 'number'
              ? budgetSnap.remainingUsd
              : Number.POSITIVE_INFINITY,
          callsThisRun: budgetSnap.callsThisRun,
          callsSkipped: budgetSnap.callsSkippedDueToBudget,
        }
      : null,
    judgeCache: args.judgeCache
      ? { ...args.judgeCache.stats }
      : { hits: 0, misses: 0, bypassed: 0 },
    totals,
  };
}

function computeTotals(briefs: ReadonlyArray<BatchBriefResult>): BatchTotals {
  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  let variantsJudged = 0;
  let variantsSkipped = 0;
  for (const b of briefs) {
    if (b.status === 'succeeded') succeeded += 1;
    else if (b.status === 'failed') failed += 1;
    else skipped += 1;
    if (b.summary) {
      for (const c of b.summary.candidates) {
        if (c.judgeScorecard !== null) variantsJudged += 1;
        if (c.judgeSkipReason === 'over-budget' || c.judgeSkipReason === 'over-cap') {
          variantsSkipped += 1;
        }
      }
    }
  }
  return {
    briefsAttempted: briefs.length,
    briefsSucceeded: succeeded,
    briefsFailed: failed,
    briefsSkippedOverBudget: skipped,
    variantsJudged,
    variantsSkipped,
  };
}

function briefIdFromPath(briefPath: string): string {
  return path.basename(briefPath).replace(/\.ya?ml$/i, '');
}

/**
 * Rough cost projection for `--dry-run`.
 *
 * By default (no `briefInfos`): conservative, assumes every brief judges its
 * full variant count (`variantsPerBrief`, default 4) with zero cache hits.
 *
 * When `briefInfos` is provided: projection uses each brief's actual variant
 * count (from its YAML) and the confirmed cache hit count for that brief,
 * so cached variants contribute $0 and only projected misses are costed.
 *
 * Pricing is resolved from `cost-tracker.ts` via `resolveRates(modelDeployment)`
 * — the same lookup `JudgeBudget` uses — so the projection stays in sync with
 * the authoritative pricing table. Falls back to `'gpt-4o'` (the default
 * production judge deployment) when `modelDeployment` is omitted.
 *
 * Note on cache hit accuracy: cache hit counts supplied via `briefInfos` are
 * typically derived by scanning the cache's `.meta.json` files for entries
 * matching each brief's `name`. These are OPTIMISTIC estimates — meta entries
 * may correspond to variant PNGs from a previous non-deterministic generation
 * run, and actual hits in the next run may be lower. The estimates are useful
 * for "is re-running worth it with a warm cache?" but should not be treated as
 * exact accounting.
 */
export interface DryRunBriefInfo {
  /** Actual variant count from this brief's sheet config (`rows × cols − emptyCells`). */
  readonly variantCount: number;
  /**
   * Number of variants for this brief estimated to be judge-cache hits and
   * therefore contributing $0. Zero when cache was not probed.
   *
   * This count is capped at `variantCount` internally to guard against
   * stale meta entries exceeding the current brief's slot count.
   */
  readonly cachedVariants: number;
}

export interface DryRunProjection {
  readonly briefCount: number;
  /**
   * Variants-per-brief used in the projection. When `briefInfos` is
   * provided this is the average across briefs (may be fractional);
   * otherwise it is the flat `variantsPerBrief` fallback value.
   */
  readonly variantsPerBrief: number;
  readonly inputTokensPerCall: number;
  readonly outputTokensPerCall: number;
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
  readonly projectedUsd: number;
  /** Total variant judge calls projected to be issued (excludes cache hits). */
  readonly variantCallsProjected: number;
  /**
   * Variant slots projected to be served from the judge cache at $0 each.
   * Zero when cache probing was not performed.
   */
  readonly cacheHitCount: number;
}

export interface DryRunInputs {
  /**
   * Number of briefs. Used as the fallback `briefCount` in the output when
   * `briefInfos` is not provided. When `briefInfos` IS provided with at least
   * one entry, the output `briefCount` is always `briefInfos.length` — the
   * two are expected to match, but `briefInfos.length` wins to avoid silent
   * divergence if they differ.
   */
  readonly briefCount: number;
  /**
   * Azure vision deployment name (e.g. `gpt-4o-vision`). Used to resolve
   * pricing via `resolveRates()` from `cost-tracker.ts` — the same path
   * `JudgeBudget` uses. Falls back to `'gpt-4o'` when omitted.
   */
  readonly modelDeployment?: string;
  /**
   * Per-brief variant counts and confirmed cache hits. When provided,
   * overrides `variantsPerBrief` and enables per-brief accuracy + cache
   * awareness. When omitted, falls back to the flat `variantsPerBrief`
   * (default 4) with 0 assumed cache hits.
   */
  readonly briefInfos?: ReadonlyArray<DryRunBriefInfo>;
  /**
   * Fallback variants-per-brief used when `briefInfos` is not provided.
   * Default 4.
   */
  readonly variantsPerBrief?: number;
  readonly inputTokensPerCall?: number;
  readonly outputTokensPerCall?: number;
  /**
   * @deprecated Pass `modelDeployment` instead. Explicit rate overrides
   * are still honoured so existing test fixtures continue to work.
   */
  readonly inputPerMillionUsd?: number;
  /**
   * @deprecated Pass `modelDeployment` instead. Explicit rate overrides
   * are still honoured so existing test fixtures continue to work.
   */
  readonly outputPerMillionUsd?: number;
}

export function projectDryRunCost(inputs: DryRunInputs): DryRunProjection {
  const inputTokensPerCall = inputs.inputTokensPerCall ?? 1500;
  const outputTokensPerCall = inputs.outputTokensPerCall ?? 80;

  // Resolve pricing from cost-tracker.ts so the projection stays in sync
  // with the authoritative PRICING table. Explicit override fields win over
  // the deployment lookup (backward compat with existing test fixtures).
  const rates = resolveRates(inputs.modelDeployment ?? 'gpt-4o');
  const inputPerMillionUsd = inputs.inputPerMillionUsd ?? rates.inputPerMillion;
  const outputPerMillionUsd = inputs.outputPerMillionUsd ?? rates.outputPerMillion;

  const perCallUsd =
    (inputTokensPerCall / 1_000_000) * inputPerMillionUsd +
    (outputTokensPerCall / 1_000_000) * outputPerMillionUsd;

  let variantCallsProjected: number;
  let cacheHitCount: number;
  let variantsPerBrief: number;

  if (inputs.briefInfos !== undefined && inputs.briefInfos.length > 0) {
    let totalVariants = 0;
    let totalCacheHits = 0;
    for (const info of inputs.briefInfos) {
      totalVariants += info.variantCount;
      // Cap cached variants at the brief's actual variant count to guard
      // against stale meta entries that exceed the current sheet size.
      totalCacheHits += Math.min(info.cachedVariants, info.variantCount);
    }
    cacheHitCount = totalCacheHits;
    variantCallsProjected = Math.max(0, totalVariants - totalCacheHits);
    // Report average variants per brief for the summary line.
    variantsPerBrief = totalVariants / inputs.briefInfos.length;
  } else {
    const fallbackVariantsPerBrief = inputs.variantsPerBrief ?? 4;
    variantsPerBrief = fallbackVariantsPerBrief;
    variantCallsProjected = fallbackVariantsPerBrief * inputs.briefCount;
    cacheHitCount = 0;
  }

  const projectedUsd = perCallUsd * variantCallsProjected;

  return {
    briefCount: inputs.briefInfos !== undefined ? inputs.briefInfos.length : inputs.briefCount,
    variantsPerBrief,
    inputTokensPerCall,
    outputTokensPerCall,
    inputPerMillionUsd,
    outputPerMillionUsd,
    projectedUsd,
    variantCallsProjected,
    cacheHitCount,
  };
}
