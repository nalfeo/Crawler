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

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const apply = process.argv.includes('--apply');

function fromRepo(rel: string): string {
  const here = new URL(import.meta.url).pathname;
  const repoRoot = path.resolve(path.dirname(here), '..', '..');
  return path.resolve(repoRoot, rel);
}

// ---------------------------------------------------------------------------
// manifest.json
// ---------------------------------------------------------------------------

const MANIFEST_PATH = path.join('public', 'assets', 'generated', 'manifest.json');

function sortManifest(): void {
  const absPath = fromRepo(MANIFEST_PATH);
  const manifest = JSON.parse(readFileSync(absPath, 'utf8')) as {
    version: number;
    entries: Record<string, unknown>;
  };

  const sorted = { ...manifest };
  sorted.entries = Object.fromEntries(
    Object.entries(manifest.entries).sort(([a], [b]) => a.localeCompare(b)),
  );

  const out = JSON.stringify(sorted, null, 2) + '\n';
  if (apply) {
    writeFileSync(absPath, out);
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

function sortCatalog(): void {
  const absPath = fromRepo(CATALOG_PATH);
  const catalog = JSON.parse(readFileSync(absPath, 'utf8')) as CatalogEntry[];

  catalog.sort((a, b) => {
    const aGroup = a.kind === 'sheet' ? 0 : 1;
    const bGroup = b.kind === 'sheet' ? 0 : 1;
    if (aGroup !== bGroup) return aGroup - bGroup;
    return (a.id ?? '').localeCompare(b.id ?? '');
  });

  const out = JSON.stringify(catalog, null, 2) + '\n';
  if (apply) {
    writeFileSync(absPath, out);
    console.log(`✅ Sorted ${CATALOG_PATH}`);
  } else {
    console.log(`[dry-run] Would sort entries in ${CATALOG_PATH}`);
  }
}

sortManifest();
sortCatalog();

if (!apply) {
  console.log('\nRe-run with --apply to write changes.');
}
