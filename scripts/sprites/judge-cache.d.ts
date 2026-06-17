/**
 * Filesystem-backed cache for VLM judge scorecards.
 *
 * The judge call is the single most expensive operation in the
 * sprite pipeline (one vision-model call per sensor-passing variant).
 * When iterating on prompts, references, or post-processing without
 * changing the variant bytes the judge sees, re-issuing the SAME
 * vision call is pure waste. This cache eliminates that.
 *
 * Cache key (sha256) combines:
 *   - modelDeployment       — different model => different verdict
 *   - promptTemplateVersion — bump when the system prompt changes
 *   - variant PNG bytes     — any pixel-level change invalidates
 *   - reference PNG bytes   — re-anchoring style invalidates
 *   - brief match prompt    — brief.prompt drives `brief_match`
 *
 * Critically, this cache stores ONLY `JudgeScorecard` JSON — never
 * variants, never references, never prompts. Rationale (do NOT change
 * without a critique):
 *
 *   1. Caching the OUTPUT IMAGES would cache LUCK, not quality. The
 *      image provider's output is intentionally non-deterministic;
 *      replaying a 5/5 sprite by hash would short-circuit the very
 *      mechanism that produces diversity in the first place.
 *   2. Storing images would bloat the cache by orders of magnitude
 *      with no clear eviction story. Scorecards are a few hundred
 *      bytes each; 1000 entries fit in <1MB.
 *   3. Storing prompts/references could accidentally leak a brief's
 *      intent to anyone with read access to the workspace. Hashes are
 *      one-way.
 *
 * The cache does NOT validate that `brief.judge.enabled === true`
 * before responding to lookups — that's the orchestrator's job.
 * Convention: `generate-one` only invokes `judgeVariant` when the
 * brief opted in, so the cache is naturally bypassed for
 * judge-disabled briefs. Documented as an invariant so the next
 * person who refactors the flow doesn't accidentally introduce a
 * cache lookup at a layer that runs even when the judge is off.
 *
 * LRU eviction is mtime-based: on `put`, if entry count exceeds the
 * cap, the oldest-modified entries are deleted. Cheap, doesn't
 * require a separate index file, survives crashes.
 */
import type { JudgeScorecard } from './judge.js';
export interface JudgeCacheKeyInputs {
  readonly modelDeployment: string;
  /** Bump this constant in `judge.ts` whenever the system prompt structure changes. */
  readonly promptTemplateVersion: string;
  readonly variantPng: Buffer;
  readonly referencePngs: ReadonlyArray<Buffer>;
  /** `brief.prompt` — drives the `brief_match` evaluator. */
  readonly briefMatchInstructions: string;
}
export interface JudgeCacheOptions {
  readonly cacheDir: string;
  /**
   * Hard maximum entries kept on disk. When `put` would push the
   * count above the cap, the oldest entries (by file mtime) are
   * deleted until the count fits. Default 1000.
   */
  readonly maxEntries?: number;
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
  /**
   * When false, both `get` and `put` become no-ops (the orchestrator
   * still constructs the cache so per-run stats can be reported even
   * in bypass mode).
   */
  readonly enabled?: boolean;
}
/** Per-run stats surfaced into `RunSummary.judgeCache`. */
export interface JudgeCacheStats {
  /** Cache hits that short-circuited a provider call. */
  hits: number;
  /** Misses that resulted in a provider call + a `put`. */
  misses: number;
  /** Calls where caching was bypassed entirely (cache disabled). */
  bypassed: number;
}
export declare class JudgeCache {
  readonly cacheDir: string;
  readonly maxEntries: number;
  readonly enabled: boolean;
  private readonly now;
  readonly stats: JudgeCacheStats;
  constructor(options: JudgeCacheOptions);
  /** Deterministic, no clock, no PRNG. */
  computeKey(inputs: JudgeCacheKeyInputs): string;
  /** Returns the cached scorecard or null. Bumps `stats.hits` on hit. */
  get(key: string): JudgeScorecard | null;
  /**
   * Persist the scorecard for `key`. Also writes a sibling
   * `<key>.meta.json` containing the variant path + brief id for
   * humans inspecting "which call produced this hash". Stats: bumps
   * `stats.misses`.
   */
  put(
    key: string,
    scorecard: JudgeScorecard,
    meta: {
      readonly variantPath: string;
      readonly briefId: string;
    },
  ): void;
  /**
   * Delete cache entries older than `maxAgeHours`. Returns the count
   * of files deleted (counting scorecard + meta as one entry).
   * Convenience for the CLI `--prune-judge-cache` housekeeping flag.
   */
  prune(maxAgeHours: number): number;
  /** Total entries currently on disk. Exposed for tests + diagnostics. */
  size(): number;
  private entryPath;
  private listScorecardEntries;
  private evictIfOverCap;
  private deleteEntry;
}
//# sourceMappingURL=judge-cache.d.ts.map
