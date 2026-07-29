/**
 * Shared per-variant pipeline used by BOTH the fresh-generation orchestrator
 * (`generateOne`) and the re-run endpoints (`repostprocessRun` / `rejudgeRun`).
 *
 * Centralising the post-process → score → store-artifacts block and the gated
 * VLM judge pass here guarantees a fresh run and a re-run over the SAME stored
 * sheet produce byte-identical artifacts — the same "one code path" discipline
 * ADR 0018 applied to slicing, now applied to post-processing and judging.
 *
 * Everything here is impure (it writes through the injected `RunStore` and the
 * judge calls a provider), but the pure pieces it composes (`postprocessWithTrace`,
 * `scoreCandidate`, `judgeVariant`) keep their own unit tests.
 */

import { PNG } from 'pngjs';
import { buildAnchorOverlay } from './anchor-overlay.js';
import type { Brief, PaletteColors } from './brief-schema.js';
import type { JudgeBudget } from './cost-tracker.js';
import type { JudgeCache } from './judge-cache.js';
import { judgeVariant, type JudgeScorecard } from './judge.js';
import { type PostprocessOptions, postprocessWithTrace } from './postprocess.js';
import type { ManualAnchorOverride, ManualWeaponAnchorOverride } from './postprocess-overrides.js';
import { scoreCandidate } from './score-candidate.js';
import type { JudgeSkipReason, RunSummaryEntry } from './run-artifacts.js';
import type { RunStore } from './store/types.js';
import type { VisionProvider } from './provider/vision-types.js';
import { createLogger } from '../../src/shared/logger.js';
import { ANCHOR_CENTER_OF_MASS_SENSOR, ANCHOR_DERIVABLE_SENSOR } from './score-candidate.js';

const logger = createLogger('infra:run-pipeline');

const pad2 = (n: number): string => String(n).padStart(2, '0');

/**
 * One post-processed, sensor-scored variant plus the resolved store paths to
 * its written artifacts. Mirrors the per-variant `RunSummaryEntry` fields that
 * are decided by sensors alone (the judge fields are layered on later by
 * {@link assembleSummaryEntries}). The decoded `processed` buffer is kept so
 * the diversity pass and the judge pass don't re-read it from the store.
 */
export interface ProcessedVariant {
  readonly index: number;
  readonly score: number;
  readonly outOf: number;
  readonly breakdown: RunSummaryEntry['breakdown'];
  readonly passed: boolean;
  readonly rawPath: string;
  readonly processedPath: string;
  readonly scorecardPath: string;
  readonly derivedAnchor: RunSummaryEntry['derivedAnchor'];
  readonly derivedAnchors: RunSummaryEntry['derivedAnchors'];
  readonly anchorSidecarPath: string | null;
  readonly centerOfGravitySidecarPath: string | null;
  readonly anchorOverlayPath: string;
  readonly processed: Buffer;
}

export interface ProcessVariantArgs {
  readonly store: RunStore;
  /** Maps a run-relative path (e.g. `raw/00.png`) to a full store key. */
  readonly storeKey: (rel: string) => string;
  readonly index: number;
  readonly raw: Buffer;
  readonly brief: Brief;
  readonly palette: PaletteColors;
  /** Post-processing tweaks. Omit for generation defaults. */
  readonly options?: PostprocessOptions;
  /** Optional persisted manual anchor override for this variant. */
  readonly manualAnchor?: ManualAnchorOverride | null;
  /**
   * Optional weapon-anchor override. When present (and applicable to this
   * variant) a `NN.anchor.weapon.json` sidecar is written alongside the other
   * per-variant artifacts so the approval step can read it.
   */
  readonly manualWeaponAnchor?: ManualWeaponAnchorOverride | null;
  /** Optional provenance references surfaced in pipeline manifests. */
  readonly traceRefs?: {
    readonly overrideProfilePath?: string | null;
    readonly effectivePipelineSnapshotPath?: string | null;
  };
}

