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
 *   - Persisted state is read/written at construction and after every
 *     `recordCall`, so a Ctrl-C mid-batch doesn't lose accounting and
 *     a resumed batch run honors the same ceiling.
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
export declare const PRICING: ReadonlyArray<{
  readonly match: string;
  readonly rates: ModelRates;
}>;
/**
 * Used when no deployment in `PRICING` matches. Deliberately the most
 * expensive entry — under-counting cost is a worse failure mode than
 * over-counting it for a hard budget gate.
 */
export declare const FALLBACK_RATES: ModelRates;
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
export declare class JudgeBudget {
  readonly budgetUsd: number;
  readonly modelDeployment: string;
  readonly rates: ModelRates;
  readonly stateFile: string;
  private spentUsd;
  private callCount;
  private callsThisRun;
  private callsSkippedDueToBudget;
  private readonly now;
  constructor(options: JudgeBudgetOptions);
  /**
   * Returns true if issuing another call would push spend beyond the
   * ceiling. `estimatedTokens` is a conservative upper bound the
   * caller supplies for pre-flight checks; omit for a check based on
   * already-recorded spend only (treats the next call as "small but
   * non-zero", which is the common pattern in `generate-one`).
   */
  wouldExceed(estimatedTokens?: number): boolean;
  /**
   * Record token usage from a completed judge call. Updates the
   * in-memory state AND the persisted state file in the same call so a
   * crash between calls still produces correct accounting for the
   * next run. Returns the live snapshot for convenience.
   */
  recordCall(usage: VisionUsage): JudgeBudgetSnapshot;
  /**
   * Record that a call was skipped because the budget would have been
   * exceeded. No persistence change — only the per-run counter — since
   * skipping doesn't affect cumulative spend.
   */
  recordSkip(): void;
  snapshot(): JudgeBudgetSnapshot;
  /** Human-readable single-line summary for CLI output and logs. */
  format(): string;
  private persist;
}
/** Compute USD cost for one call given a usage record and pricing rates. */
export declare function costForUsage(usage: VisionUsage, rates: ModelRates): number;
/**
 * Resolve rates for a deployment name. Substring + case-insensitive
 * because Azure deployment names typically include the base model name
 * as a substring (e.g. `gpt-4o-vision-westus-2026`).
 */
export declare function resolveRates(deployment: string): ModelRates;
//# sourceMappingURL=cost-tracker.d.ts.map
