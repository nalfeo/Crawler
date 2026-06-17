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
import type { Brief } from './brief-schema.js';
import type { JudgeBudget } from './cost-tracker.js';
import type { JudgeCache } from './judge-cache.js';
import { type LoadedBrief } from './load-brief.js';
import type { ImageProvider } from './provider/types.js';
import type { TextProvider } from './provider/text-types.js';
import type { VisionProvider } from './provider/vision-types.js';
import type { RunStore } from './store/types.js';
import { type RunSummary } from './run-artifacts.js';
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
export declare function generateOne(options: GenerateOneOptions): Promise<GenerateOneResult>;
//# sourceMappingURL=generate-one.d.ts.map
