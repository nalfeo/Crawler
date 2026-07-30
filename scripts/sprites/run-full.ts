/**
 * runFull — the one-shot FULL sprite pipeline (generate → postprocess → score
 * → judge → rank), used by the CLI (`sprites:run`) and the batch tooling.
 *
 * GENERATE proper (`generateOne`) stores the raw sheet ONLY (Option B, ADR
 * 0024). `runFull` exists so the developer-facing one-shot tools keep their
 * end-to-end UX: it reuses `generateSheetCore` for the generate + sliceability
 * gate, then runs the SAME shared `run-pipeline.ts` helpers that the explicit
 * PostProcess/Judge re-runs use (`postprocessScoreAndStoreVariant`,
 * `runJudgePass`, `assembleSummaryEntries`). A one-shot run and an explicit
 * generate → postprocess → judge sequence therefore produce byte-identical
 * artifacts — there is exactly one post-process/judge code path (ADR 0018).
 */

import { computeDiversity } from './diversity.js';
import type { JudgeBudget } from './cost-tracker.js';
import type { JudgeCache } from './judge-cache.js';
import {
  generateSheetCore,
  type GenerateOneOptions,
  type GenerateOneResult,
} from './generate-one.js';
import {
  assembleSummaryEntries,
  postprocessScoreAndStoreVariant,
  type ProcessedVariant,
  runJudgePass,
} from './run-pipeline.js';
import {
  EFFECTIVE_PIPELINE_JSON_KEY,
  EFFECTIVE_PIPELINE_YAML_KEY,
  POSTPROCESS_PROFILE_KEY,
  writeEffectivePipelineSnapshot,
  writePostprocessProfile,
} from './postprocess-overrides.js';
import {
  frameSequenceDisabledModules,
  computeFrameSequenceUnionCropRect,
  type PostprocessOptions,
} from './postprocess.js';
import type { VisionProvider } from './provider/vision-types.js';
import { pickChosen, rankCandidates, type RunSummary } from './run-artifacts.js';

export interface RunFullOptions extends GenerateOneOptions {
  /**
   * Optional vision provider for the local-only VLM judge (spec §F4).
   *
   * Required when `brief.judge.enabled === true` — `runFull` throws rather
   * than silently skipping the judge if a brief asked for it but no provider
   * was supplied. The judge is a quality gate; silently dropping it would
   * defeat the whole point. Omitted/null is fine for any brief with
   * `judge.enabled: false`.
   */
  readonly visionProvider?: VisionProvider | null;
  /**
   * Optional cross-run cost ceiling. When supplied, each judge call is gated
   * by `JudgeBudget.wouldExceed()` and the budget records actual spend after a
   * successful call. Variants gated out by the budget appear with
   * `judgeSkipReason: 'over-budget'`. Omit to disable the cost gate.
   */
  readonly judgeBudget?: JudgeBudget | null;
  /**
   * Optional VLM-judge cache. When supplied, judge calls go through the cache;
   * on hit, no provider call is made. The CLI instantiates it so test harnesses
   * can run without ever touching the filesystem cache.
   */
  readonly judgeCache?: JudgeCache | null;
  /** Environment override used by local-only judge checks (primarily tests). */
  readonly env?: NodeJS.ProcessEnv;
}

export type RunFullResult = GenerateOneResult;