/**
 * Post-process one raw cell, score it, and write every per-variant artifact
 * (raw PNG, processed PNG, sensor scorecard, pipeline-step PNGs + index, anchor
 * sidecars, and the anchor-overlay PNG) through the store. Returns the
 * {@link ProcessedVariant} the summary is assembled from.
 *
 * Extracted verbatim from `generateOne` so re-running post-processing over a
 * stored sheet writes byte-identical artifacts.
 */
export async function postprocessScoreAndStoreVariant(
  args: ProcessVariantArgs,
): Promise<ProcessedVariant> {
  const { store, storeKey, index, raw, brief, palette } = args;
  const traced = postprocessWithTrace(raw, brief, palette, args.options ?? {});
  const manualAnchorForVariant =
    args.manualAnchor &&
    (args.manualAnchor.applyToAllVariants === true || args.manualAnchor.variantIndex === index)
      ? args.manualAnchor
      : null;
  const processed = traced.finalPng;
  const scorecard = applyManualAnchorToScorecard(
    scoreCandidate(processed, brief, palette),
    manualAnchorForVariant,
  );
  const id = pad2(index);

  await store.put(storeKey(`raw/${id}.png`), raw);
  await store.put(storeKey(`processed/${id}.png`), processed);
  await store.put(
    storeKey(`processed/${id}.scorecard.json`),
    Buffer.from(`${JSON.stringify(scorecard, null, 2)}\n`),
  );
  const pipelineSteps = traced.steps.map((step, idx) => {
    const file = `${id}.step-${String(idx + 1).padStart(2, '0')}-${step.id}.png`;
    return {
      id: step.id,
      label: step.label,
      file,
      png: step.png,
      moduleId: step.moduleId,
      skipped: step.skipped,
    };
  });
  for (const step of pipelineSteps) {
    await store.put(storeKey(`processed/${step.file}`), step.png);
  }
  await store.put(
    storeKey(`processed/${id}.pipeline.json`),
    Buffer.from(
      `${JSON.stringify(
        {
          profile: 'default',
          ...(args.traceRefs?.overrideProfilePath
            ? { overrideProfilePath: args.traceRefs.overrideProfilePath }
            : {}),
          ...(args.traceRefs?.effectivePipelineSnapshotPath
            ? { effectivePipelineSnapshotPath: args.traceRefs.effectivePipelineSnapshotPath }
            : {}),
          steps: pipelineSteps.map((step) => ({
            id: step.id,
            label: step.label,
            file: step.file,
            moduleId: step.moduleId,
            skipped: step.skipped,
          })),
        },
        null,
        2,
      )}\n`,
    ),
  );

  let anchorSidecarPath: string | null = null;
  if (scorecard.derivedAnchor) {
    const anchorKey = storeKey(`processed/${id}.anchor.json`);
    await store.put(
      anchorKey,
      Buffer.from(
        `${JSON.stringify({ x: scorecard.derivedAnchor.x, y: scorecard.derivedAnchor.y, source: 'derived' as const }, null, 2)}\n`,
      ),
    );
    anchorSidecarPath = store.resolve(anchorKey);
  } else {
    await store.remove(storeKey(`processed/${id}.anchor.json`));
  }
  if (manualAnchorForVariant) {
    await store.put(
      storeKey(`processed/${id}.manual-anchor.json`),
      Buffer.from(
        `${JSON.stringify(
          {
            x: manualAnchorForVariant.x,
            y: manualAnchorForVariant.y,
            variantIndex: manualAnchorForVariant.variantIndex,
            ...(manualAnchorForVariant.applyToAllVariants === true
              ? { applyToAllVariants: true }
              : {}),
            source: 'manual' as const,
            updatedAt: manualAnchorForVariant.updatedAt,
          },
          null,
          2,
        )}\n`,
      ),
    );
  } else {
    await store.remove(storeKey(`processed/${id}.manual-anchor.json`));
  }
  let centerOfGravitySidecarPath: string | null = null;
  if (scorecard.derivedAnchors.centerOfGravity) {
    const cogKey = storeKey(`processed/${id}.anchor.cog.json`);
    await store.put(
      cogKey,
      Buffer.from(
        `${JSON.stringify(
          {
            x: scorecard.derivedAnchors.centerOfGravity.x,
            y: scorecard.derivedAnchors.centerOfGravity.y,
            source: 'derived' as const,
          },
          null,
          2,
        )}\n`,
      ),
    );
    centerOfGravitySidecarPath = store.resolve(cogKey);
  } else {
    await store.remove(storeKey(`processed/${id}.anchor.cog.json`));
  }

  // Weapon anchor sidecar: written when the editor has set an explicit weapon
  // anchor for this variant (or for all variants via applyToAllVariants).
  // Cleared on reprocess when no weapon anchor is in effect so stale values
  // never survive a postprocess cycle.
  const weaponAnchorForVariant =
    args.manualWeaponAnchor &&
    (args.manualWeaponAnchor.applyToAllVariants === true ||
      args.manualWeaponAnchor.variantIndex === index)
      ? args.manualWeaponAnchor
      : null;
  if (weaponAnchorForVariant) {
    await store.put(
      storeKey(`processed/${id}.anchor.weapon.json`),
      Buffer.from(
        `${JSON.stringify(
          {
            x: weaponAnchorForVariant.x,
            y: weaponAnchorForVariant.y,
            source: 'manual' as const,
          },
          null,
          2,
        )}\n`,
      ),
    );
  } else {
    await store.remove(storeKey(`processed/${id}.anchor.weapon.json`));
  }

  function applyManualAnchorToScorecard(
    scorecard: ReturnType<typeof scoreCandidate>,
    manualAnchor: ManualAnchorOverride | null,
  ): ReturnType<typeof scoreCandidate> {
    if (!manualAnchor) return scorecard;
    const breakdown = scorecard.breakdown.map((entry) => {
      const isAnchorSensor =
        entry.sensor === 'anchor-opaque' ||
        entry.sensor === ANCHOR_DERIVABLE_SENSOR ||
        entry.sensor === ANCHOR_CENTER_OF_MASS_SENSOR;
      if (!isAnchorSensor || entry.ok) return entry;
      return { ok: true as const, sensor: entry.sensor };
    });
    const score = breakdown.filter((entry) => entry.ok).length;
    return {
      ...scorecard,
      score,
      outOf: breakdown.length,
      passed: score === breakdown.length,
      breakdown,
      derivedAnchor: { x: manualAnchor.x, y: manualAnchor.y },
      derivedAnchors: {
        hold: { x: manualAnchor.x, y: manualAnchor.y },
        centerOfGravity: scorecard.derivedAnchors.centerOfGravity,
      },
    };
  }

  const { width: overlayW, height: overlayH } = (() => {
    const img = PNG.sync.read(processed);
    return { width: img.width, height: img.height };
  })();
  const overlayKey = storeKey(`processed/${id}.anchor-overlay.png`);
  await store.put(
    overlayKey,
    buildAnchorOverlay({
      width: overlayW,
      height: overlayH,
      anchor: scorecard.derivedAnchor
        ? { x: scorecard.derivedAnchor.x, y: scorecard.derivedAnchor.y }
        : null,
    }),
  );

  return {
    index,
    score: scorecard.score,
    outOf: scorecard.outOf,
    breakdown: scorecard.breakdown,
    passed: scorecard.passed,
    rawPath: store.resolve(storeKey(`raw/${id}.png`)),
    processedPath: store.resolve(storeKey(`processed/${id}.png`)),
    scorecardPath: store.resolve(storeKey(`processed/${id}.scorecard.json`)),
    derivedAnchor: scorecard.derivedAnchor,
    derivedAnchors: scorecard.derivedAnchors,
    anchorSidecarPath,
    centerOfGravitySidecarPath,
    anchorOverlayPath: store.resolve(overlayKey),
    processed,
  };
}

