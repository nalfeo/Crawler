/**
 * generateOne — the sprite-generation orchestrator.
 *
 * Single entry point used by both the CLI and tests. Given a brief path,
 * a provider, and some IO hooks, runs the pipeline end-to-end:
 *
 *   1. Load + validate brief, resolve palette, load reference PNGs
 *   2. Load style guide and build the sheet prompt
 *   3. Call provider -> raw multi-variant sheet PNG
 *   4. Slice into variants
 *   5. Post-process each variant
 *   6. Score each variant via the universal + family sensors
 *   7. Write all artifacts under generated/runs/<brief>/<run-id>/
 *   8. Return a ranked summary
 *
 * Retry policy (bounded, 1-3 attempts):
 *   - On `bad-grid`, `non-png`: re-issue the same prompt up to maxAttempts
 *     because models occasionally drop a cell or emit a junk byte stream
 *     and the next attempt usually succeeds.
 *   - On `auth`: fail immediately. A wrong key won't fix itself.
 *   - On `network`, `rate-limit`, `provider-error`: fail. The CLI surfaces
 *     the kind so the human can decide whether to re-run.
 *   - On a "no variant passed" outcome: do NOT auto-retry. The artifacts
 *     are still useful (the human reviews the sheet to see what went wrong);
 *     the orchestrator returns the summary with `passed = []` and the CLI
 *     prints a clear "no candidate passed all sensors" line and exits
 *     non-zero. Re-running with a tweaked prompt is a human decision.
 *
 * Everything here is impure (network + filesystem). The pure pieces it
 * composes (`loadBrief`, `buildSheetPrompt`, `sliceSheet`, `postprocess`,
 * `scoreCandidate`) all live in their own modules with their own unit tests.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { variantCount } from './brief-schema.js';
import type { Brief } from './brief-schema.js';
import { buildSheetPrompt, loadStyleGuide } from './build-prompt.js';
import type { JudgeBudget } from './cost-tracker.js';
import { computeDiversity } from './diversity.js';
import { expandVariations } from './expand-variations.js';
import type { JudgeCache } from './judge-cache.js';
import { loadBrief, type LoadedBrief } from './load-brief.js';
import {
  assembleSummaryEntries,
  postprocessScoreAndStoreVariant,
  type ProcessedVariant,
  runJudgePass,
} from './run-pipeline.js';
import { sliceSheetFromBrief } from './slice-sheet.js';
import type { ImageProvider, ProviderErrorKind } from './provider/types.js';
import { ProviderError } from './provider/types.js';
import type { TextProvider } from './provider/text-types.js';
import type { VisionProvider } from './provider/vision-types.js';
import { LocalRunStore } from './store/local-store.js';
import type { RunStore } from './store/types.js';
import { makeRunId, pickChosen, rankCandidates, type RunSummary } from './run-artifacts.js';

export interface GenerateOneOptions {
  readonly briefPath: string;
  readonly provider: ImageProvider;
  /**
   * Optional text provider for variation expansion. When `null`/omitted
   * the orchestrator skips the expansion pass (the brief's seed
   * `variations` flow through untouched) and emits a single warning iff
   * the brief actually wanted more variations than the seed provides.
   */
  readonly textProvider?: TextProvider | null;
  /**
   * Optional vision provider for the local-only VLM judge (spec §F4).
   *
   * Required when `brief.judge.enabled === true` — the orchestrator
   * throws rather than silently skipping the judge if a brief asked
   * for it but no provider was supplied. The judge is a quality gate;
   * silently dropping it would defeat the whole point.
   *
   * Omitted/null is fine for any brief with `judge.enabled: false`.
   */
  readonly visionProvider?: VisionProvider | null;
  /**
   * Optional cross-run cost ceiling. When supplied, each judge call
   * is gated by `JudgeBudget.wouldExceed()` and the budget records
   * actual spend after a successful call. Variants gated out by the
   * budget appear with `judgeSkipReason: 'over-budget'`.
   *
   * Omit to disable the cost gate entirely (current behavior for
   * one-off single-brief runs). The CLI auto-constructs a budget
   * with cap=Infinity when neither flag nor env var is set, which is
   * functionally equivalent to omitting.
   */
  readonly judgeBudget?: JudgeBudget | null;
  /**
   * Optional VLM-judge cache. When supplied, judge calls go through
   * the cache; on hit, no provider call is made. The orchestrator
   * never instantiates the cache itself — the CLI does, so test
   * harnesses can run without ever touching the filesystem cache.
   */
  readonly judgeCache?: JudgeCache | null;
  /** Repository root used to resolve the style guide + reference PNGs. */
  readonly repoRoot: string;
  /** Output directory for run artifacts. Defaults to `<repoRoot>/generated`. */
  readonly outputRoot?: string;
  /** Max provider attempts on `bad-grid` / `non-png`. Defaults to 2. */
  readonly maxAttempts?: number;
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
  /** Reference PNG loader injection; defaults to `fs.readFileSync`. */
  readonly readReference?: (absolutePath: string) => Buffer;
  /** Optional brief override (avoid re-loading from disk in tests). */
  readonly preloaded?: LoadedBrief;
  /** Warning sink (mainly for expand-variations). Defaults to logger.warn. */
  readonly warn?: (message: string) => void;
  /** Environment override used by local-only judge checks (primarily tests). */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * RunStore for writing all artifacts. Defaults to a `LocalRunStore` rooted
   * at `<outputRoot>/runs` so existing local workflows are unaffected.
   * Pass an `AzureBlobRunStore` to write artifacts to Azure Blob Storage.
   */
  readonly store?: RunStore;
}

