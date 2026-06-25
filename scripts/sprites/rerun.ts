/**
 * Re-run PostProcess and Judge over an ALREADY-GENERATED run, without
 * regenerating (or discarding) the expensive raw sheet.
 *
 * The 7-stage workflow (ADR 0023) splits the old monolithic Generate stage
 * into Generate (produce + persist the sheet) and two re-runnable refinement
 * stages:
 *
 *   - PostProcess — re-slice the stored sheet (content-aware, ADR 0018) and
 *     re-post-process + re-score every variant with tweakable options. The
 *     raw sheet is the durable source artifact; reprocessing overwrites the
 *     `processed/**` + `summary.json` artifacts in place.
 *   - Judge — re-rank variants with the VLM judge over the stored
 *     `processed/NN.png`. Re-runnable and, with `force`, able to judge
 *     variants that failed their sensors.
 *
 * Both stages share the SAME per-variant pipeline as a fresh `generateOne`
 * (`./run-pipeline.ts`), so a re-run reproduces generation-time artifacts
 * byte-for-byte — the "one code path" discipline ADR 0018 applied to slicing.
 *
 * This module is deliberately decoupled from the Fastify sidecar: callers
 * pass an already-resolved `brief`/`palette` (and references/style guide for
 * judging) plus the loaded `RunSummary`, so every function here is unit
 * testable against an in-memory/local `RunStore` with no HTTP or brief-file
 * IO. The sidecar endpoints own request parsing, brief re-materialisation,
 * and the CI refusal; this module owns the artifact math.
 */

import type { Brief, PaletteColors } from './brief-schema.js';
import type { JudgeBudget } from './cost-tracker.js';
import { computeDiversity } from './diversity.js';
import type { JudgeCache } from './judge-cache.js';
import type { JudgeScorecard } from './judge.js';
import {
  pickChosen,
  rankCandidates,
  type JudgeSkipReason,
  type RunSummary,
  type RunSummaryEntry,
} from './run-artifacts.js';
import {
  assembleSummaryEntries,
  postprocessScoreAndStoreVariant,
  runJudgePass,
  type ProcessedVariant,
} from './run-pipeline.js';
import type { PostprocessOptions } from './postprocess.js';
import type { VisionProvider } from './provider/vision-types.js';
import { sliceSheetFromBrief } from './slice-sheet.js';
import type { RunStore } from './store/types.js';

const pad2 = (n: number): string => String(n).padStart(2, '0');

export type RerunErrorKind =
  | 'run-not-found'
  | 'summary-invalid'
  | 'sheet-not-found'
  | 'unsupported-sheet-filename'
  | 'slice-failed'
  | 'processed-missing';

/**
 * Domain error for the re-run path. The sidecar maps `kind` to an HTTP
 * status (mirroring how `ApproveError` is handled in the approve route).
 */
export class RerunError extends Error {
  constructor(
    readonly kind: RerunErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'RerunError';
  }
}

export interface RerunResult {
  readonly summary: RunSummary;
  /** Store-resolved path/URL to the rewritten `summary.json`. */
  readonly summaryPath: string;
  /** Which sheet file the run was derived from (PostProcess only). */
  readonly sheetFile?: string;
}

const SHEET_RE = /^sheet-\d+\.png$/i;

/**
 * Load + parse a run's `summary.json` from the store. Throws `RerunError`
 * with `run-not-found` when the run is absent and `summary-invalid` when the
 * JSON is corrupt. Exported so the sidecar can read `briefPath` (to resolve
 * the brief) from the same parse the re-run will reuse.
 */
export async function loadRunSummary(
  store: RunStore,
  briefId: string,
  runId: string,
): Promise<RunSummary> {
  const summaryKey = `${briefId}/${runId}/summary.json`;
  if (!(await store.has(summaryKey))) {
    throw new RerunError('run-not-found', `run ${briefId}/${runId} not found`);
  }
  try {
    return JSON.parse((await store.get(summaryKey)).toString('utf8')) as RunSummary;
  } catch {
    throw new RerunError(
      'summary-invalid',
      `summary.json for ${briefId}/${runId} is not valid JSON`,
    );
  }
}

/**
 * Pick the run's source sheet. Defaults to the newest sheet (the last attempt
 * to land), matching `/api/slice-map`. An explicit `requestedSheet` must be a
 * `sheet-NN.png` filename that exists in the run.
 */
export async function resolveRunSheet(
  store: RunStore,
  briefId: string,
  runId: string,
  requestedSheet?: string,
): Promise<{ sheetFile: string; sheetPng: Buffer }> {
  const runPrefix = `${briefId}/${runId}/`;
  const keys = await store.list(runPrefix);
  const sheetFiles = keys
    .filter((key) => SHEET_RE.test(key.slice(runPrefix.length)))
    .map((key) => key.slice(runPrefix.length))
    .sort((a, b) => a.localeCompare(b));
  if (sheetFiles.length === 0) {
    throw new RerunError('sheet-not-found', `no sheet found for ${briefId}/${runId}`);
  }
  let sheetFile = sheetFiles[sheetFiles.length - 1]!;
  if (typeof requestedSheet === 'string' && requestedSheet.length > 0) {
    if (!SHEET_RE.test(requestedSheet)) {
      throw new RerunError('unsupported-sheet-filename', `bad sheet filename: ${requestedSheet}`);
    }
    if (!sheetFiles.includes(requestedSheet)) {
      throw new RerunError('sheet-not-found', `sheet ${requestedSheet} not in ${briefId}/${runId}`);
    }
    sheetFile = requestedSheet;
  }
  return { sheetFile, sheetPng: await store.get(`${runPrefix}${sheetFile}`) };
}

