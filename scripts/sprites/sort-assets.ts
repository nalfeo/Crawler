#!/usr/bin/env node
/**
 * sort-assets.ts — One-shot normalizer for manifest.json and sprite-catalog.json.
 *
 * Usage:
 *   npx tsx scripts/sprites/sort-assets.ts [--apply]
 *
 * Without --apply: prints what would change (dry-run).
 * With --apply:    sorts and writes both files in place.
 *
 * Canonical order:
 *   manifest.json       → entry keys sorted lexicographically.
 *   sprite-catalog.json → sheet entries first (kind="sheet"), then by id.
 *
 * This matches the sort order enforced on every write by:
 *   - scripts/sprites/approve.ts > upsertManifest
 *   - scripts/sprites/approve.ts > upsertCatalog
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { writeCatalogJson } from './catalog-io.js';

const apply = process.argv.includes('--apply');

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// manifest.json
// ---------------------------------------------------------------------------

const MANIFEST_PATH = path.join('public', 'assets', 'generated', 'manifest.json');

async function sortManifest(): Promise<void> {
  const absPath = path.resolve(repoRoot, MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(absPath, 'utf8')) as {
    version: number;
    entries: Record<string, unknown>;
  };

  const sorted = { ...manifest };
  sorted.entries = Object.fromEntries(
    Object.entries(manifest.entries).sort(([a], [b]) => a.localeCompare(b)),
  );

  if (apply) {
    // Write through the canonical formatter so the result exactly matches
    // what approve.ts / checkin-runtime.ts produce (Prettier-formatted JSON).
    await writeCatalogJson(absPath, sorted);
    console.log(`✅ Sorted ${MANIFEST_PATH}`);
  } else {
    console.log(`[dry-run] Would sort entries in ${MANIFEST_PATH}`);
  }
}

// ---------------------------------------------------------------------------
// sprite-catalog.json
// ---------------------------------------------------------------------------

const CATALOG_PATH = path.join('src', 'shared', 'data', 'sprite-catalog.json');

interface CatalogEntry {
  id: string;
  kind: string;
  [key: string]: unknown;
}

async function sortCatalog(): Promise<void> {
  const absPath = path.resolve(repoRoot, CATALOG_PATH);
  const catalog = JSON.parse(readFileSync(absPath, 'utf8')) as CatalogEntry[];

  catalog.sort((a, b) => {
    const aGroup = a.kind === 'sheet' ? 0 : 1;
    const bGroup = b.kind === 'sheet' ? 0 : 1;
    if (aGroup !== bGroup) return aGroup - bGroup;
    return (a.id ?? '').localeCompare(b.id ?? '');
  });

  if (apply) {
    // Use the canonical catalog writer so tags arrays are Prettier-compacted
    // (same format as approve.ts), preventing churn on subsequent writes.
    await writeCatalogJson(absPath, catalog);
    console.log(`✅ Sorted ${CATALOG_PATH}`);
  } else {
    console.log(`[dry-run] Would sort entries in ${CATALOG_PATH}`);
  }
}

await sortManifest();
await sortCatalog();

if (!apply) {
  console.log('\nRe-run with --apply to write changes.');
}