export async function runFull(options: RunFullOptions): Promise<RunFullResult> {
  const core = await generateSheetCore(options);
  const {
    store,
    storeKey,
    runDir,
    brief,
    palette,
    referencePngs,
    styleGuide,
    sliced,
    attempts,
    identity,
  } = core;

  const nowIso = (options.now ?? (() => new Date()))().toISOString();
  // Frame-sequence briefs disable trim-and-fit (post-resize per-frame
  // independent trim) to keep every frame at the same canvas mapping.
  // transparent-trim is no longer disabled here: it now uses a shared union
  // bounding box (sharedCropRect below) so all frames are cropped to the SAME
  // tight content region before resizing — this preserves both uniform
  // scale/floor-line AND good content density (no 256×1024 → 16px-wide shrink).
  const postprocessOptions: PostprocessOptions = {
    disabledModules: frameSequenceDisabledModules(brief),
  };
  await writePostprocessProfile(
    store,
    `${identity.brief}/${identity.runId}`,
    postprocessOptions,
    nowIso,
  );
  await writeEffectivePipelineSnapshot({
    store,
    baseKey: `${identity.brief}/${identity.runId}`,
    brief,
    options: postprocessOptions,
    manualAnchor: null,
    manualWeaponAnchor: null,
    facing: null,
    nowIso,
  });

  // For frame-sequence briefs: compute the union opaque bbox across all raw
  // frames (after background removal) so transparent-trim gives every pose
  // the same crop-to-canvas mapping. Not persisted to the profile because it
  // must be freshly derived from the current raw frames on each run/rerun.
  const sharedCropRect = brief.frameSequence.enabled
    ? computeFrameSequenceUnionCropRect(sliced)
    : null;
  const postprocessOptionsWithCrop: PostprocessOptions = sharedCropRect
    ? { ...postprocessOptions, sharedCropRect }
    : postprocessOptions;

  // --- Postprocess + score each variant via the shared run pipeline. ---
  // Keep the post-processed buffers so the diversity pass doesn't re-read
  // every variant from the store. Sensor scoring + artifact writes live in
  // `postprocessScoreAndStoreVariant` so a re-run reproduces them byte-for-byte.
  const processedBuffers: Buffer[] = [];
  const sensorEntries: ProcessedVariant[] = [];
  for (let i = 0; i < sliced.length; i++) {
    const variant = await postprocessScoreAndStoreVariant({
      store,
      storeKey,
      index: i,
      raw: sliced[i]!,
      brief,
      palette,
      options: postprocessOptionsWithCrop,
      traceRefs: {
        overrideProfilePath: store.resolve(storeKey(POSTPROCESS_PROFILE_KEY)),
        effectivePipelineSnapshotPath: store.resolve(storeKey(EFFECTIVE_PIPELINE_JSON_KEY)),
      },
    });
    sensorEntries.push(variant);
    processedBuffers.push(variant.processed);
  }

  // --- Optional VLM judge pass (spec §F4, local-only per Constitutional §3). ---
  const judgeEnabled = brief.judge.enabled;
  if (judgeEnabled && !options.visionProvider) {
    throw new Error(
      `Brief '${brief.name}' opted into VLM judging (judge.enabled: true) but no vision ` +
        `provider was supplied. Either disable the judge for this brief or configure ` +
        `AZURE_OPENAI_VISION_DEPLOYMENT (and run with SPRITES_VISION_PROVIDER=azure-openai, ` +
        `which is the default).`,
    );
  }
  // Sensor + judge gating lives in `runJudgePass`; folding both fresh runs and
  // re-runs through it keeps the judge eligibility rules in exactly one place.
  const { judgePlan, judgeSkipReason } = await runJudgePass({
    variants: sensorEntries,
    judgeEnabled,
    brief,
    referencePngs,
    styleGuide,
    visionProvider: options.visionProvider ?? null,
    store,
    storeKey,
    ...(options.judgeBudget ? { judgeBudget: options.judgeBudget } : {}),
    ...(options.judgeCache ? { judgeCache: options.judgeCache } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.env ? { env: options.env } : {}),
    ...(options.warn ? { warn: options.warn } : {}),
  });

  const entries = assembleSummaryEntries({
    variants: sensorEntries,
    judgePlan,
    judgeSkipReason,
    judgeEnabled,
  });

  const ranked = rankCandidates(entries);
  const orientationTotal = entries.filter((e) =>
    e.breakdown.some((b) => b.sensor === 'silhouette-orientation-axis'),
  ).length;
  const orientationFailed = entries.filter((e) =>
    e.breakdown.some((b) => b.sensor === 'silhouette-orientation-axis' && !b.ok),
  ).length;
  const diversity = computeDiversity(processedBuffers);
  const chosen = pickChosen(ranked, brief);
  const budgetSnap = judgeEnabled && options.judgeBudget ? options.judgeBudget.snapshot() : null;
  const cacheStats = judgeEnabled && options.judgeCache ? { ...options.judgeCache.stats } : null;

  const summary: RunSummary = {
    ...identity,
    candidates: ranked,
    diversity,
    chosen,
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
    judgeCache: cacheStats,
    postprocessOverrides: {
      profilePath: store.resolve(storeKey(POSTPROCESS_PROFILE_KEY)),
      snapshotJsonPath: store.resolve(storeKey(EFFECTIVE_PIPELINE_JSON_KEY)),
      snapshotYamlPath: store.resolve(storeKey(EFFECTIVE_PIPELINE_YAML_KEY)),
      options: postprocessOptionsWithCrop,
      manualAnchor: null,
      manualWeaponAnchor: null,
      facing: null,
      appliedMode: 'default',
      updatedAt: nowIso,
    },
    sensorTelemetry: {
      orientation: {
        failed: orientationFailed,
        total: orientationTotal,
      },
    },
  };
  const summaryKey = storeKey('summary.json');
  await store.put(summaryKey, Buffer.from(`${JSON.stringify(summary, null, 2)}\n`));
  const summaryPath = store.resolve(summaryKey);

  return { summary, summaryPath, runDir, attempts, brief };
}