export interface RepostprocessArgs {
  readonly store: RunStore;
  readonly briefId: string;
  readonly runId: string;
  /** Loaded run summary (from {@link loadRunSummary}). */
  readonly summary: RunSummary;
  readonly brief: Brief;
  readonly palette: PaletteColors;
  /** Tweakable post-processing options. Omit for generation defaults. */
  readonly options?: PostprocessOptions;
  /** Explicit `sheet-NN.png`; defaults to the newest sheet. */
  readonly sheetFile?: string;
}

/**
 * Re-run PostProcess over a stored run: re-slice the source sheet, then
 * re-post-process + re-score every variant through the shared pipeline and
 * overwrite the `processed/**` + `summary.json` artifacts.
 *
 * Judge verdicts are RESET — the prior verdicts judged different pixels, so
 * they're stale the moment we reprocess. Each candidate comes back with
 * `judgeScorecard: null`, `judgeSkipReason: null`, and `combinedPassed`
 * gated on sensors alone. The operator then re-runs Judge explicitly.
 */
export async function repostprocessRun(args: RepostprocessArgs): Promise<RerunResult> {
  const { store, briefId, runId, summary, brief, palette } = args;
  const storeKey = (rel: string): string => `${briefId}/${runId}/${rel}`;

  const { sheetFile, sheetPng } = await resolveRunSheet(store, briefId, runId, args.sheetFile);

  let sliced: Buffer[];
  try {
    sliced = sliceSheetFromBrief(sheetPng, brief);
  } catch (err) {
    throw new RerunError('slice-failed', err instanceof Error ? err.message : String(err));
  }

  const variants: ProcessedVariant[] = [];
  const processedBuffers: Buffer[] = [];
  for (let i = 0; i < sliced.length; i++) {
    const variant = await postprocessScoreAndStoreVariant({
      store,
      storeKey,
      index: i,
      raw: sliced[i]!,
      brief,
      palette,
      ...(args.options ? { options: args.options } : {}),
    });
    variants.push(variant);
    processedBuffers.push(variant.processed);
  }

  // judgeEnabled=false ⇒ combinedPassed gates on sensors only; the empty
  // maps null out every judge verdict (reset after reprocessing).
  const entries = assembleSummaryEntries({
    variants,
    judgePlan: new Map<number, JudgeScorecard | null>(),
    judgeSkipReason: new Map<number, JudgeSkipReason | null>(),
    judgeEnabled: false,
  });
  const ranked = rankCandidates(entries);

  return writeRunSummary(store, storeKey, summary, {
    candidates: ranked,
    diversity: computeDiversity(processedBuffers),
    chosen: pickChosen(ranked, brief),
    judgeBudget: null,
    judgeCache: null,
    extra: { sheetFile },
  });
}

export interface RejudgeArgs {
  readonly store: RunStore;
  readonly briefId: string;
  readonly runId: string;
  readonly summary: RunSummary;
  readonly brief: Brief;
  readonly referencePngs: ReadonlyArray<Buffer>;
  readonly styleGuide: string;
  readonly visionProvider: VisionProvider;
  /** Judge sensor-failed variants too (override the sensor gate). */
  readonly force?: boolean;
  /** Restrict the re-judge to these variant indexes; others keep their prior verdict. */
  readonly variantIndexes?: ReadonlyArray<number>;
  readonly judgeBudget?: JudgeBudget | null;
  readonly judgeCache?: JudgeCache | null;
  readonly env?: NodeJS.ProcessEnv;
  readonly now?: () => Date;
}

/**
 * Re-run Judge over a stored run's `processed/NN.png` without touching the
 * pixels. Judging is treated as enabled (the operator asked for it
 * explicitly), so `combinedPassed` requires a passing judge verdict.
 *
 * A partial re-judge (`variantIndexes`) judges only the named variants and
 * MERGES the new verdicts over the prior `summary.json`, so untouched
 * variants keep their existing verdict. With `force`, sensor-failed variants
 * become judge-eligible.
 */
