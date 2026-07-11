/**
 * Cross-run cost ceiling for VLM judge calls.
 *
 * Phase 3 of the sprite pipeline points the judge at "hundreds of
 * briefs" via the batch CLI. Without a kill-switch, an
 * accidentally-expensive brief — or a runaway batch — can burn through
 * Azure credits with nothing in the loop to notice. `JudgeBudget`
 * accumulates token spend across variants AND across CLI invocations
 * (state persists to `generated/.cost-state.json`) and refuses to keep
 * issuing calls once a configured USD ceiling is exceeded.
 *
 * Design choices:
 *
 *   - `recordCall` is async and performs a lock-protected read-modify-write
 *     so concurrent `JudgeBudget` instances (e.g. two parallel batch CLI
 *     invocations sharing a worktree) each land their spend correctly.
 *     A Ctrl-C mid-batch still produces correct accounting because every
 *     call is flushed before returning.
 *   - The lock file is `<stateFile>.lock` (a directory, POSIX-atomic mkdir).
 *     Locks older than 10 s are considered stale and auto-removed.
 *   - The pricing table is small and static; rates live alongside the
 *     code so the source of truth is reviewable in a PR. Update the
 *     `PRICING` table when Azure publishes new rates. There is no
 *     network lookup — we never trust live Azure prices for a hard
 *     budget gate.
 *   - When no deployment matches the table, fall back to the most
 *     expensive known model so the budget is conservative rather than
 *     accidentally infinite.
 *   - Stores only token counts + USD totals. NEVER stores prompts,
 *     variant content, or any user-identifiable data — keeps the
 *     state file small and privacy-safe to commit-by-accident
 *     (though `.gitignore` covers `generated/`).
 *   - Pure-ish: filesystem is the only side effect; no network, no
 *     clock dependency except for the `lastUpdated` timestamp (and
 *     even that's injectable for tests).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';
import type { VisionUsage } from './provider/vision-types.js';

/**
 * Static pricing table. Rates are USD per 1,000,000 tokens.
 *
 * Source: Azure OpenAI Service pricing page, captured 2026-06-05.
 *   https://azure.microsoft.com/en-us/pricing/details/cognitive-services/openai-service/
 *
 * Update when Azure publishes new rates. Keys match deployment names
 * the team actually uses; substring match (case-insensitive) handles
 * suffixed deployments like `gpt-4o-mini-2026`.
 */
export interface ModelRates {
  /** USD per 1M input (prompt) tokens. */
  readonly inputPerMillion: number;
  /** USD per 1M output (completion) tokens. */
  readonly outputPerMillion: number;
}

export const PRICING: ReadonlyArray<{ readonly match: string; readonly rates: ModelRates }> = [
  // gpt-4o vision (2024-08-06 and later snapshots).
  { match: 'gpt-4o-mini', rates: { inputPerMillion: 0.15, outputPerMillion: 0.6 } },
  { match: 'gpt-4o', rates: { inputPerMillion: 2.5, outputPerMillion: 10.0 } },
  // gpt-4-turbo vision.
  { match: 'gpt-4-turbo', rates: { inputPerMillion: 10.0, outputPerMillion: 30.0 } },
];

/**
 * Used when no deployment in `PRICING` matches. Deliberately the most
 * expensive entry — under-counting cost is a worse failure mode than
 * over-counting it for a hard budget gate.
 */
export const FALLBACK_RATES: ModelRates = { inputPerMillion: 10.0, outputPerMillion: 30.0 };

/** Persisted state shape. Versioned so a future rename of a field is recoverable. */
interface CostState {
  readonly version: 1;
  readonly spentUsd: number;
  readonly callCount: number;
  readonly lastUpdated: string;
}

const STATE_VERSION = 1 as const;

export interface JudgeBudgetOptions {
  /**
   * Hard USD ceiling. `Infinity` (the default for single-brief runs)
   * disables the gate — `wouldExceed` always returns false and
   * `recordCall` keeps accumulating purely for reporting. The batch
   * CLI is expected to pass a concrete cap.
   */
  readonly budgetUsd: number;
  /** Azure deployment name (e.g. `gpt-4o-vision`). Used to look up rates. */
  readonly modelDeployment: string;
  /**
   * State file path. Defaults to `<repoRoot>/generated/.cost-state.json`.
   * The directory is created lazily on first write.
   */
  readonly stateFile?: string;
  /** Clock injection for deterministic tests. */
  readonly now?: () => Date;
  /**
   * When true, ignore any existing state file (treat the budget as
   * fresh). Used to implement the CLI `--reset-budget` flag and to
   * make tests independent of one another.
   */
  readonly reset?: boolean;
}

