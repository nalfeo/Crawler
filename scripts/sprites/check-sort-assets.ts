#!/usr/bin/env node
/**
 * check-sort-assets.ts — Verify that sprite-catalog.json has entries in
 * canonical sorted order.
 *
 * Canonical order:
 *   sprite-catalog.json → array sorted by: sheet entries first (kind="sheet"),
 *                         then by id lexicographically within each kind group.
 *
 * This matches the sort order enforced by:
 *   - scripts/sprites/approve.ts > upsertCatalog  (catalog)
 *
 * Keeping the catalog sorted means concurrent sprite PRs that add entries at
 * different alphabetical positions produce non-overlapping line changes →
 * git's 3-way merge succeeds without conflicts. (The aggregate manifest.json is
 * now a build artifact composed from per-asset shards, so it has no committed
 * sort order to enforce.)
 *
 * Run automatically in CI (check-lightweight job). Fix violations with:
 *   npx tsx scripts/sprites/sort-assets.ts --apply
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CATALOG_PATH = path.join('src', 'shared', 'data', 'sprite-catalog.json');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface CatalogEntry {
  id: string;
  kind: string;
  [key: string]: unknown;
}

/**
 * Pure validator: checks that catalog entries are in canonical order.
 * Canonical: sheet entries (kind="sheet") come first, then non-sheet entries,
 * sorted lexicographically by id within each group.
 * Returns an array of human-readable error strings (empty = valid).
 *
 * @param catalog  Array of catalog entries to validate.
 * @param label    File label used in error messages (defaults to CATALOG_PATH).
 */
export function validateCatalogEntries(catalog: CatalogEntry[], label = CATALOG_PATH): string[] {
  function sortKey(entry: CatalogEntry): [number, string] {
    return [entry.kind === 'sheet' ? 0 : 1, entry.id ?? ''];
  }

  for (let i = 1; i < catalog.length; i++) {
    const prev = catalog[i - 1]!;
    const curr = catalog[i]!;
    const [prevGroup, prevId] = sortKey(prev);
    const [currGroup, currId] = sortKey(curr);
    const cmp = prevGroup !== currGroup ? prevGroup - currGroup : prevId.localeCompare(currId);
    if (cmp > 0) {
      return [
        `${label}: entries out of order at index ${i}: ` +
          `"${prevId}" (kind=${prev.kind}) should come after "${currId}" (kind=${curr.kind}). ` +
          `Run \`npx tsx scripts/sprites/sort-assets.ts --apply\` to fix.`,
      ];
    }
  }
  return [];
}

function checkCatalog(): string[] {
  const errors: string[] = [];
  const absPath = path.resolve(repoRoot, CATALOG_PATH);

  let catalog: CatalogEntry[];
  try {
    const raw = JSON.parse(readFileSync(absPath, 'utf8'));
    if (!Array.isArray(raw)) {
      return [`${CATALOG_PATH}: expected a JSON array`];
    }
    catalog = raw as CatalogEntry[];
  } catch {
    return [`Cannot parse ${CATALOG_PATH}`];
  }

  errors.push(...validateCatalogEntries(catalog));
  return errors;
}

// Run as CLI only when invoked directly (not when imported by tests).
const isMain =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  // The aggregate manifest.json is now a build artifact composed from per-asset
  // shards (see scripts/sprites/build-manifest.ts) — it is gitignored and may be
  // absent, and shard ordering is irrelevant to merges since each shard is its
  // own file. Only the committed catalog still needs a canonical sorted order.
  const allErrors = [...checkCatalog()];

  if (allErrors.length > 0) {
    console.error('\n❌ Asset sort check failed:\n');
    for (const err of allErrors) {
      console.error(`  ${err}`);
    }
    console.error('');
    process.exit(1);
  } else {
    console.log('✅ sprite-catalog.json is correctly sorted.');
  }
}
