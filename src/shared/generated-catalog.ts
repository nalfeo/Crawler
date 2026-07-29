/**
 * Generated-catalog composer — the single source of truth for turning the
 * approved-sprite manifest into the `generated:` rows of the sprite catalog.
 *
 * Why this module exists
 * ----------------------
 * The sprite catalog used to *commit* one `generated:` row per approved
 * variant, duplicating ~91% of the manifest into a second mega-file. Every
 * art check-in appended to both files, so any two parallel art PRs conflicted
 * by construction. We removed the committed `generated:` rows: they are now
 * DERIVED from the manifest at read time by this composer.
 *
 * Layer rule: lives in `src/shared/` (engine-portable, no Phaser, no `fs`) so
 * the engine, the sprite-catalog lab, the Vite build plugin, the Node build
 * script, and CI all derive rows through the *same* code path. There must be
 * exactly one derivation implementation — never a second merge path.
 *
 * Derivation rules (each verified against real committed data):
 *   - `id`/`spriteId`/`label` derive from the manifest MAP KEY, never
 *     `spriteName` (an older writer wrote a brief-wide `spriteName` that
 *     collided every variant of a brief onto one row).
 *   - Tags are semantic-type FIRST, not alphabetical:
 *     `type ? [type,'generated','pipeline-approved'] : ['generated','pipeline-approved']`.
 *     Never sort tags.
 *   - Description defaults to `Generated sprite from brief: <briefId>.`
 *   - The small set of hand-authored deviations lives on the manifest entry's
 *     optional `catalog` field (`{ description?, tags? }`), so an override
 *     shards with its asset instead of accumulating in a shared file.
 *   - Placeholder entries are excluded via ONE predicate keyed on explicit
 *     `placeholder` metadata, falling back to the asset path.
 */
import type { GeneratedManifest, ManifestEntry } from './generated-assets.js';
import type { SpriteCatalogRecord } from './sprite-catalog.js';

/** Prefix marking a catalog row as derived from the generated manifest. */
export const GENERATED_ID_PREFIX = 'generated:' as const;

/** `sheetKey` every derived generated row carries (a virtual sheet). */
export const GENERATED_SHEET_KEY = 'generated-manifest' as const;

/** Trailing tags appended after the optional semantic type. */
const BASE_GENERATED_TAGS = ['generated', 'pipeline-approved'] as const;

/**
 * True when `entry` is a placeholder stand-in rather than real generated art.
 *
 * This is the ONE canonical placeholder predicate. Explicit `placeholder`
 * metadata (set on modern shards) is AUTHORITATIVE — `placeholder: false`
 * forces "not a placeholder" even when the asset path looks placeholder-like.
 * Only when the flag is absent does it fall back to the asset path — the path
 * check is deliberately used instead of `spriteName` because two placeholder
 * entries (`crescent-glaive`, `meteor-hammer`) carry a normal key/`spriteName`
 * yet a `-placeholder.png` asset path.
 */
export function isPlaceholderManifestEntry(entry: ManifestEntry): boolean {
  if (typeof entry.placeholder === 'boolean') return entry.placeholder;
  return typeof entry.assetPath === 'string' && entry.assetPath.includes('-placeholder');
}

/** True when a catalog id is a derived generated row. */
export function isGeneratedCatalogId(id: string): boolean {
  return id.startsWith(GENERATED_ID_PREFIX);
}

/**
 * Derive the tag list for a generated row. An explicit `catalog.tags`
 * override wins verbatim (order preserved); otherwise the semantic type
 * leads, followed by the fixed base tags.
 */
export function deriveGeneratedTags(entry: ManifestEntry): string[] {
  const override = entry.catalog?.tags;
  if (override && override.length > 0) return [...override];
  return entry.type ? [entry.type, ...BASE_GENERATED_TAGS] : [...BASE_GENERATED_TAGS];
}

/** Default description for a generated row when no override is present. */
export function defaultGeneratedDescription(briefId: string): string {
  return `Generated sprite from brief: ${briefId}.`;
}

/** Derive the description for a generated row (override wins). */
export function deriveGeneratedDescription(entry: ManifestEntry): string {
  return entry.catalog?.description ?? defaultGeneratedDescription(entry.briefId);
}

/**
 * Derive a single `generated:` catalog row from a manifest entry and its map
 * key. Caller is responsible for placeholder filtering (see
 * {@link deriveGeneratedCatalogRows}).
 */
export function deriveGeneratedCatalogRow(
  manifestKey: string,
  entry: ManifestEntry,
): SpriteCatalogRecord {
  const row: SpriteCatalogRecord = {
    id: `${GENERATED_ID_PREFIX}${manifestKey}`,
    kind: 'sprite',
    label: manifestKey,
    description: deriveGeneratedDescription(entry),
    tags: deriveGeneratedTags(entry),
    spriteId: manifestKey,
    sheetKey: GENERATED_SHEET_KEY,
    assetPath: entry.assetPath,
    frame: 0,
    col: 0,
    row: 0,
  };
  return row;
}

/**
 * Derive every non-placeholder `generated:` row from a parsed manifest,
 * sorted by id for determinism. Placeholder entries are excluded.
 */
export function deriveGeneratedCatalogRows(manifest: GeneratedManifest): SpriteCatalogRecord[] {
  const rows: SpriteCatalogRecord[] = [];
  for (const [manifestKey, entry] of Object.entries(manifest.entries)) {
    if (isPlaceholderManifestEntry(entry)) continue;
    rows.push(deriveGeneratedCatalogRow(manifestKey, entry));
  }
  rows.sort((a, b) => a.id.localeCompare(b.id));
  return rows;
}

/**
 * Compose the full catalog view: the committed non-generated rows plus the
 * derived generated rows, in the canonical on-disk order (sheets first, then
 * by id). Any `generated:` rows present in `committed` are dropped and
 * replaced by the derived set, so this is idempotent even if a stray
 * generated row sneaks into the committed file.
 */
export function composeFullCatalog(
  committed: readonly SpriteCatalogRecord[],
  manifest: GeneratedManifest,
): SpriteCatalogRecord[] {
  const base = committed.filter((entry) => !isGeneratedCatalogId(entry.id));
  const combined = [...base, ...deriveGeneratedCatalogRows(manifest)];
  combined.sort(compareCatalogRows);
  return combined;
}

/** Remove all derived `generated:` rows from a catalog array. */
export function stripGeneratedRows(catalog: readonly SpriteCatalogRecord[]): SpriteCatalogRecord[] {
  return catalog.filter((entry) => !isGeneratedCatalogId(entry.id));
}

/**
 * Canonical catalog ordering: sheet entries first, then by id. Matches the
 * order historically written by `approve.ts#upsertCatalog`.
 */
function compareCatalogRows(a: SpriteCatalogRecord, b: SpriteCatalogRecord): number {
  const aKind = a.kind === 'sheet' ? 0 : 1;
  const bKind = b.kind === 'sheet' ? 0 : 1;
  if (aKind !== bKind) return aKind - bKind;
  return a.id.localeCompare(b.id);
}
