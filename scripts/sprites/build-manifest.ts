#!/usr/bin/env node
/**
 * build-manifest.ts — Compose the aggregate `manifest.json` from the per-asset
 * shards under `public/assets/generated/entries/`.
 *
 * The aggregate is a BUILD ARTIFACT, not a committed file (it is gitignored).
 * The source of truth is the shard directory; this script (and the Vite
 * plugin, `tools/vite-plugin-generated-manifest.ts`) reconstitute the single
 * aggregate the browser fetches at runtime. Keeping the aggregate uncommitted
 * is what lets two check-ins touching different assets never touch a shared
 * file.
 *
 * Usage:
 *   npx tsx scripts/sprites/build-manifest.ts [--check]
 *
 * Default: write `public/assets/generated/manifest.json` from the shards.
 * --check: compose in memory and exit non-zero if the on-disk aggregate is
 *          missing or does not match (used by CI / verify).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { composeManifestFromShards, serializeManifest } from './generated-shards.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GENERATED_DIR = path.join(repoRoot, 'public', 'assets', 'generated');
const MANIFEST_PATH = path.join(GENERATED_DIR, 'manifest.json');

function buildAggregateString(): string {
  return serializeManifest(composeManifestFromShards(GENERATED_DIR));
}

function writeAggregate(): void {
  const next = buildAggregateString();
  mkdirSync(GENERATED_DIR, { recursive: true });
  writeFileSync(MANIFEST_PATH, next);
  const count = Object.keys(JSON.parse(next).entries).length;
  console.log(`✅ Wrote ${path.relative(repoRoot, MANIFEST_PATH)} (${count} entries from shards).`);
}

function checkAggregate(): number {
  const expected = buildAggregateString();
  if (!existsSync(MANIFEST_PATH)) {
    console.error(
      `❌ ${path.relative(repoRoot, MANIFEST_PATH)} is missing. Run \`npm run sprites:build-manifest\`.`,
    );
    return 1;
  }
  const actual = readFileSync(MANIFEST_PATH, 'utf8');
  if (actual !== expected) {
    console.error(
      `❌ ${path.relative(repoRoot, MANIFEST_PATH)} is stale (does not match composed shards). ` +
        `Run \`npm run sprites:build-manifest\`.`,
    );
    return 1;
  }
  console.log('✅ Aggregate manifest matches the shards.');
  return 0;
}

const isMain =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isMain) {
  const check = process.argv.includes('--check');
  if (check) {
    process.exit(checkAggregate());
  } else {
    writeAggregate();
  }
}