/**
 * Per-run snapshot surfaced into `RunSummary.judgeBudget`. Lets
 * downstream dashboards show the budget headroom WITHOUT having to
 * re-read the state file.
 */
export interface JudgeBudgetSnapshot {
  readonly budgetUsd: number;
  readonly spentUsd: number;
  readonly remainingUsd: number;
  /** Number of judge calls recorded across the lifetime of the state file. */
  readonly callCount: number;
  /** Calls recorded by THIS budget instance — useful for per-run reports. */
  readonly callsThisRun: number;
  /** Calls this run that were skipped because the budget would have been exceeded. */
  readonly callsSkippedDueToBudget: number;
}

export class JudgeBudget {
  readonly budgetUsd: number;
  readonly modelDeployment: string;
  readonly rates: ModelRates;
  readonly stateFile: string;

  private spentUsd: number;
  private callCount: number;
  private callsThisRun = 0;
  private callsSkippedDueToBudget = 0;
  private readonly now: () => Date;

  constructor(options: JudgeBudgetOptions) {
    if (Number.isNaN(options.budgetUsd) || options.budgetUsd < 0) {
      throw new Error(
        `JudgeBudget: budgetUsd must be a non-negative number or Infinity, got ${options.budgetUsd}`,
      );
    }
    this.budgetUsd = options.budgetUsd;
    this.modelDeployment = options.modelDeployment;
    this.rates = resolveRates(options.modelDeployment);
    this.stateFile = options.stateFile ?? path.join(process.cwd(), 'generated', '.cost-state.json');
    this.now = options.now ?? (() => new Date());

    if (options.reset) {
      this.spentUsd = 0;
      this.callCount = 0;
      this.persist();
    } else {
      const loaded = readState(this.stateFile);
      this.spentUsd = loaded?.spentUsd ?? 0;
      this.callCount = loaded?.callCount ?? 0;
    }
  }

  /**
   * Returns true if issuing another call would push spend beyond the
   * ceiling. `estimatedTokens` is a conservative upper bound the
   * caller supplies for pre-flight checks; omit for a check based on
   * already-recorded spend only (treats the next call as "small but
   * non-zero", which is the common pattern in `generate-one`).
   */
  wouldExceed(estimatedTokens?: number): boolean {
    if (!Number.isFinite(this.budgetUsd)) return false;
    if (this.spentUsd >= this.budgetUsd) return true;
    if (estimatedTokens === undefined) return false;
    // Estimate uses the OUTPUT rate (more expensive of the two) — same
    // "conservative when in doubt" stance as `FALLBACK_RATES`.
    const estimatedUsd = (estimatedTokens / 1_000_000) * this.rates.outputPerMillion;
    return this.spentUsd + estimatedUsd > this.budgetUsd;
  }

  /**
   * Record token usage from a completed judge call. Updates the
   * persisted state file atomically (file-locked read-modify-write) so
   * two concurrent `JudgeBudget` instances on the same state file both
   * land their spend rather than one silently overwriting the other.
   * Also updates the in-memory `spentUsd` / `callCount` to the new
   * file value, keeping `wouldExceed()` accurate after each call.
   *
   * Returns the live snapshot for convenience.
   */
  async recordCall(usage: VisionUsage): Promise<JudgeBudgetSnapshot> {
    const cost = costForUsage(usage, this.rates);
    this.callsThisRun += 1;

    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    // proper-lockfile requires the file to exist before locking.
    if (!existsSync(this.stateFile)) {
      writeFileSync(
        this.stateFile,
        `${JSON.stringify({ version: STATE_VERSION, spentUsd: 0, callCount: 0, lastUpdated: '' }, null, 2)}\n`,
      );
    }

    const release = await lockfile.lock(this.stateFile, {
      retries: { retries: 10, minTimeout: 50, maxTimeout: 500 },
      stale: 10_000,
    });
    try {
      // Re-read the file under the lock so that the delta from any
      // concurrent writer is included in our new value.
      const current = readState(this.stateFile) ?? { spentUsd: 0, callCount: 0 };
      const newSpentUsd = current.spentUsd + cost;
      const newCallCount = current.callCount + 1;
      const state: CostState = {
        version: STATE_VERSION,
        spentUsd: newSpentUsd,
        callCount: newCallCount,
        lastUpdated: this.now().toISOString(),
      };
      writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
      // Mirror file values in memory so wouldExceed() stays accurate.
      this.spentUsd = newSpentUsd;
      this.callCount = newCallCount;
    } finally {
      await release();
    }

    return this.snapshot();
  }

