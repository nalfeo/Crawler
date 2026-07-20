/**
 * Reference selector — chooses which of OUR approved generated sprites to send
 * to Azure `images/edits` (gpt-image-1) as `image[]` reference parts, replacing
 * the retired Kenney placeholder spritesheets.
 *
 * Design goals (see plan + review ledger `2026-07-03-sprite-reference-selector`):
 *   - **Our art only.** Candidates come from the generated manifest; Kenney is
 *     never a candidate, so it can never be selected.
 *   - **Favour same-`type` examples** (lamp → other `item`s) with injected
 *     randomness, broadening to other high-quality generated art when the
 *     same-type pool is thin. Never drop below the quality floor.
 *   - **Highest quality only.** A hard eligibility floor (judge ≥ 3 or unscored,
 *     sensor ratio ≥ {@link SENSOR_FLOOR}) gates the pool before sampling, so a
 *     weak trio can never steer the judge.
 *   - **Diverse.** Candidates are collapsed to the best variant per concept so a
 *     3-ref set is 3 distinct concepts, not 3 variants of one.
 *   - **Deterministic.** Pure function of `(candidates, briefName, briefType,
 *     count, seed)`; uses {@link SeededRandom} only — never `Math.random()`.
 *     Reproducible per brief; different briefs get different sets.
 *
 * This module does NO filesystem IO. The caller (`generate-one.ts`) pre-filters
 * candidates to those whose PNG exists on disk, then passes the survivors here.
 */
import type { ManifestEntry } from '../../src/shared/generated-assets.js';
import { hashStringToSeed, SeededRandom } from '../../src/shared/random.js';
import { isSpriteType, type SpriteType } from '../../src/shared/sprite-types.js';
import { isSafeGeneratedAssetPath } from './generated-asset-path.js';
import { isPlaceholderManifestEntry, normalizeConcept } from './placeholder-audit.js';

/** Bump when the selection algorithm changes in a way that alters output. */
export const SELECTOR_VERSION = 'v1' as const;

/** Default number of reference sprites to send (matches the judge's cap). */
export const REFERENCE_COUNT = 3 as const;

/** Minimum sensor pass-ratio (n/m) an entry needs to be eligible. */
const SENSOR_FLOOR = 0.75 as const;

/** Minimum judge score (1–5) an entry needs; `null` (unscored) also passes. */
const JUDGE_FLOOR = 3 as const;

/** Floor added to every eligible entry's weight so nothing is unpickable. */
const WEIGHT_FLOOR = 0.05 as const;

export interface SelectReferencesInput {
  /** Manifest entries to choose from (typically every manifest entry). */
  readonly candidates: readonly ManifestEntry[];
  /** The brief being generated — used for exact-briefId self-exclusion. */
  readonly briefName: string;
  /** The brief's declared type — same-type candidates are favoured. */
  readonly briefType: SpriteType;
  /** How many references to select. */
  readonly count: number;
  /** Numeric RNG seed. Derive via {@link referenceSelectorSeed}. */
  readonly seed: number;
  /** Asset-level negative annotations that make a sprite ineligible as a reference. */
  readonly dislikedSpriteNames?: ReadonlySet<string>;
}

export interface ReferenceSelection {
  /** Chosen entries, in selection order. Length 0..count. */
  readonly selected: readonly ManifestEntry[];
  readonly seed: number;
  readonly requestedCount: number;
  /** Distinct eligible concepts after the quality floor + concept-collapse. */
  readonly eligibleCount: number;
  /** Of {@link eligibleCount}, how many were the same type as the brief. */
  readonly sameTypeCount: number;
}

/**
 * Derive the stable numeric seed for a brief. Namespaced + versioned so the
 * stream is stable per brief yet changes if the algorithm version bumps.
 */
export function referenceSelectorSeed(briefName: string): number {
  return hashStringToSeed(`reference-selector:${SELECTOR_VERSION}|${briefName}`);
}

/** Parse a `"n/m"` sensor score into a [0,1] ratio, or `null` if unparseable. */
function parseSensorRatio(sensorScore: string): number | null {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(sensorScore);
  if (!match) return null;
  const numerator = Number(match[1]);
  const denominator = Number(match[2]);
  if (denominator <= 0) return null;
  return Math.max(0, Math.min(1, numerator / denominator));
}

/** Parse a non-null judge score string into an integer 1–5, or `null` if unparseable. */
function parseJudge(judgeScore: string): number | null {
  // Require the entire (trimmed) string to be a bare integer. `Number.parseInt`
  // is too lenient — it would accept `"3abc"`→3, `"3.5"`→3, `"5/5"`→5, letting a
  // malformed score sneak past the quality floor.
  if (!/^\s*\d+\s*$/.test(judgeScore)) return null;
  const value = Number(judgeScore.trim());
  return Number.isInteger(value) && value >= 1 && value <= 5 ? value : null;
}

interface EligibleEntry {
  readonly entry: ManifestEntry;
  readonly concept: string;
  readonly type: SpriteType;
  readonly weight: number;
}

/**
 * Apply the hard eligibility floor + compute a sampling weight. Returns `null`
 * for entries that must never be sent (placeholders, self, off-`generated/`,
 * untyped, or below the quality floor).
 */
