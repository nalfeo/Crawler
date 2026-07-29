/**
 * check-aggregate-row-ownership-lib.ts — Pure logic for the aggregate file
 * row-ownership guard. No git, no file I/O — all inputs are pre-parsed strings
 * so the logic is fully unit-testable without subprocess setup.
 *
 * ## What this catches
 *
 * Three classes of silent data loss on concurrent-PR merge:
 *
 * 1. **Stale row** — The PR carries the same value as the merge-base for a row
 *    that main has since advanced. On merge this silently reverts main's update.
 *    Root cause: tooling regenerated the file from a snapshot predating the
 *    other PR's merge.
 *
 * 2. **Deleted row** — The PR omits a row that exists in both the merge-base
 *    and main. Wholesale file regeneration can silently drop rows.
 *
 * 3. **Deleted field** — The PR's row is missing a top-level field that both
 *    the merge-base and main carry. This caught the confirmed `opaqueBounds`
 *    stripping incident (PR #1972).
 *
 * ## Algorithm
 *
 * For each row key K that exists in main:
 *   - If K is absent in PR head → deleted-row error.
 *   - If K exists in mergeBase AND serialize(PR[K]) == serialize(mergeBase[K])
 *     AND mergeBase[K] ≠ main[K] → stale-row error (PR is carrying the old
 *     merge-base value while main has moved forward).
 *   - If K exists in mergeBase AND for each top-level field F of mergeBase[K]:
 *     if F is in main[K] but absent in PR[K] → deleted-field error.
 *   - If K is absent in mergeBase (added to main after branch forked) and
 *     absent in PR head → deleted-row error (stale wholesale regeneration
 *     omitted a concurrently added row).
 *
 * ## Why Algorithm B (stale-only) not Algorithm A (every change must match main)
 *
 * Algorithm A fires a false positive whenever a PR legitimately updates an
 * existing row to a value not yet on main (e.g. advancing a boss-ability from
 * "in-progress" to "verified"). Algorithm B only fires when the PR is carrying
 * the exact stale merge-base value while main has already moved past it — no
 * false positives for legitimate updates.
 *
 * ## Registered files
 *
 * - public/assets/generated/manifest.json — sprite approval entries (by key)
 * - scripts/agent/data/boss-abilities.floor2.status.json — ability/gate rows
 *
 * sprite-catalog.json was removed from the commit write-path in PR #2248 and
 * is therefore excluded from the registry.
 */

/** Row map: rowKey → canonicalized JSON string of the row value. */
export type RowMap = ReadonlyMap<string, string>;

/** A finding emitted by checkRowOwnership. */
export interface OwnershipFinding {
  /** The row key, e.g. the entry key in manifest or the abilityId. */
  readonly rowKey: string;
  /** What class of violation was detected. */
  readonly kind: 'stale' | 'deleted-row' | 'deleted-field';
  /** For deleted-field: the top-level field name that was removed. */
  readonly fieldPath?: string;
  /** Human-readable explanation. */
  readonly detail: string;
}

/** Aggregated result of checkRowOwnership over one file. */
export interface OwnershipCheckResult {
  readonly findings: readonly OwnershipFinding[];
  /** Number of rows that were compared (exists in main). */
  readonly rowsChecked: number;
}

/**
 * Serialize a parsed JSON value to a stable canonical string.
 * Object keys are recursively sorted; arrays and primitives pass through.
 * This avoids false positives from formatting-only differences.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalizeInner(value));
}

function canonicalizeInner(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalizeInner);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) {
    out[key] = canonicalizeInner(obj[key]);
  }
  return out;
}

/** Parse a manifest.json and return rows keyed by entry key. */
export function extractManifestRows(content: string): RowMap {
  const parsed = JSON.parse(content) as { entries?: Record<string, unknown> };
  const entries = parsed.entries ?? {};
  if (typeof entries !== 'object' || Array.isArray(entries)) {
    throw new Error('manifest.json: expected entries to be an object');
  }
  const rows = new Map<string, string>();
  for (const [key, entry] of Object.entries(entries)) {
    rows.set(key, canonicalize(entry));
  }
  return rows;
}