  /**
   * Record that a call was skipped because the budget would have been
   * exceeded. No persistence change — only the per-run counter — since
   * skipping doesn't affect cumulative spend.
   */
  recordSkip(): void {
    this.callsSkippedDueToBudget += 1;
  }

  snapshot(): JudgeBudgetSnapshot {
    const remaining = Number.isFinite(this.budgetUsd)
      ? Math.max(0, this.budgetUsd - this.spentUsd)
      : Number.POSITIVE_INFINITY;
    return {
      budgetUsd: this.budgetUsd,
      spentUsd: roundUsd(this.spentUsd),
      remainingUsd: Number.isFinite(remaining) ? roundUsd(remaining) : remaining,
      callCount: this.callCount,
      callsThisRun: this.callsThisRun,
      callsSkippedDueToBudget: this.callsSkippedDueToBudget,
    };
  }

  /** Human-readable single-line summary for CLI output and logs. */
  format(): string {
    const s = this.snapshot();
    const cap = Number.isFinite(s.budgetUsd) ? `$${s.budgetUsd.toFixed(4)}` : '<no cap>';
    const rem = Number.isFinite(s.remainingUsd)
      ? ` (remaining $${(s.remainingUsd as number).toFixed(4)})`
      : '';
    return `judge-budget: spent $${s.spentUsd.toFixed(4)} of ${cap}${rem}, ${s.callsThisRun} call(s) this run, ${s.callsSkippedDueToBudget} skipped`;
  }

  /**
   * Synchronously write zeros to the state file. Only called from the
   * constructor when `reset: true` — a single-process, single-writer
   * operation that does not need a lock.
   */
  private persist(): void {
    const state: CostState = {
      version: STATE_VERSION,
      spentUsd: this.spentUsd,
      callCount: this.callCount,
      lastUpdated: this.now().toISOString(),
    };
    mkdirSync(path.dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, `${JSON.stringify(state, null, 2)}\n`);
  }
}

/** Compute USD cost for one call given a usage record and pricing rates. */
export function costForUsage(usage: VisionUsage, rates: ModelRates): number {
  const input = (usage.promptTokens / 1_000_000) * rates.inputPerMillion;
  const output = (usage.completionTokens / 1_000_000) * rates.outputPerMillion;
  return input + output;
}

/**
 * Resolve rates for a deployment name. Substring + case-insensitive
 * because Azure deployment names typically include the base model name
 * as a substring (e.g. `gpt-4o-vision-westus-2026`).
 */
export function resolveRates(deployment: string): ModelRates {
  const lower = deployment.toLowerCase();
  for (const entry of PRICING) {
    if (lower.includes(entry.match.toLowerCase())) return entry.rates;
  }
  return FALLBACK_RATES;
}

function readState(file: string): CostState | null {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<CostState>;
    if (parsed.version !== STATE_VERSION) return null;
    if (typeof parsed.spentUsd !== 'number' || typeof parsed.callCount !== 'number') return null;
    return {
      version: STATE_VERSION,
      spentUsd: parsed.spentUsd,
      callCount: parsed.callCount,
      lastUpdated: typeof parsed.lastUpdated === 'string' ? parsed.lastUpdated : '',
    };
  } catch {
    // Corrupt state file: treat as empty rather than crash. The next
    // recordCall will overwrite it with a valid one.
    return null;
  }
}

function roundUsd(n: number): number {
  // Round to 1e-6 to avoid float drift accumulating in the state file
  // across many small calls. Six decimals = $0.000001 precision, more
  // than enough for token-level accounting.
  return Math.round(n * 1_000_000) / 1_000_000;
}
