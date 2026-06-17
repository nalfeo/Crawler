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
import { TextProviderError } from './provider/text-types.js';
import { createLogger } from '../../src/shared/logger.js';
const logger = createLogger('infra:expand-variations');
export async function expandVariations(options) {
  const { brief, provider } = options;
  const warn = options.warn ?? logger.warn.bind(logger);
  const seed = brief.variations;
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
      `expand-variations: brief '${brief.name}' wants minVariations=${brief.minVariations} but only ${seed.length} seed entries are present and no text provider is configured. To enable LLM expansion, set SPRITES_TEXT_PROVIDER=azure-openai (default) and provide all of AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_CHAT_DEPLOYMENT; or set SPRITES_TEXT_PROVIDER=none to silence this warning. Proceeding with the seed unchanged.`,
    );
    return {
      variations: seed,
      seed,
      proposed: [],
      skippedReason: 'no-provider',
    };
  }
  let proposed;
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
function mergeUnique(seed, additions) {
  const seen = new Set();
  const out = [];
  const add = (entry) => {
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
//# sourceMappingURL=expand-variations.js.map
