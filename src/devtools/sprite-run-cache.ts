// Client-side instant-first-paint cache for the sidecar run list.
//
// `GET /api/runs` costs one sequential Azure blob GET per run, so on every page
// reload/navigation the run-picker dropdowns start empty and the operator must
// wait for that whole slow fetch before they can pick a run. Mirroring the
// workflow-queue convention ("localStorage is only a cache for instant first
// paint and offline use; the sidecar is the source of truth"), we persist each
// successful run list to localStorage and hydrate the dropdowns from it
// synchronously on load, then revalidate from the sidecar in the background.
//
// This module is intentionally pure and DOM-free so it is node-unit-testable;
// the thin localStorage/`window` wrappers live in `devtools-main.ts`.

import type { SidecarRunListEntry } from './sprite-approval-api.js';

/** Server-side `promoted` filter the run list can be scoped by. */
export type PromotedFilter = 'all' | 'promoted' | 'not-promoted';

/** localStorage key for the cached run lists. Bump the suffix on schema breaks. */
export const RUN_CACHE_STORAGE_KEY = 'crawler.devtools.sprite-run-cache.v1';

const CACHE_VERSION = 1;
const PROMOTED_FILTERS: readonly PromotedFilter[] = ['all', 'promoted', 'not-promoted'];

interface RunCacheEnvelope {
  readonly version: number;
  readonly byFilter: Partial<Record<PromotedFilter, SidecarRunListEntry[]>>;
}

/** Narrow an arbitrary value to one of the known promoted-filter strings. */
export function isPromotedFilter(value: unknown): value is PromotedFilter {
  return value === 'all' || value === 'promoted' || value === 'not-promoted';
}

/** Coerce an arbitrary value to a `PromotedFilter`, defaulting to `'all'`. */
export function normalizePromotedFilter(value: unknown): PromotedFilter {
  return isPromotedFilter(value) ? value : 'all';
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

// `chosenIndex` (an array index) and `candidateCount` (a count) are only ever
// non-negative; the UI guards on `>= 0`, so a negative value is corrupt cache
// data and the entry is rejected wholesale (see sanitizeRunEntry).
function isNullableNonNegativeInteger(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

/**
 * Validate one cached run entry. Returns a fresh, fully-typed entry or `null`
 * for anything malformed (missing/typo'd fields, wrong types, bad enum) so a
 * corrupted cache can never leak partial rows into the picker.
 */
export function sanitizeRunEntry(value: unknown): SidecarRunListEntry | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Record<string, unknown>;
  if (typeof entry.briefId !== 'string' || entry.briefId.length === 0) return null;
  if (typeof entry.runId !== 'string' || entry.runId.length === 0) return null;
  if (!isNullableString(entry.timestamp)) return null;
  if (!isNullableString(entry.briefHash)) return null;
  if (!isNullableNonNegativeInteger(entry.chosenIndex)) return null;
  if (!isNullableNonNegativeInteger(entry.candidateCount)) return null;
  if (typeof entry.hasJudge !== 'boolean') return null;
  if (entry.promotionState !== 'promoted' && entry.promotionState !== 'not-promoted') return null;
  return {
    briefId: entry.briefId,
    runId: entry.runId,
    timestamp: entry.timestamp,
    briefHash: entry.briefHash,
    chosenIndex: entry.chosenIndex,
    candidateCount: entry.candidateCount,
    hasJudge: entry.hasJudge,
    promotionState: entry.promotionState,
  };
}

/** Sanitize a run-list slot: drop bad entries, keep good ones; `null` if not an array. */
function sanitizeRunList(value: unknown): SidecarRunListEntry[] | null {
  if (!Array.isArray(value)) return null;
  const runs: SidecarRunListEntry[] = [];
  for (const item of value) {
    const entry = sanitizeRunEntry(item);
    if (entry) runs.push(entry);
  }
  return runs;
}

/** Parse + validate the stored envelope. `null` on any problem (never throws). */
function parseEnvelope(raw: string | null | undefined): RunCacheEnvelope | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const envelope = parsed as Record<string, unknown>;
  // Version mismatch → treat as never-cached so a stale schema is replaced on
  // the next successful write rather than half-read.
  if (envelope.version !== CACHE_VERSION) return null;
  if (!envelope.byFilter || typeof envelope.byFilter !== 'object') return null;
  const byFilter: Partial<Record<PromotedFilter, SidecarRunListEntry[]>> = {};
  for (const filter of PROMOTED_FILTERS) {
    const slot = (envelope.byFilter as Record<string, unknown>)[filter];
    if (slot === undefined) continue;
    const runs = sanitizeRunList(slot);
    if (runs) byFilter[filter] = runs;
  }
  return { version: CACHE_VERSION, byFilter };
}

/**
 * Read the cached run list for `filter`. Returns `null` when there is no cached
 * slot for that filter (never cached / unparseable / version mismatch) — which
 * the caller must treat differently from a cached empty list (`[]`, "the store
 * genuinely had no runs"): only `null` should trigger a blocking first fetch.
 */
export function readRunCache(
  raw: string | null | undefined,
  filter: PromotedFilter,
): SidecarRunListEntry[] | null {
  const envelope = parseEnvelope(raw);
  if (!envelope) return null;
  const slot = envelope.byFilter[filter];
  return slot ? [...slot] : null;
}

/**
 * Merge `runs` into the `filter` slot of the existing envelope (preserving the
 * other filters' cached slots) and return the serialized string to persist. A
 * malformed/absent/mismatched existing value is discarded and replaced with a
 * fresh envelope containing only this slot.
 */
export function writeRunCache(
  raw: string | null | undefined,
  filter: PromotedFilter,
  runs: readonly SidecarRunListEntry[],
): string {
  const existing = parseEnvelope(raw);
  const byFilter: Partial<Record<PromotedFilter, SidecarRunListEntry[]>> = existing
    ? { ...existing.byFilter }
    : {};
  byFilter[filter] = runs.map((run) => ({ ...run }));
  const envelope: RunCacheEnvelope = { version: CACHE_VERSION, byFilter };
  return JSON.stringify(envelope);
}

/**
 * Decide which option a run picker should select after its list is rebuilt.
 * Preserves the operator's in-progress selection first (so a background
 * revalidate can't snap the dropdown away from a run they just picked but
 * haven't loaded), then a caller-supplied fallback (e.g. the loaded
 * `debugTarget`), else `''` to let the picker default to its first option.
 */
export function resolveRunPickerSelection(
  previousKey: string,
  availableKeys: readonly string[],
  fallbackKey = '',
): string {
  if (previousKey && availableKeys.includes(previousKey)) return previousKey;
  if (fallbackKey && availableKeys.includes(fallbackKey)) return fallbackKey;
  return '';
}