export async function rejudgeRun(args: RejudgeArgs): Promise<RerunResult> {
  const { store, briefId, runId, summary, brief } = args;
  const storeKey = (rel: string): string => `${briefId}/${runId}/${rel}`;

  // Rebuild the per-variant pipeline records from the stored summary +
  // processed PNGs (in index order so diversity matches generation time).
  const ordered = [...summary.candidates].sort((a, b) => a.index - b.index);
  const variants: ProcessedVariant[] = [];
  for (const entry of ordered) {
    const processedKey = storeKey(`processed/${pad2(entry.index)}.png`);
    if (!(await store.has(processedKey))) {
      throw new RerunError(
        'processed-missing',
        `processed/${pad2(entry.index)}.png missing for ${briefId}/${runId}; re-run PostProcess first`,
      );
    }
    variants.push(toProcessedVariant(entry, await store.get(processedKey)));
  }

  const indexSet =
    args.variantIndexes && args.variantIndexes.length > 0
      ? new Set(args.variantIndexes)
      : undefined;

  const { judgePlan, judgeSkipReason } = await runJudgePass({
    variants,
    judgeEnabled: true,
    brief,
    referencePngs: args.referencePngs,
    styleGuide: args.styleGuide,
    visionProvider: args.visionProvider,
    store,
    storeKey,
    ...(args.force !== undefined ? { force: args.force } : {}),
    ...(indexSet ? { variantIndexes: indexSet } : {}),
    ...(args.judgeBudget ? { judgeBudget: args.judgeBudget } : {}),
    ...(args.judgeCache ? { judgeCache: args.judgeCache } : {}),
    ...(args.env ? { env: args.env } : {}),
    ...(args.now ? { now: args.now } : {}),
  });

  // Seed the merge with the prior verdicts so a partial re-judge leaves
  // untouched variants exactly as they were, then overlay the fresh verdicts.
  const mergedPlan = new Map<number, JudgeScorecard | null>();
  const mergedReason = new Map<number, JudgeSkipReason | null>();
  for (const entry of ordered) {
    mergedPlan.set(entry.index, entry.judgeScorecard);
    mergedReason.set(entry.index, entry.judgeSkipReason);
  }
  for (const [index, scorecard] of judgePlan) mergedPlan.set(index, scorecard);
  for (const [index, reason] of judgeSkipReason) mergedReason.set(index, reason);

  const entries = assembleSummaryEntries({
    variants,
    judgePlan: mergedPlan,
    judgeSkipReason: mergedReason,
    judgeEnabled: true,
  });
  const ranked = rankCandidates(entries);

  const budgetSnap = args.judgeBudget ? args.judgeBudget.snapshot() : null;
  return writeRunSummary(store, storeKey, summary, {
    candidates: ranked,
    diversity: computeDiversity(variants.map((v) => v.processed)),
    chosen: pickChosen(ranked, brief),
    judgeBudget: budgetSnap
      ? {
          budgetUsd: budgetSnap.budgetUsd,
          spentUsd: budgetSnap.spentUsd,
          remainingUsd:
            typeof budgetSnap.remainingUsd === 'number'
              ? budgetSnap.remainingUsd
              : Number.POSITIVE_INFINITY,
          callCount: budgetSnap.callCount,
          callsThisRun: budgetSnap.callsThisRun,
          callsSkippedDueToBudget: budgetSnap.callsSkippedDueToBudget,
        }
      : null,
    judgeCache: args.judgeCache ? { ...args.judgeCache.stats } : null,
  });
}

/** Reconstruct a {@link ProcessedVariant} from a stored summary entry + its processed PNG. */
function toProcessedVariant(entry: RunSummaryEntry, processed: Buffer): ProcessedVariant {
  return {
    index: entry.index,
    score: entry.score,
    outOf: entry.outOf,
    breakdown: entry.breakdown,
    passed: entry.passed,
    rawPath: entry.rawPath,
    processedPath: entry.processedPath,
    scorecardPath: entry.scorecardPath,
    derivedAnchor: entry.derivedAnchor,
    derivedAnchors: entry.derivedAnchors,
    anchorSidecarPath: entry.anchorSidecarPath,
    centerOfGravitySidecarPath: entry.centerOfGravitySidecarPath,
    anchorOverlayPath: entry.anchorOverlayPath,
    processed,
  };
}

/** Overwrite `summary.json` with re-derived candidate/judge fields, preserving run identity. */
async function writeRunSummary(
  store: RunStore,
  storeKey: (rel: string) => string,
  prior: RunSummary,
  patch: {
    candidates: RunSummaryEntry[];
    diversity: RunSummary['diversity'];
    chosen: RunSummary['chosen'];
    judgeBudget: RunSummary['judgeBudget'];
    judgeCache: RunSummary['judgeCache'];
    extra?: { sheetFile?: string };
  },
): Promise<RerunResult> {
  const summary: RunSummary = {
    ...prior,
    candidates: patch.candidates,
    diversity: patch.diversity,
    chosen: patch.chosen,
    judgeBudget: patch.judgeBudget,
    judgeCache: patch.judgeCache,
  };
  const summaryKey = storeKey('summary.json');
  await store.put(summaryKey, Buffer.from(`${JSON.stringify(summary, null, 2)}\n`));
  return {
    summary,
    summaryPath: store.resolve(summaryKey),
    ...(patch.extra?.sheetFile ? { sheetFile: patch.extra.sheetFile } : {}),
  };
}
