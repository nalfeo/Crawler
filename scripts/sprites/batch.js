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
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { generateOne } from './generate-one.js';
export function makeBatchId(now, seed) {
  const iso = now.toISOString().replace(/[:.]/g, '-').replace(/-+Z$/, 'Z');
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 6);
  return `${iso}-${hash}`;
}
export function batchPaths(outputRoot, batchId) {
  const batchDir = path.join(outputRoot, 'runs', '_batch', batchId);
  return { batchDir, summaryPath: path.join(batchDir, 'batch-summary.json') };
}
/**
 * Run a batch end-to-end. Returns the final summary AND has written the
 * same payload to `<batchDir>/batch-summary.json` (unless `batchDir` is
 * explicitly null).
 */
export async function runBatch(options) {
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
  const generate = options.generate ?? generateOne;
  const briefs = [];
  const writeSnapshot = (finishedAt) => {
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
    const briefPath = options.briefPaths[i];
    const start = Date.now();
    // Pre-flight budget gate. We treat exhaustion as a hard stop on new
    // work — even briefs that don't use the judge get skipped, because
    // the batch CLI exists primarily to drive judged briefs and the
    // alternative (peeking inside each YAML to decide) couples this
    // layer to the schema.
    if (options.judgeBudget && options.judgeBudget.wouldExceed()) {
      const result = {
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
      const generateOptions = {
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
      const result = {
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
      const errorPayload =
        err instanceof Error
          ? { message: err.message, ...(err.stack ? { stack: err.stack } : {}) }
          : { message: String(err) };
      const result = {
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
function composeSummary(args) {
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
function computeTotals(briefs) {
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
function briefIdFromPath(briefPath) {
  return path.basename(briefPath).replace(/\.ya?ml$/i, '');
}
export function projectDryRunCost(inputs) {
  const variantsPerBrief = inputs.variantsPerBrief ?? 4;
  const inputTokensPerCall = inputs.inputTokensPerCall ?? 1500;
  const outputTokensPerCall = inputs.outputTokensPerCall ?? 80;
  // gpt-4o rates from `cost-tracker.ts` — duplicated literally rather
  // than imported so this stays a pure projection helper with no
  // import-cycle risk back into the orchestrator.
  const inputPerMillionUsd = inputs.inputPerMillionUsd ?? 2.5;
  const outputPerMillionUsd = inputs.outputPerMillionUsd ?? 10.0;
  const perCallUsd =
    (inputTokensPerCall / 1_000_000) * inputPerMillionUsd +
    (outputTokensPerCall / 1_000_000) * outputPerMillionUsd;
  const projectedUsd = perCallUsd * variantsPerBrief * inputs.briefCount;
  return {
    briefCount: inputs.briefCount,
    variantsPerBrief,
    inputTokensPerCall,
    outputTokensPerCall,
    inputPerMillionUsd,
    outputPerMillionUsd,
    projectedUsd,
  };
}
//# sourceMappingURL=batch.js.map
