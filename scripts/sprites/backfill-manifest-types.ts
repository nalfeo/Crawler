/**
 * Pure core for backfilling the `type` field on generated-manifest entries.
 *
 * The manifest predates the explicit `type` field (see ADR / approve.ts), so
 * ~half its real entries have no `type`. The reference selector favours
 * same-`type` examples, so every *real* entry must resolve to a canonical
 * {@link SpriteType}. This module resolves each entry's type through a
 * deterministic cascade and rewrites entries in a canonical key order so the
 * file stays consistent with what `approve.ts` writes for fresh entries.
 *
 * Everything here is pure: it takes an already-parsed manifest + pre-built
 * resolution sources and returns the updated entries plus coverage stats. The
 * filesystem/CLI glue (reading the catalog, briefs, override map, and writing
 * the manifest + the 100%-real-coverage preflight) lives in
 * `backfill-manifest-types-cli.ts`.
 */
import type { ManifestEntry } from '../../src/shared/generated-assets.js';
import { isSpriteType, type SpriteType } from '../../src/shared/sprite-types.js';
import { isPlaceholderManifestEntry, normalizeConcept } from './placeholder-audit.js';

/** Where a resolved type came from — surfaced for logging + tests. */
export type TypeResolutionSource =
  | 'existing'
  | 'catalog-sprite'
  | 'catalog-concept'
  | 'brief-yaml'
  | 'override'
  | 'heuristic'
  | 'unresolved';

/**
 * Pre-built, pure lookup tables the cascade consults, in priority order. The
 * CLI assembles these from `sprite-catalog.json`, on-disk brief YAML, and the
 * checked-in override map.
 */
export interface TypeResolutionSources {
  /** Catalog first-tag keyed by the exact sprite name (manifest key). */
  readonly catalogTypeBySpriteName: Readonly<Record<string, SpriteType>>;
  /**
   * Catalog types seen for each normalized concept. Only consulted when a
   * concept maps to *exactly one* type (unambiguous), so a sibling variant that
   * was tagged rescues one that wasn't.
   */
  readonly catalogTypesByConcept: Readonly<Record<string, readonly SpriteType[]>>;
  /** Brief-declared type keyed by briefId AND by normalized concept. */
  readonly briefTypeByKey: Readonly<Record<string, SpriteType>>;
  /** Hand-authored authoritative fallback, keyed by normalized concept. */
  readonly overridesByConcept: Readonly<Record<string, SpriteType>>;
}

export interface TypeResolution {
  readonly type: SpriteType | null;
  readonly source: TypeResolutionSource;
}

/**
 * Resolve one manifest entry's canonical sprite type via a deterministic
 * cascade. Returns `null` (source `unresolved`) when no source matches.
 *
 * Cascade order (first match wins):
 *   1. existing valid `entry.type` (idempotency — never clobber a good value)
 *   2. catalog first-tag for this exact sprite name (what approve wrote)
 *   3. catalog type for this concept, iff unambiguous (rescues untagged siblings)
 *   4. brief-YAML `type:` (by briefId, then by concept)
 *   5. checked-in override map (by concept)
 *   6. conservative prefix heuristic (concept begins `"<type>-"`)
 */
export function resolveManifestEntryType(
  entry: ManifestEntry,
  sources: TypeResolutionSources,
): TypeResolution {
  if (entry.type != null && isSpriteType(entry.type)) {
    return { type: entry.type, source: 'existing' };
  }

  const concept = normalizeConcept(entry.briefId);

  const bySprite = sources.catalogTypeBySpriteName[entry.spriteName];
  if (bySprite && isSpriteType(bySprite)) {
    return { type: bySprite, source: 'catalog-sprite' };
  }

  const conceptTypes = sources.catalogTypesByConcept[concept];
  if (conceptTypes && conceptTypes.length === 1 && isSpriteType(conceptTypes[0]!)) {
    return { type: conceptTypes[0]!, source: 'catalog-concept' };
  }

  const byBrief = sources.briefTypeByKey[entry.briefId] ?? sources.briefTypeByKey[concept];
  if (byBrief && isSpriteType(byBrief)) {
    return { type: byBrief, source: 'brief-yaml' };
  }

  const override = sources.overridesByConcept[concept];
  if (override && isSpriteType(override)) {
    return { type: override, source: 'override' };
  }

  // Last-resort heuristic: a leading `type-` prefix on the concept (e.g.
  // `weapon-iron-sword`). Guard the dash lookup — a dash-less concept that IS a
  // bare type (`weapon`) must not be truncated by `slice(0, -1)`.
  const dashIndex = concept.indexOf('-');
  const prefix = dashIndex >= 0 ? concept.slice(0, dashIndex) : concept;
  if (prefix && isSpriteType(prefix)) {
    return { type: prefix, source: 'heuristic' };
  }

  return { type: null, source: 'unresolved' };
}

