#!/usr/bin/env node
/**
 * check-sort-assets.ts — Verify that manifest.json and sprite-catalog.json
 * have entries in canonical sorted order.
 *
 * Canonical order:
 *   manifest.json      → entries keyed by string, sorted lexicographically.
 *   sprite-catalog.json → array sorted by: sheet entries first (kind="sheet"),
 *                         then by id lexicographically within each kind group.
 *
 * This matches the sort order enforced by:
 *   - scripts/sprites/approve.ts > upsertManifest (manifest)
 *   - scripts/sprites/approve.ts > upsertCatalog  (catalog)
 *
 * Keeping both files sorted means concurrent sprite PRs that add entries at
 * different alphabetical positions produce non-overlapping line changes →
 * git's 3-way merge succeeds without conflicts.
 *
 * Run automatically in CI (check-lightweight job). Fix violations with:
 *   npx tsx scripts/sprites/sort-assets.ts --apply
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const MANIFEST_PATH = path.join('public', 'assets', 'generated', 'manifest.json');
const CATALOG_PATH = path.join('src', 'shared', 'data', 'sprite-catalog.json');

function fromRepo(rel: string): string {
  // When invoked from any CWD, resolve relative to the repo root (two levels
  // up from scripts/sprites/).
  const here = new URL(import.meta.url).pathname;
  const repoRoot = path.resolve(path.dirname(here), '..', '..');
  return path.resolve(repoRoot, rel);
}

interface ManifestShape {
  version: number;
  entries: Record<string, unknown>;
}

interface CatalogEntry {
  id: string;
  kind: string;
  [key: string]: unknown;
}

function checkManifest(): string[] {
  const errors: string[] = [];
  const absPath = fromRepo(MANIFEST_PATH);

  let manifest: ManifestShape;
  try {
    manifest = JSON.parse(readFileSync(absPath, 'utf8')) as ManifestShape;
  } catch {
    errors.push(`Cannot parse ${MANIFEST_PATH}`);
    return errors;
  }

  if (!manifest.entries || typeof manifest.entries !== 'object') {
    errors.push(`${MANIFEST_PATH}: missing "entries" object`);
    return errors;
  }

  const keys = Object.keys(manifest.entries);
  for (let i = 1; i < keys.length; i++) {
    const prev = keys[i - 1]!;
    const curr = keys[i]!;
    if (prev.localeCompare(curr) > 0) {
      errors.push(
        `${MANIFEST_PATH}: entry keys out of order at position ${i}: ` +
          `"${prev}" should come after "${curr}". ` +
          `Run \`npx tsx scripts/sprites/sort-assets.ts --apply\` to fix.`,
      );
      // Report first violation only to keep output readable.
      break;
    }
  }

  return errors;
}

function checkCatalog(): string[] {
  const errors: string[] = [];
  const absPath = fromRepo(CATALOG_PATH);

  let catalog: CatalogEntry[];
  try {
    const raw = JSON.parse(readFileSync(absPath, 'utf8'));
    if (!Array.isArray(raw)) {
      errors.push(`${CATALOG_PATH}: expected a JSON array`);
      return errors;
    }
    catalog = raw as CatalogEntry[];
  } catch {
    errors.push(`Cannot parse ${CATALOG_PATH}`);
    return errors;
  }

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
      errors.push(
        `${CATALOG_PATH}: entries out of order at index ${i}: ` +
          `"${prevId}" (kind=${prev.kind}) should come after "${currId}" (kind=${curr.kind}). ` +
          `Run \`npx tsx scripts/sprites/sort-assets.ts --apply\` to fix.`,
      );
      break;
    }
  }

  return errors;
}

const allErrors = [...checkManifest(), ...checkCatalog()];

if (allErrors.length > 0) {
  console.error('\n❌ Asset sort check failed:\n');
  for (const err of allErrors) {
    console.error(`  ${err}`);
  }
  console.error('');
  process.exit(1);
} else {
  console.log('✅ manifest.json and sprite-catalog.json are correctly sorted.');
}
