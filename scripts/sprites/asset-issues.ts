/**
 * Helpers for the asset-checkin → consolidated-PR workflow.
 *
 * `parseAssetIssueBody` extracts the machine-readable payload that
 * `checkin.ts` embeds in each `asset-checkin` issue. `mergeManifests` and
 * `mergeCatalogs` union the art surfaces from several check-in branches into
 * one, so the asset-pr skill can fold many issues into a single game PR
 * without clobbering entries.
 *
 * All functions here are PURE (no IO) so they are trivially unit-tested.
 */

import { ASSET_CHECKIN_MARKER, type AssetCheckinPayload, type CheckinAsset } from './checkin.js';

/**
 * Extract the embedded `asset-checkin:v1` payload from an issue body, or null
 * when the body has no (valid) payload. Tolerant of surrounding markdown.
 */
export function parseAssetIssueBody(body: string): AssetCheckinPayload | null {
  if (typeof body !== 'string') return null;
  const startMarker = `<!-- ${ASSET_CHECKIN_MARKER}`;
  const start = body.indexOf(startMarker);
  if (start === -1) return null;
  const afterMarker = start + startMarker.length;
  const end = body.indexOf('-->', afterMarker);
  if (end === -1) return null;
  const json = body.slice(afterMarker, end).trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isAssetCheckinPayload(parsed)) return null;
  return parsed;
}

function isAssetCheckinPayload(value: unknown): value is AssetCheckinPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.version !== 1) return false;
  if (v.state !== undefined && v.state !== 'checked-in') return false;
  if (v.filedAt !== undefined && typeof v.filedAt !== 'string') return false;
  if (typeof v.branch !== 'string' || typeof v.baseBranch !== 'string') return false;
  if (!Array.isArray(v.assets)) return false;
  return v.assets.every(isCheckinAsset);
}

function isCheckinAsset(value: unknown): value is CheckinAsset {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.assetPath === 'string' &&
    (v.manifestKey === null || typeof v.manifestKey === 'string') &&
    (v.briefId === null || typeof v.briefId === 'string') &&
    (v.variantIndex === null || typeof v.variantIndex === 'number') &&
    (v.contentHash === undefined || typeof v.contentHash === 'string')
  );
}

/** Generated-asset manifest shape (matches public/assets/generated/manifest.json). */
export interface GeneratedManifest {
  readonly version?: number;
  readonly entries: Record<string, Record<string, unknown>>;
}

/**
 * Union several manifests by entry key. Later overlays win on key collisions.
 * The result's `version` is the highest seen (defaulting to the base).
 */
export function mergeManifests(
  base: GeneratedManifest,
  ...overlays: readonly GeneratedManifest[]
): GeneratedManifest {
  const entries: Record<string, Record<string, unknown>> = { ...base.entries };
  let version = base.version ?? 1;
  for (const overlay of overlays) {
    if (typeof overlay.version === 'number') version = Math.max(version, overlay.version);
    for (const [key, entry] of Object.entries(overlay.entries ?? {})) {
      entries[key] = entry;
    }
  }
  return { version, entries };
}

/** One sprite-catalog entry (catalog is a JSON array keyed by `id`). */
export interface CatalogEntry {
  readonly id: string;
  readonly [key: string]: unknown;
}

/**
 * Union several catalog arrays by `id`. Base order is preserved; entries whose
 * id reappears in an overlay are replaced in place; brand-new ids are appended
 * in overlay order. Entries without a string `id` are dropped.
 */
export function mergeCatalogs(
  base: readonly CatalogEntry[],
  ...overlays: readonly (readonly CatalogEntry[])[]
): CatalogEntry[] {
  const order: string[] = [];
  const byId = new Map<string, CatalogEntry>();
  const ingest = (entries: readonly CatalogEntry[]): void => {
    for (const entry of entries) {
      if (typeof entry.id !== 'string') continue;
      if (!byId.has(entry.id)) order.push(entry.id);
      byId.set(entry.id, entry);
    }
  };
  ingest(base);
  for (const overlay of overlays) ingest(overlay);
  return order.map((id) => byId.get(id)!);
}