export interface JudgePassArgs {
  /** Variants to consider. `generateOne` passes all; a re-run may pass a subset. */
  readonly variants: ReadonlyArray<ProcessedVariant>;
  /**
   * Whether judging happens at all. `generateOne` passes
   * `brief.judge.enabled`; the manual Judge stage always passes `true`.
   */
  readonly judgeEnabled: boolean;
  readonly brief: Brief;
  readonly referencePngs: ReadonlyArray<Buffer>;
  readonly styleGuide: string;
  readonly visionProvider: VisionProvider | null;
  readonly store: RunStore;
  readonly storeKey: (rel: string) => string;
  readonly judgeBudget?: JudgeBudget | null;
  readonly judgeCache?: JudgeCache | null;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
  readonly warn?: (message: string) => void;
  /**
   * Deprecated compatibility flag. Judging now considers all variants by
   * default (subject to maxVariants + budget caps), regardless of sensor pass.
   */
  readonly force?: boolean;
  /**
   * Restrict judging to these variant indexes. When provided, ONLY these
   * variants get a plan/skip entry (others are left untouched so a caller can
   * preserve their prior verdicts). Omit to consider every variant.
   */
  readonly variantIndexes?: ReadonlySet<number>;
  /**
   * Cap the number of judged variants (highest sensor score first). Overrides
   * `brief.judge.maxVariants` when set. Must be a finite integer in `1..64`
   * (the brief schema's own `judge.maxVariants` range).
   */
  readonly judgeMaxVariants?: number;
  /**
   * Number of variants to judge in parallel. Defaults to `1` (the sequential
   * loop, byte-identical to prior behaviour). Must be a finite integer `>= 1`.
   * Values `> 1` require NO `judgeBudget` and NO `judgeCache` — both introduce
   * cross-call races (a shared budget gate, and a check-then-call cache miss) —
   * so `runJudgePass` throws if either is supplied with `concurrency > 1`. The
   * only production caller that sets this is the theme-equipment variant-approval
   * rejudge, which passes neither.
   */
  readonly concurrency?: number;
}

