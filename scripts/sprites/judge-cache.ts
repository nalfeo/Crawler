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
 *   - floor                 — dungeon depth affects expected design intensity
 *   - expectedPresentation  — derived display string baked into the user prompt
 *   - effectiveGeometry     — derived geometry string baked into the user prompt
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

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import type { JudgeScorecard } from './judge.js';

export interface JudgeCacheKeyInputs {
  readonly modelDeployment: string;
  /** Bump this constant in `judge.ts` whenever the system prompt structure changes. */
  readonly promptTemplateVersion: string;
  readonly variantPng: Buffer;
  readonly referencePngs: ReadonlyArray<Buffer>;
  /** `brief.prompt` — drives the `brief_match` evaluator. */
  readonly briefMatchInstructions: string;
  /** Dungeon depth changes the expected design-language intensity. */
  readonly floor: number;
  /**
   * Derived EXPECTED PRESENTATION string used verbatim in the user prompt.
   * Computed by `expectedPresentation(brief)` in `judge.ts` and shared with
   * the cache key so the two cannot drift.
   */
  readonly expectedPresentation: string;
  /**
   * Derived EFFECTIVE GEOMETRY string used verbatim in the user prompt.
   * Computed by `effectiveGeometry(brief)` in `judge.ts` and shared with
   * the cache key so the two cannot drift.
   */
  readonly effectiveGeometry: string;
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

const DEFAULT_MAX_ENTRIES = 1000;

export class JudgeCache {
  readonly cacheDir: string;
  readonly maxEntries: number;
  readonly enabled: boolean;

  private readonly now: () => Date;
  readonly stats: JudgeCacheStats = { hits: 0, misses: 0, bypassed: 0 };

  constructor(options: JudgeCacheOptions) {
    this.cacheDir = options.cacheDir;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.enabled = options.enabled !== false;
    this.now = options.now ?? (() => new Date());
    if (this.maxEntries < 1) {
      throw new Error(`JudgeCache: maxEntries must be >= 1, got ${this.maxEntries}`);
    }
  }

  /** Deterministic, no clock, no PRNG. */
  computeKey(inputs: JudgeCacheKeyInputs): string {
    const hash = createHash('sha256');
    hash.update('deployment:');
    hash.update(inputs.modelDeployment);
    hash.update('\ntemplate:');
    hash.update(inputs.promptTemplateVersion);
    hash.update('\nbrief-prompt:');
    hash.update(inputs.briefMatchInstructions);
    hash.update('\nfloor:');
    hash.update(String(inputs.floor));
    hash.update('\nexpected-presentation:');
    hash.update(inputs.expectedPresentation);
    hash.update('\neffective-geometry:');
    hash.update(inputs.effectiveGeometry);
    hash.update('\nvariant-png:');
    hash.update(inputs.variantPng);
    hash.update('\nreferences:');
    // Length prefix per reference so [A, B] doesn't collide with [AB].
    for (const ref of inputs.referencePngs) {
      hash.update(`\nref-bytes-${ref.length}:`);
      hash.update(ref);
    }
    return hash.digest('hex');
  }

  /** Returns the cached scorecard or null. Bumps `stats.hits` on hit. */
  get(key: string): JudgeScorecard | null {
    if (!this.enabled) {
      this.stats.bypassed += 1;
      return null;
    }
    const file = this.entryPath(key);
    if (!existsSync(file)) return null;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as JudgeScorecard;
      // Touch mtime so frequently-hit entries don't age out under LRU.
      const t = this.now();
      try {
        // Best-effort; if the FS rejects utimes (e.g. read-only mount),
        // the hit is still valid — eviction is just a bit less smart.
        utimesSync(file, t, t);
      } catch {
        /* mtime touch is opportunistic */
      }
      this.stats.hits += 1;
      return parsed;
    } catch {
      // Corrupt entry — treat as miss and let the caller refresh it.
      return null;
    }
  }

  /**
   * Persist the scorecard for `key`. Also writes a sibling
   * `<key>.meta.json` containing the variant path + brief id for
   * humans inspecting "which call produced this hash". Stats: bumps
   * `stats.misses`.
   */
  put(
    key: string,
    scorecard: JudgeScorecard,
    meta: { readonly variantPath: string; readonly briefId: string },
  ): void {
    if (!this.enabled) {
      this.stats.bypassed += 1;
      return;
    }
    mkdirSync(this.cacheDir, { recursive: true });
    const file = this.entryPath(key);
    writeFileSync(file, `${JSON.stringify(scorecard, null, 2)}\n`);
    const metaFile = `${file.slice(0, -'.json'.length)}.meta.json`;
    const metaPayload = {
      variantPath: meta.variantPath,
      briefId: meta.briefId,
      cachedAt: this.now().toISOString(),
    };
    writeFileSync(metaFile, `${JSON.stringify(metaPayload, null, 2)}\n`);
    this.stats.misses += 1;
    this.evictIfOverCap();
  }

  /**
   * Delete cache entries older than `maxAgeHours`. Returns the count
   * of files deleted (counting scorecard + meta as one entry).
   * Convenience for the CLI `--prune-judge-cache` housekeeping flag.
   */
  prune(maxAgeHours: number): number {
    if (!existsSync(this.cacheDir)) return 0;
    const cutoffMs = this.now().getTime() - maxAgeHours * 3600 * 1000;
    const entries = this.listScorecardEntries();
    let deleted = 0;
    for (const entry of entries) {
      if (entry.mtimeMs < cutoffMs) {
        this.deleteEntry(entry.file);
        deleted += 1;
      }
    }
    return deleted;
  }

  /** Total entries currently on disk. Exposed for tests + diagnostics. */
  size(): number {
    if (!existsSync(this.cacheDir)) return 0;
    return this.listScorecardEntries().length;
  }

  private entryPath(key: string): string {
    return path.join(this.cacheDir, `${key}.json`);
  }

  private listScorecardEntries(): ReadonlyArray<{
    readonly file: string;
    readonly mtimeMs: number;
  }> {
    return readdirSync(this.cacheDir)
      .filter((name) => name.endsWith('.json') && !name.endsWith('.meta.json'))
      .map((name) => {
        const file = path.join(this.cacheDir, name);
        return { file, mtimeMs: statSync(file).mtimeMs };
      });
  }

  private evictIfOverCap(): void {
    const entries = this.listScorecardEntries();
    if (entries.length <= this.maxEntries) return;
    // Oldest first.
    const sorted = [...entries].sort((a, b) => a.mtimeMs - b.mtimeMs);
    const overflow = sorted.length - this.maxEntries;
    for (let i = 0; i < overflow; i++) {
      this.deleteEntry(sorted[i]!.file);
    }
  }

  private deleteEntry(scorecardFile: string): void {
    rmSync(scorecardFile, { force: true });
    const metaFile = `${scorecardFile.slice(0, -'.json'.length)}.meta.json`;
    rmSync(metaFile, { force: true });
  }
}