/**
 * Known manifest-entry keys in the order `approve.ts` writes them. `type` sits
 * between `judgeScore` and `contentHash` so backfilled entries match the shape
 * of freshly-approved ones. Any unknown/passthrough keys are appended in their
 * original order.
 */
const CANONICAL_ENTRY_KEY_ORDER: readonly string[] = [
  'briefId',
  'spriteName',
  'assetPath',
  'approvedAt',
  'sourceRun',
  'variantIndex',
  'anchor',
  'anchors',
  'sensorScore',
  'judgeScore',
  'type',
  'contentHash',
];

/**
 * Rebuild an entry with `type` set (to `resolvedType`, or `null` when
 * unresolved) and its keys in the canonical order. Preserves every other field
 * — including unknown passthrough keys — exactly.
 */
export function canonicalizeEntry(
  entry: ManifestEntry,
  resolvedType: SpriteType | null,
): ManifestEntry {
  const source: Record<string, unknown> = {
    ...(entry as Record<string, unknown>),
    type: resolvedType,
  };
  const ordered: Record<string, unknown> = {};
  for (const key of CANONICAL_ENTRY_KEY_ORDER) {
    if (key in source) {
      ordered[key] = source[key];
      delete source[key];
    }
  }
  for (const [key, value] of Object.entries(source)) {
    ordered[key] = value;
  }
  return ordered as unknown as ManifestEntry;
}

export interface BackfillManifestResult {
  /** Entries with `type` filled + canonical key order, sorted by key. */
  readonly entries: Record<string, ManifestEntry>;
  /** Count of entries whose `type` value changed vs the input. */
  readonly changedCount: number;
  /** Real (non-placeholder) entry keys that could not be resolved. */
  readonly unresolvedReal: readonly string[];
  /** Placeholder entry keys that could not be resolved (allowed — left null). */
  readonly unresolvedPlaceholder: readonly string[];
  /** How many entries each cascade source resolved (for logging). */
  readonly bySource: Readonly<Record<TypeResolutionSource, number>>;
}

/**
 * Resolve + canonicalize every entry's `type`. Pure: same inputs → same output.
 * Preserves the input's top-level entry order (this backfill only adds a field;
 * it does not re-sort the manifest — `approve.ts` owns key sorting on write).
 */
export function backfillManifestTypes(
  entries: Readonly<Record<string, ManifestEntry>>,
  sources: TypeResolutionSources,
): BackfillManifestResult {
  const bySource: Record<TypeResolutionSource, number> = {
    existing: 0,
    'catalog-sprite': 0,
    'catalog-concept': 0,
    'brief-yaml': 0,
    override: 0,
    heuristic: 0,
    unresolved: 0,
  };
  const unresolvedReal: string[] = [];
  const unresolvedPlaceholder: string[] = [];
  let changedCount = 0;

  const out: Record<string, ManifestEntry> = {};
  for (const key of Object.keys(entries)) {
    const entry = entries[key]!;
    const { type, source } = resolveManifestEntryType(entry, sources);
    bySource[source] += 1;
    if (type === null) {
      (isPlaceholderManifestEntry(entry) ? unresolvedPlaceholder : unresolvedReal).push(key);
    }
    const before = entry.type ?? null;
    if (before !== type) changedCount += 1;
    out[key] = canonicalizeEntry(entry, type);
  }

  return { entries: out, changedCount, unresolvedReal, unresolvedPlaceholder, bySource };
}
