/**
 * Variation-list expansion.
 *
 * Given a brief and an optional text provider, return the final list of
 * thematic variations to feed into the sheet prompt. Rules:
 *
 *   - If `brief.minVariations === 0`, expansion is disabled. Author's
 *     seed `brief.variations` flows through untouched. Canonical sprites
 *     opt out this way.
 *   - If `brief.variations.length >= brief.minVariations`, the author
 *     already provided enough — return as-is, no provider call.
 *   - Otherwise, ask the text provider for `minVariations - seed.length`
 *     additional entries. Append to the seed, de-duplicate
 *     case-insensitively (author entries always win on conflict).
 *   - If no provider is supplied, or the provider throws, log a single
 *     warning and return the seed as-is. The pipeline can still run; it
 *     just gets a shorter variations block (or none) in the sheet prompt.
 *
 * The function is mostly pure modulo the provider call and the optional
 * warning sink. The provider stub used in tests makes deterministic
 * coverage trivial.
 */
import type { Brief } from './brief-schema.js';
import type { TextProvider } from './provider/text-types.js';
export interface ExpandVariationsOptions {
  readonly brief: Brief;
  /**
   * Optional provider. When `null`/omitted, expansion is skipped — the
   * function logs a warning iff expansion was actually needed (i.e. the
   * seed was too short relative to `minVariations`).
   */
  readonly provider: TextProvider | null;
  /**
   * Warning sink. Defaults to logger.warn. Tests inject a buffer so
   * they can assert on the warnings without polluting stderr.
   */
  readonly warn?: (message: string) => void;
}
export interface ExpandVariationsResult {
  /** Final list of variations: seed plus any LLM-proposed additions. */
  readonly variations: ReadonlyArray<string>;
  /** Original seed copy, preserved for run-summary debugging. */
  readonly seed: ReadonlyArray<string>;
  /** Entries returned by the provider this run, in declared order. */
  readonly proposed: ReadonlyArray<string>;
  /**
   * Why expansion was skipped, if it was. `null` when the provider
   * actually ran. One of: `'disabled'` (brief opted out), `'sufficient'`
   * (seed already met `minVariations`), `'no-provider'` (no provider
   * configured but expansion was wanted), or `'provider-failed'` (the
   * call threw and we degraded gracefully).
   */
  readonly skippedReason: ExpansionSkipReason | null;
}
export type ExpansionSkipReason = 'disabled' | 'sufficient' | 'no-provider' | 'provider-failed';
export declare function expandVariations(
  options: ExpandVariationsOptions,
): Promise<ExpandVariationsResult>;
//# sourceMappingURL=expand-variations.d.ts.map