export interface GenerateOneResult {
  readonly summary: RunSummary;
  readonly summaryPath: string;
  readonly runDir: string;
  readonly attempts: number;
  /**
   * The fully-loaded brief used for this run. Exposed so the CLI (and other
   * orchestrator callers) can make brief-aware decisions — e.g. whether the
   * brief opted into `sensors.anchor.derive` — without re-reading the YAML.
   */
  readonly brief: Brief;
}

const RETRYABLE_PROVIDER_KINDS: ReadonlySet<ProviderErrorKind> = new Set(['bad-grid', 'non-png']);

export async function generateOne(options: GenerateOneOptions): Promise<GenerateOneResult> {
  const repoRoot = options.repoRoot;
  const outputRoot = options.outputRoot ?? path.join(repoRoot, 'generated');
  const maxAttempts = options.maxAttempts ?? 2;
  const now = options.now ?? (() => new Date());
  const readReference = options.readReference ?? ((p) => readFileSync(p));
  // Default to a local store rooted at <outputRoot>/runs — same layout as before.
  const store: RunStore = options.store ?? new LocalRunStore(path.join(outputRoot, 'runs'));

  const loaded = options.preloaded ?? loadBrief(options.briefPath, { projectRoot: repoRoot });
  const brief = loaded.brief;
  const palette = loaded.palette;
  const expected = variantCount(brief);

  // Expansion runs once per orchestrator invocation, before prompt
  // construction, because the prompt embeds the final variations list.
  // Graceful degradation: when no text provider is configured or the
  // call fails, we use the author's seed unchanged — the run still
  // produces sprites, just without the LLM-brainstormed extras.
  const expansion = await expandVariations({
    brief,
    provider: options.textProvider ?? null,
    ...(options.warn ? { warn: options.warn } : {}),
  });
  // Shallow brief copy with the resolved variations list so downstream
  // pure code (build-prompt, run-summary) doesn't need to know an
  // expansion step happened. Original brief object stays untouched.
  const effectiveBrief = { ...brief, variations: [...expansion.variations] };

  const styleGuide = loadStyleGuide(repoRoot);
  const prompt = buildSheetPrompt(effectiveBrief, styleGuide);

  // Reference PNG paths are repo-relative in briefs; resolve against repoRoot.
  const referencePngs = brief.references.map((ref) =>
    readReference(path.resolve(repoRoot, ref.path)),
  );

  const runId = makeRunId(now(), `${brief.name}|${prompt}`);
  // Store-key helper: returns a key relative to the store root.
  const storeKey = (rel: string) => `${brief.name}/${runId}/${rel}`;
  const pad2 = (n: number) => String(n).padStart(2, '0');

  // --- Generate the sheet, with bounded retries on transient grid issues. ---
  let attempts = 0;
  let lastError: ProviderError | undefined;
  let sliced: Buffer[] | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    attempts++;
    try {
      const sheet = await options.provider.generateSheet({
        brief,
        prompt,
        referencePngs,
        variants: expected,
      });
      await store.put(storeKey(`sheet-${pad2(attempt)}.png`), sheet);
      const cells = sliceSheetFromBrief(sheet, brief);
      if (cells.length !== expected) {
        throw new ProviderError(
          'bad-grid',
          `expected ${expected} cells, slicer produced ${cells.length}`,
        );
      }
      sliced = cells;
      break;
    } catch (err) {
      const provErr = asProviderError(err);
      lastError = provErr;
      if (!RETRYABLE_PROVIDER_KINDS.has(provErr.kind)) throw provErr;
      if (attempt + 1 >= maxAttempts) throw provErr;
    }
  }
  if (!sliced) {
    throw lastError ?? new Error('generateOne: no sheet produced and no error captured');
  }

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
  const diversity = computeDiversity(processedBuffers);
  const chosen = pickChosen(ranked, brief);
  const budgetSnap = judgeEnabled && options.judgeBudget ? options.judgeBudget.snapshot() : null;
  const cacheStats = judgeEnabled && options.judgeCache ? { ...options.judgeCache.stats } : null;

  // Convert absolute briefPath to repo-relative with forward slashes (required by validation)
  const repoRelativeBriefPath = path.relative(repoRoot, loaded.briefPath).replace(/\\/g, '/');

  const summary: RunSummary = {
    brief: brief.name,
    briefPath: repoRelativeBriefPath,
    runId,
    createdAt: now().toISOString(),
    promptHash: shortPromptHash(prompt),
    attempts,
    variantCount: expected,
    candidates: ranked,
    diversity,
    variations: {
      seed: expansion.seed,
      proposed: expansion.proposed,
      final: expansion.variations,
      minVariations: brief.minVariations,
      skippedReason: expansion.skippedReason,
    },
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
  };
  const summaryKey = storeKey('summary.json');
  await store.put(summaryKey, Buffer.from(`${JSON.stringify(summary, null, 2)}\n`));
  const summaryPath = store.resolve(summaryKey);
  const runDir = store.resolve(`${brief.name}/${runId}`);

  return { summary, summaryPath, runDir, attempts, brief };
}

function shortPromptHash(prompt: string): string {
  // Re-use the same hashing helper indirectly via run-artifacts.makeRunId
  // logic. Inlined here to avoid exporting an extra helper.
  return makeRunId(new Date(0), prompt).slice(20);
}

function asProviderError(err: unknown): ProviderError {
  if (err instanceof ProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ProviderError('provider-error', message, err ? { cause: err } : undefined);
}

// (No public re-exports — each consumer imports directly from the relevant
// pure module. Keeps the orchestrator surface area minimal.)