/**
 * Parse a boss-abilities.floor2.status.json and return rows.
 * Entries are keyed as `entry:<abilityId>`, gates as `gate:<id>`.
 * Throws on duplicate keys or missing id fields.
 */
export function extractBossAbilityRows(content: string): RowMap {
  const parsed = JSON.parse(content) as {
    entries?: Array<Record<string, unknown>>;
    gates?: Array<Record<string, unknown>>;
  };
  const rows = new Map<string, string>();

  // entries: keyed by abilityId
  const seenAbilityIds = new Set<string>();
  for (const entry of parsed.entries ?? []) {
    const id = entry['abilityId'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `boss-abilities: entry is missing a string abilityId: ${JSON.stringify(entry).slice(0, 80)}`,
      );
    }
    if (seenAbilityIds.has(id)) {
      throw new Error(`boss-abilities: duplicate abilityId "${id}"`);
    }
    seenAbilityIds.add(id);
    rows.set(`entry:${id}`, canonicalize(entry));
  }

  // gates: keyed by id
  const seenGateIds = new Set<string>();
  for (const gate of parsed.gates ?? []) {
    const id = gate['id'];
    if (typeof id !== 'string' || id.length === 0) {
      throw new Error(
        `boss-abilities: gate is missing a string id: ${JSON.stringify(gate).slice(0, 80)}`,
      );
    }
    if (seenGateIds.has(id)) {
      throw new Error(`boss-abilities: duplicate gate id "${id}"`);
    }
    seenGateIds.add(id);
    rows.set(`gate:${id}`, canonicalize(gate));
  }

  return rows;
}

/**
 * Check for row ownership violations across three versions of an aggregate file.
 *
 * @param prRows - rows extracted from the PR head version of the file
 * @param mergeBaseRows - rows extracted from the merge-base version
 * @param mainRows - rows extracted from the origin/main version
 */
