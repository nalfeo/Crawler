/**
 * Batch orchestrator for the sprite pipeline (Phase 3 build 6).
 *
 * Wraps `generateOne` so a directory of briefs can be processed in one
 * command, with a single cross-run `JudgeBudget` + `JudgeCache` instance
 * threaded through every brief. This is the build that makes the cost
 * ceiling actually do work: without batch, the budget is a per-process
 * formality.
 *
 * Design rules:
 *
 *   1. Composable, not coupled. This module imports `generateOne` and
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
 *      inside `generateOne` handles mid-brief exhaustion; this layer
 *      only decides whether to even start.
 */
import type { GenerateOneOptions, GenerateOneResult } from './generate-one.js';
import type { JudgeBudget } from './cost-tracker.js';
import type { JudgeCache } from './judge-cache.js';
import type { RunSummary } from './run-artifacts.js';
/**
 * Options the batch passes through to each `generateOne` call. We deliberately
 * accept the strict subset that varies across briefs/tests, so the batch type
 * doesn't drift if `GenerateOneOptions` grows new fields the batch shouldn't
 * touch.
 */
export type GenerateOneFactory = (options: GenerateOneOptions) => Promise<GenerateOneResult>;
export interface BatchOptions {
  readonly briefPaths: ReadonlyArray<string>;
  readonly repoRoot: string;
  /** Output root for per-brief runs. Defaults to `<repoRoot>/generated`. */
  readonly outputRoot?: string;
  /** Shared across all briefs in the batch — this is the whole point. */
  readonly judgeBudget: JudgeBudget | null;
  readonly judgeCache: JudgeCache | null;
  /** Pass-through generate-one wiring. */
  readonly provider: GenerateOneOptions['provider'];
  readonly textProvider?: GenerateOneOptions['textProvider'];
  readonly visionProvider?: GenerateOneOptions['visionProvider'];
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
   * Test seam: substitute the real `generateOne` for a stub. Defaults to
   * the production import. Lets the batch unit tests assert
   * non-invocation without spinning up a full mock provider stack.
   */
  readonly generate?: GenerateOneFactory;
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
  /** Per-variant skips inside `generateOne` due to over-budget. */
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
/** Path layout for a single batch. Exposed so the CLI + tests agree. */
export interface BatchPaths {
  readonly batchDir: string;
  readonly summaryPath: string;
}
export declare function makeBatchId(now: Date, seed: string): string;
export declare function batchPaths(outputRoot: string, batchId: string): BatchPaths;
/**
 * Run a batch end-to-end. Returns the final summary AND has written the
 * same payload to `<batchDir>/batch-summary.json` (unless `batchDir` is
 * explicitly null).
 */
export declare function runBatch(options: BatchOptions): Promise<BatchSummary>;
/**
 * Rough cost projection for `--dry-run`. Conservative: assumes EVERY
 * brief judges its full variant count using `gpt-4o` rates and the
 * average per-call token usage we've seen across Phase 3. Deliberately
 * does NOT load brief YAMLs (a dry run shouldn't touch the file system
 * beyond glob/stat) — we take a fixed `variantsPerBrief` instead.
 *
 * Inputs use `gpt-4o-vision` pricing as the default deployment because
 * that's the production judge model; callers that know their rates can
 * override.
 */
export interface DryRunProjection {
  readonly briefCount: number;
  readonly variantsPerBrief: number;
  readonly inputTokensPerCall: number;
  readonly outputTokensPerCall: number;
  readonly inputPerMillionUsd: number;
  readonly outputPerMillionUsd: number;
  readonly projectedUsd: number;
}
export interface DryRunInputs {
  readonly briefCount: number;
  readonly variantsPerBrief?: number;
  readonly inputTokensPerCall?: number;
  readonly outputTokensPerCall?: number;
  readonly inputPerMillionUsd?: number;
  readonly outputPerMillionUsd?: number;
}
export declare function projectDryRunCost(inputs: DryRunInputs): DryRunProjection;
//# sourceMappingURL=batch.d.ts.map