export interface JudgePassResult {
  readonly judgePlan: Map<number, JudgeScorecard | null>;
  readonly judgeSkipReason: Map<number, JudgeSkipReason | null>;
}

/**
 * Run the gated VLM judge over the considered variants.
 *
 * Eligibility: all considered variants are judgeable by default, capped at
 * `brief.judge.maxVariants` after ranking by sensor score. The
 * per-call budget gate and judge cache behave exactly as in a fresh run.
 *
 * The returned maps only contain entries for the CONSIDERED variants (all of
 * them when `variantIndexes` is omitted), so a partial re-judge can merge them
 * over prior verdicts.
 */
export async function runJudgePass(args: JudgePassArgs): Promise<JudgePassResult> {
  const judgePlan = new Map<number, JudgeScorecard | null>();
  const judgeSkipReason = new Map<number, JudgeSkipReason | null>();
  const { variants, brief } = args;

  const considered = (e: ProcessedVariant): boolean =>
    args.variantIndexes === undefined || args.variantIndexes.has(e.index);
  const consideredVariants = variants.filter(considered);

  if (!args.judgeEnabled) {
    for (const e of consideredVariants) {
      judgePlan.set(e.index, null);
      judgeSkipReason.set(e.index, 'judge-disabled');
    }
    return { judgePlan, judgeSkipReason };
  }

  // Resolve + validate the judged-variant cap. A caller override wins over the
  // brief's own cap; both must be a finite integer in the brief schema's range.
  const rawCap = args.judgeMaxVariants ?? brief.judge.maxVariants;
  if (!Number.isInteger(rawCap) || rawCap < 1 || rawCap > 64) {
    throw new Error(`runJudgePass: judge cap must be an integer in 1..64 (got ${String(rawCap)}).`);
  }

  // Decide which considered variants are judge-eligible. Cap by the resolved
  // cap to bound cost; ranking by sensor score spends on the best candidates.
  const ordered = [...consideredVariants].sort((a, b) => b.score - a.score || a.index - b.index);
  const eligible = new Set(ordered.slice(0, rawCap).map((e) => e.index));

  for (const e of consideredVariants) {
    if (!eligible.has(e.index)) {
      judgePlan.set(e.index, null);
      judgeSkipReason.set(e.index, 'over-cap');
    }
  }

  // Validate concurrency. 1 = the historical sequential loop (below). Values
  // > 1 fan out a bounded worker pool and are incompatible with the budget gate
  // and the judge cache, both of which race across concurrent judge calls.
  const concurrency = args.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(
      `runJudgePass: concurrency must be an integer >= 1 (got ${String(concurrency)}).`,
    );
  }
  if (concurrency > 1 && (args.judgeBudget || args.judgeCache)) {
    throw new Error(
      'runJudgePass: concurrency > 1 is incompatible with judgeBudget/judgeCache ' +
        '(both race across concurrent judge calls); use concurrency 1 for ' +
        'budgeted or cached runs.',
    );
  }

  const providerMissingMessage =
    'runJudgePass: judging requested but no vision provider supplied. Configure ' +
    'AZURE_OPENAI_VISION_DEPLOYMENT (and SPRITES_VISION_PROVIDER=azure-openai) or ' +
    'disable judging.';

  // Shared judge-call argument shape. `provider` is passed explicitly (already
  // null-checked by each path) so this stays a pure function of the variant.
  const buildJudgeArgs = (e: ProcessedVariant, provider: VisionProvider) => ({
    processed: e.processed,
    referencePngs: args.referencePngs,
    brief,
    styleGuide: args.styleGuide,
    provider,
    variantIndex: e.index,
    // The judge sidecar (`NN.judge.json`) is written with `writeFileSync`, so
    // `processedDir` must be a real local path. For non-local stores
    // `store.resolve()` returns a blob URL that `path.join` would mangle into
    // an ENOENT path. Omit it off-local: the scorecard is still embedded in
    // the run summary, so no judge data is lost.
    ...(args.store.backend === 'local'
      ? { processedDir: args.store.resolve(args.storeKey('processed')) }
      : {}),
    variantPath: e.processedPath,
    ...(args.judgeCache ? { cache: args.judgeCache } : {}),
    ...(args.now ? { now: args.now } : {}),
    ...(args.env ? { env: args.env } : {}),
  });

  if (concurrency === 1) {
    // Sequential judging keeps Azure rate-limit headroom predictable and makes
    // per-variant errors easy to attribute, same as the generation pipeline.
    for (const e of consideredVariants) {
      if (!eligible.has(e.index)) continue;
      if (!args.visionProvider) {
        throw new Error(providerMissingMessage);
      }
      // Budget gate runs BEFORE the call so a blown budget skips cheaply. Cache
      // hits cost $0 of Azure spend, so they bypass the gate.
      if (args.judgeBudget && args.judgeBudget.wouldExceed() && !args.judgeCache) {
        args.judgeBudget.recordSkip();
        const warn = args.warn ?? logger.warn.bind(logger);
        warn(`judge-budget exhausted: skipping variant ${e.index} (${args.judgeBudget.format()})`);
        judgePlan.set(e.index, null);
        judgeSkipReason.set(e.index, 'over-budget');
        continue;
      }
      const cacheMissesBefore = args.judgeCache?.stats.misses ?? 0;
      const scorecard = await judgeVariant(buildJudgeArgs(e, args.visionProvider));
      const newAzureCall = args.judgeCache
        ? args.judgeCache.stats.misses > cacheMissesBefore
        : true;
      if (newAzureCall && args.judgeBudget && scorecard.usage) {
        args.judgeBudget.recordCall(scorecard.usage);
      }
      judgePlan.set(e.index, scorecard);
      judgeSkipReason.set(e.index, null);
    }
    return { judgePlan, judgeSkipReason };
  }

  // Parallel path (concurrency > 1): a bounded worker pool. No budget and no
  // cache (both rejected above), so there is no cross-call accounting to race —
  // only independent Azure calls whose 429/5xx backoff already lives in the
  // provider transport. On the first error we STOP handing out new work and let
  // every in-flight worker settle before rethrowing, so no judge call starts —
  // or writes a sidecar — after `runJudgePass` has already rejected.
  const eligibleVariants = consideredVariants.filter((e) => eligible.has(e.index));
  const results = new Map<number, JudgeScorecard>();
  let nextIndex = 0;
  let aborted = false;
  let firstError: unknown = null;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (aborted) return;
      // `nextIndex++` is atomic in JS's single-threaded event loop (no await
      // between the read and the increment), so no two workers claim the same
      // variant.
      const cursor = nextIndex++;
      if (cursor >= eligibleVariants.length) return;
      const e = eligibleVariants[cursor];
      if (e === undefined) return;
      if (!args.visionProvider) {
        if (!aborted) {
          aborted = true;
          firstError = new Error(providerMissingMessage);
        }
        return;
      }
      try {
        const scorecard = await judgeVariant(buildJudgeArgs(e, args.visionProvider));
        results.set(e.index, scorecard);
      } catch (err) {
        if (!aborted) {
          aborted = true;
          firstError = err;
        }
        return;
      }
    }
  };
  const workerCount = Math.min(concurrency, eligibleVariants.length);
  // Each worker self-catches, so `Promise.all` never short-circuits: it settles
  // only once every in-flight call has completed, then we rethrow the first
  // error. This is the drain-before-throw guarantee.
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (aborted) {
    throw firstError;
  }
  // Fold results into the maps in `consideredVariants` order so Map iteration
  // order is identical to the sequential path (parallel completion order is
  // otherwise nondeterministic).
  for (const e of consideredVariants) {
    if (!eligible.has(e.index)) continue;
    judgePlan.set(e.index, results.get(e.index) ?? null);
    judgeSkipReason.set(e.index, null);
  }

  return { judgePlan, judgeSkipReason };
}