export function checkRowOwnership(
  prRows: RowMap,
  mergeBaseRows: RowMap,
  mainRows: RowMap,
): OwnershipCheckResult {
  const findings: OwnershipFinding[] = [];
  let rowsChecked = 0;

  for (const [key, mainValue] of mainRows) {
    const mergeBaseValue = mergeBaseRows.get(key);

    rowsChecked++;
    const prValue = prRows.get(key);

    // Main-only key: added to main after this branch forked.
    // If the PR omits it, a stale wholesale regeneration silently dropped a
    // concurrently added row.
    if (mergeBaseValue === undefined) {
      if (prValue === undefined) {
        findings.push({
          rowKey: key,
          kind: 'deleted-row',
          detail:
            `Row '${key}' was added to origin/main after this branch forked but is absent ` +
            `in this PR's version of the file. A stale wholesale regeneration of the file ` +
            `omitted a concurrently added row. ` +
            `Fix: rebase onto origin/main so the row appears in the regenerated output.`,
        });
      }
      continue;
    }

    // Row exists in both mergeBase and main.

    // Rule 1: Row deleted by PR
    if (prValue === undefined) {
      findings.push({
        rowKey: key,
        kind: 'deleted-row',
        detail:
          `Row '${key}' exists in both the merge-base and origin/main ` +
          `but is absent in this PR's version of the file. ` +
          `If the deletion is intentional, remove the row from origin/main first.`,
      });
      continue;
    }

    // Rule 2: Stale row — PR carries the exact merge-base value while main has advanced.
    if (prValue === mergeBaseValue && mergeBaseValue !== mainValue) {
      findings.push({
        rowKey: key,
        kind: 'stale',
        detail:
          `Row '${key}' has the same value as the merge-base, but origin/main ` +
          `has a newer value for this row. This PR is carrying a stale copy that ` +
          `would silently revert main's update on merge. ` +
          `Fix: rebase onto origin/main (or update the row to match main's value if the ` +
          `stale content was written by tooling that regenerated the file wholesale).`,
      });
      continue; // Don't also report field deletions for the same stale row.
    }

    // Rule 3: Per-field checks — row exists in all three versions and PR changed the row.
    // (Rule 2 covers the whole-row stale case; we reach here only when PR[key] != mergeBase[key].)
    //
    // For each field that appears in main (the authoritative source):
    //   a. Main-only field (added after branch fork) absent from PR → deleted-field.
    //   b. Field in both mergeBase and main, deleted by PR → deleted-field.
    //   c. Field in both mergeBase and main, present in PR but kept at the stale merge-base
    //      value while main has advanced it → stale (field-level).
    const mergeBaseParsed = JSON.parse(mergeBaseValue) as Record<string, unknown>;
    const mainParsed = JSON.parse(mainValue) as Record<string, unknown>;
    const prParsed = JSON.parse(prValue) as Record<string, unknown>;

    for (const field of Object.keys(mainParsed)) {
      const fieldInMergeBase = field in mergeBaseParsed;
      const fieldInPr = field in prParsed;

      if (!fieldInMergeBase) {
        // Field only in main (added after branch fork) — if PR omits it, flag it.
        if (!fieldInPr) {
          findings.push({
            rowKey: key,
            kind: 'deleted-field',
            fieldPath: field,
            detail:
              `Row '${key}': field '${field}' was added to origin/main after this branch ` +
              `forked but is absent from this PR's version of the row. ` +
              `Fix: rebase onto origin/main or add the missing field.`,
          });
        }
        continue;
      }

      // Field exists in both mergeBase and main.
      const mergeBaseFieldStr = canonicalize(mergeBaseParsed[field]);
      const mainFieldStr = canonicalize(mainParsed[field]);

      if (!fieldInPr) {
        // Rule 3b: Field deleted by PR but present in both mergeBase and main.
        findings.push({
          rowKey: key,
          kind: 'deleted-field',
          fieldPath: field,
          detail:
            `Row '${key}': field '${field}' was removed by this PR but exists ` +
            `in both the merge-base and origin/main. If removal is intentional, ` +
            `the field must also be removed from origin/main before this PR merges.`,
        });
        continue;
      }

      // Rule 3c: Field-level stale — PR updated other fields but left this one at the
      // stale merge-base value while main has since advanced it.
      const prFieldStr = canonicalize(prParsed[field]);
      if (prFieldStr === mergeBaseFieldStr && mergeBaseFieldStr !== mainFieldStr) {
        findings.push({
          rowKey: key,
          kind: 'stale',
          fieldPath: field,
          detail:
            `Row '${key}': field '${field}' has the same value as the merge-base, ` +
            `but origin/main has a newer value for this field. This PR updated other ` +
            `fields in the row but left '${field}' at the stale merge-base value, ` +
            `which would silently revert main's update on merge. ` +
            `Fix: update this field to match origin/main's value.`,
        });
      }
    }
  }

  return { findings, rowsChecked };
}

/** Configuration for one registered aggregate file. */
export interface RegistryEntry {
  /** Repo-relative POSIX path. */
  readonly path: string;
  /** Parses the file content and returns a row map. */
  readonly extractRows: (content: string) => RowMap;
}

/**
 * The registered aggregate files the guard checks.
 *
 * sprite-catalog.json is intentionally excluded: it was removed from the
 * commit write-path in PR #2248, so there is no regeneration path to guard.
 */
export const REGISTRY: readonly RegistryEntry[] = [
  {
    path: 'public/assets/generated/manifest.json',
    extractRows: extractManifestRows,
  },
  {
    path: 'scripts/agent/data/boss-abilities.floor2.status.json',
    extractRows: extractBossAbilityRows,
  },
];

/**
 * Minimum expected row count across all files when the guard runs.
 * A count of 0 in CI is treated as a configuration failure (canary check).
 */
export const MIN_EXPECTED_ROWS_IN_CI = 1;
