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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
export const PRICING = [
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
export const FALLBACK_RATES = { inputPerMillion: 10.0, outputPerMillion: 30.0 };
const STATE_VERSION = 1;
export class JudgeBudget {
  budgetUsd;
  modelDeployment;
  rates;
  stateFile;
  spentUsd;
  callCount;
  callsThisRun = 0;
  callsSkippedDueToBudget = 0;
  now;
  constructor(options) {
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
  wouldExceed(estimatedTokens) {
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
   * in-memory state AND the persisted state file in the same call so a
   * crash between calls still produces correct accounting for the
   * next run. Returns the live snapshot for convenience.
   */
  recordCall(usage) {
    const cost = costForUsage(usage, this.rates);
    this.spentUsd += cost;
    this.callCount += 1;
    this.callsThisRun += 1;
    this.persist();
    return this.snapshot();
  }
  /**
   * Record that a call was skipped because the budget would have been
   * exceeded. No persistence change — only the per-run counter — since
   * skipping doesn't affect cumulative spend.
   */
  recordSkip() {
    this.callsSkippedDueToBudget += 1;
  }
  snapshot() {
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
  format() {
    const s = this.snapshot();
    const cap = Number.isFinite(s.budgetUsd) ? `$${s.budgetUsd.toFixed(4)}` : '<no cap>';
    const rem = Number.isFinite(s.remainingUsd) ? ` (remaining $${s.remainingUsd.toFixed(4)})` : '';
    return `judge-budget: spent $${s.spentUsd.toFixed(4)} of ${cap}${rem}, ${s.callsThisRun} call(s) this run, ${s.callsSkippedDueToBudget} skipped`;
  }
  persist() {
    const state = {
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
export function costForUsage(usage, rates) {
  const input = (usage.promptTokens / 1_000_000) * rates.inputPerMillion;
  const output = (usage.completionTokens / 1_000_000) * rates.outputPerMillion;
  return input + output;
}
/**
 * Resolve rates for a deployment name. Substring + case-insensitive
 * because Azure deployment names typically include the base model name
 * as a substring (e.g. `gpt-4o-vision-westus-2026`).
 */
export function resolveRates(deployment) {
  const lower = deployment.toLowerCase();
  for (const entry of PRICING) {
    if (lower.includes(entry.match.toLowerCase())) return entry.rates;
  }
  return FALLBACK_RATES;
}
function readState(file) {
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
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
function roundUsd(n) {
  // Round to 1e-6 to avoid float drift accumulating in the state file
  // across many small calls. Six decimals = $0.000001 precision, more
  // than enough for token-level accounting.
  return Math.round(n * 1_000_000) / 1_000_000;
}
//# sourceMappingURL=cost-tracker.js.map
