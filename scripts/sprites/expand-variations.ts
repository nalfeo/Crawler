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
import { TextProviderError } from './provider/text-types.js';

export interface ExpandVariationsOptions {
  readonly brief: Brief;
  /**
   * Optional provider. When `null`/omitted, expansion is skipped — the
   * function logs a warning iff expansion was actually needed (i.e. the
   * seed was too short relative to `minVariations`).
   */
  readonly provider: TextProvider | null;
  /**
   * Warning sink. Defaults to `console.warn`. Tests inject a buffer so
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

export async function expandVariations(
  options: ExpandVariationsOptions,
): Promise<ExpandVariationsResult> {
  const { brief, provider } = options;
  const warn = options.warn ?? ((m) => console.warn(m));
  const seed: ReadonlyArray<string> = brief.variations;

  if (brief.minVariations === 0) {
    return {
      variations: seed,
      seed,
      proposed: [],
      skippedReason: 'disabled',
    };
  }

  if (seed.length >= brief.minVariations) {
    return {
      variations: seed,
      seed,
      proposed: [],
      skippedReason: 'sufficient',
    };
  }

  const need = brief.minVariations - seed.length;

  if (provider === null) {
    warn(
      `expand-variations: brief '${brief.name}' wants minVariations=${brief.minVariations} but only ${seed.length} seed entries are present and no text provider is configured (set AZURE_OPENAI_CHAT_DEPLOYMENT). Proceeding with the seed unchanged.`,
    );
    return {
      variations: seed,
      seed,
      proposed: [],
      skippedReason: 'no-provider',
    };
  }

  let proposed: ReadonlyArray<string>;
  try {
    proposed = await provider.expandVariations({ brief, existing: seed, count: need });
  } catch (err) {
    const kind = err instanceof TextProviderError ? err.kind : 'unknown';
    const msg = err instanceof Error ? err.message : String(err);
    warn(
      `expand-variations: brief '${brief.name}' provider call failed (${kind}): ${msg}. Proceeding with the seed unchanged.`,
    );
    return {
      variations: seed,
      seed,
      proposed: [],
      skippedReason: 'provider-failed',
    };
  }

  const merged = mergeUnique(seed, proposed);
  return {
    variations: merged,
    seed,
    proposed,
    skippedReason: null,
  };
}

/**
 * Append `additions` to `seed`, dropping any addition whose
 * case-insensitive trimmed form already exists in the seed or earlier
 * in the additions list. Author seed always wins (declared first, in
 * declared order).
 */
function mergeUnique(
  seed: ReadonlyArray<string>,
  additions: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (entry: string): void => {
    const trimmed = entry.trim();
    if (trimmed.length === 0) return;
    const key = trimmed.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(trimmed);
  };
  for (const s of seed) add(s);
  for (const a of additions) add(a);
  return out;
}