function toEligible(
  entry: ManifestEntry,
  briefName: string,
  dislikedSpriteNames: ReadonlySet<string>,
): EligibleEntry | null {
  if (isPlaceholderManifestEntry(entry)) return null;
  if (dislikedSpriteNames.has(entry.spriteName)) return null;
  if (entry.briefId === briefName) return null; // exact self — a v2 may still ref v1
  // Our art only: reject anything that isn't a safe, in-tree `generated/*.png`
  // path. `startsWith('generated/')` alone would let `generated/../kenney/...`
  // through and resolve outside the generated tree.
  if (!isSafeGeneratedAssetPath(entry.assetPath)) return null;
  if (entry.type == null || !isSpriteType(entry.type)) return null;

  const sensorRatio = parseSensorRatio(entry.sensorScore);
  if (sensorRatio === null || sensorRatio < SENSOR_FLOOR) return null;

  // judgeScore: `null` = legitimately unscored (allowed); a NON-null string MUST
  // parse to an integer 1–5. A present-but-malformed score fails closed — it can
  // never sneak past the quality floor by masquerading as "unscored".
  let judge: number | null = null;
  if (entry.judgeScore !== null) {
    judge = parseJudge(entry.judgeScore);
    if (judge === null) return null; // present but unparseable
    if (judge < JUDGE_FLOOR) return null;
  }

  const judgeQuality = judge === null ? 0.6 : judge / 5;
  const quality = 0.65 * sensorRatio + 0.35 * judgeQuality;
  return {
    entry,
    concept: normalizeConcept(entry.briefId),
    type: entry.type,
    weight: WEIGHT_FLOOR + quality,
  };
}

/** Deterministic total order used to stabilise the RNG stream + tie-breaks. */
function compareEligible(a: EligibleEntry, b: EligibleEntry): number {
  if (a.type !== b.type) return a.type < b.type ? -1 : 1;
  if (a.entry.briefId !== b.entry.briefId) return a.entry.briefId < b.entry.briefId ? -1 : 1;
  if (a.entry.spriteName !== b.entry.spriteName) {
    return a.entry.spriteName < b.entry.spriteName ? -1 : 1;
  }
  if (a.entry.assetPath !== b.entry.assetPath) {
    return a.entry.assetPath < b.entry.assetPath ? -1 : 1;
  }
  return 0;
}

/**
 * Collapse eligible entries to the single best-quality variant per concept.
 * Ties break by {@link compareEligible} so the choice is deterministic.
 */
function collapseByConcept(eligible: readonly EligibleEntry[]): EligibleEntry[] {
  const best = new Map<string, EligibleEntry>();
  for (const candidate of eligible) {
    const current = best.get(candidate.concept);
    if (
      current === undefined ||
      candidate.weight > current.weight ||
      (candidate.weight === current.weight && compareEligible(candidate, current) < 0)
    ) {
      best.set(candidate.concept, candidate);
    }
  }
  return Array.from(best.values()).sort(compareEligible);
}

/**
 * Weighted sample of `k` distinct entries, without replacement, from an
 * already-stably-sorted pool, using `rng`. Deterministic for a given rng stream.
 */
function weightedSampleWithoutReplacement(
  pool: readonly EligibleEntry[],
  k: number,
  rng: SeededRandom,
): ManifestEntry[] {
  const remaining = [...pool];
  const out: ManifestEntry[] = [];
  const take = Math.min(k, remaining.length);
  for (let picked = 0; picked < take; picked += 1) {
    let total = 0;
    for (const item of remaining) total += item.weight;
    let threshold = rng.next() * total;
    let index = 0;
    for (; index < remaining.length; index += 1) {
      threshold -= remaining[index]!.weight;
      if (threshold <= 0) break;
    }
    if (index >= remaining.length) index = remaining.length - 1; // float-rounding guard
    out.push(remaining[index]!.entry);
    remaining.splice(index, 1);
  }
  return out;
}

/**
 * Select up to `count` on-style reference sprites, favouring the brief's own
 * `type` with injected randomness, broadening to other high-quality generated
 * art when the same-type pool is thin. Pure + deterministic.
 *
 * Pooling:
 *   - same-type pool ≥ count → sample `count` from same-type only.
 *   - otherwise → take ALL same-type + weighted-fill the remainder from others.
 *   - fewer than `count` eligible overall → return all eligible.
 *   - zero eligible → return `[]` (caller decides how to fail — never Kenney).
 */
export function selectReferences(input: SelectReferencesInput): ReferenceSelection {
  const { candidates, briefName, briefType, count, seed } = input;
  const dislikedSpriteNames = input.dislikedSpriteNames ?? new Set<string>();

  const eligible: EligibleEntry[] = [];
  for (const candidate of candidates) {
    const result = toEligible(candidate, briefName, dislikedSpriteNames);
    if (result !== null) eligible.push(result);
  }
  const collapsed = collapseByConcept(eligible);
  const sameType = collapsed.filter((item) => item.type === briefType);
  const otherType = collapsed.filter((item) => item.type !== briefType);

  const rng = new SeededRandom(seed);
  let selected: ManifestEntry[];
  if (count <= 0) {
    selected = [];
  } else if (sameType.length >= count) {
    selected = weightedSampleWithoutReplacement(sameType, count, rng);
  } else {
    // Include every same-type example, then weighted-fill from other types.
    const fill = weightedSampleWithoutReplacement(otherType, count - sameType.length, rng);
    selected = [...sameType.map((item) => item.entry), ...fill];
  }

  return {
    selected,
    seed,
    requestedCount: count,
    eligibleCount: collapsed.length,
    sameTypeCount: sameType.length,
  };
}