export interface AssembleEntriesArgs {
  readonly variants: ReadonlyArray<ProcessedVariant>;
  readonly judgePlan: ReadonlyMap<number, JudgeScorecard | null>;
  readonly judgeSkipReason: ReadonlyMap<number, JudgeSkipReason | null>;
  readonly judgeEnabled: boolean;
}

/**
 * Fold each variant's sensor result together with its judge verdict into the
 * final `RunSummaryEntry`, computing the combined sensor+judge pipeline gate.
 *
 * `combinedPassed` requires sensors to pass AND (judging disabled OR a judge
 * verdict that passed) — identical to `generateOne`'s formula, kept in one
 * place so fresh runs and re-runs can't diverge on the gate.
 */
export function assembleSummaryEntries(args: AssembleEntriesArgs): RunSummaryEntry[] {
  const entries: RunSummaryEntry[] = [];
  for (const e of args.variants) {
    const judgeScorecard = args.judgePlan.get(e.index) ?? null;
    const reason = args.judgeSkipReason.get(e.index) ?? null;
    const combinedPassed =
      e.passed && (!args.judgeEnabled || (judgeScorecard !== null && judgeScorecard.passed));
    entries.push({
      index: e.index,
      score: e.score,
      outOf: e.outOf,
      breakdown: e.breakdown,
      passed: e.passed,
      rawPath: e.rawPath,
      processedPath: e.processedPath,
      scorecardPath: e.scorecardPath,
      derivedAnchor: e.derivedAnchor,
      derivedAnchors: e.derivedAnchors,
      anchorSidecarPath: e.anchorSidecarPath,
      centerOfGravitySidecarPath: e.centerOfGravitySidecarPath,
      anchorOverlayPath: e.anchorOverlayPath,
      judgeScorecard,
      judgeSkipReason: reason,
      combinedPassed,
    });
  }
  return entries;
}
