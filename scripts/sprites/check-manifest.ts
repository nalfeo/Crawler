/**
 * CI invariant checker for the sharded generated manifest + derived catalog.
 *
 * The generated manifest source of truth is a directory of per-asset shards
 * (`public/assets/generated/entries/<key>.json`); the aggregate
 * `manifest.json` is a gitignored build artifact, and the `generated:` rows of
 * `src/shared/data/sprite-catalog.json` are DERIVED from the shards at read
 * time. This checker enforces the invariants that keep that arrangement honest,
 * so a regression (a re-committed `generated:` row, a malformed shard, a
 * key/id collision) fails CI deterministically instead of silently rotting.
 *
 * Checks (all deterministic, exit-coded):
 *   1. Every shard parses against the manifest-entry schema.
 *   2. Composing the aggregate from shards is deterministic (stable output).
 *   3. The committed `sprite-catalog.json` contains NO `generated:` ids
 *      (they must be derived, never committed).
 *   4. The composed full catalog (committed non-generated rows + derived
 *      generated rows) has unique ids — no committed row collides with a
 *      derived generated row.
 *   5. Every non-placeholder shard derives exactly one row.
 *   6. The aggregate `manifest.json` is NOT tracked by git. It is a build
 *      artifact composed from shards; a re-committed (resurrected) aggregate
 *      would silently diverge from the shards, so its presence in the index is
 *      a hard failure rather than latent corruption.
 *
 * Usage: `npm run sprites:check-manifest`
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseGeneratedManifest, manifestEntrySchema } from '../../src/shared/generated-assets.js';
import {
  composeFullCatalog,
  deriveGeneratedCatalogRows,
  isGeneratedCatalogId,
  isPlaceholderManifestEntry,
} from '../../src/shared/generated-catalog.js';
import { parseSpriteCatalog } from '../../src/shared/sprite-catalog.js';
import {
  composeManifestFromShards,
  keyFromShardRelPath,
  listShardRelPaths,
  readAllShards,
  serializeManifest,
  shardsDir,
} from './generated-shards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const GENERATED_DIR = path.join(REPO_ROOT, 'public', 'assets', 'generated');
const CATALOG_PATH = path.join(REPO_ROOT, 'src', 'shared', 'data', 'sprite-catalog.json');

function main(): void {
  const errors: string[] = [];

  // 1. Every shard parses against the schema and its filename is its key.
  const relPaths = listShardRelPaths(GENERATED_DIR);
  const dir = shardsDir(GENERATED_DIR);
  let shardCount = 0;
  for (const rel of relPaths) {
    const key = keyFromShardRelPath(rel);
    const abs = path.join(dir, ...rel.split('/'));
    let parsedUnknown: unknown;
    try {
      parsedUnknown = JSON.parse(readFileSync(abs, 'utf8'));
    } catch (err) {
      errors.push(`shard ${rel}: not valid JSON — ${err instanceof Error ? err.message : err}`);
      continue;
    }
    const result = manifestEntrySchema.safeParse(parsedUnknown);
    if (!result.success) {
      errors.push(`shard ${rel} (key "${key}"): schema violation — ${result.error.message}`);
      continue;
    }
    shardCount += 1;
  }

  // 2. Composition is deterministic (stable serialization across two reads).
  const manifest = composeManifestFromShards(GENERATED_DIR);
  const first = serializeManifest(manifest);
  const second = serializeManifest(composeManifestFromShards(GENERATED_DIR));
  if (first !== second) {
    errors.push('aggregate composition from shards is not deterministic');
  }

  // Re-parse the composed aggregate to prove it is a valid manifest as a whole.
  try {
    parseGeneratedManifest(JSON.parse(first));
  } catch (err) {
    errors.push(
      `composed aggregate fails manifest schema — ${err instanceof Error ? err.message : err}`,
    );
  }

  // 3. Committed catalog contains no `generated:` ids.
  const committed = parseSpriteCatalog(JSON.parse(readFileSync(CATALOG_PATH, 'utf8')));
  const committedGenerated = committed.filter((row) => isGeneratedCatalogId(row.id));
  if (committedGenerated.length > 0) {
    const sample = committedGenerated
      .slice(0, 5)
      .map((row) => row.id)
      .join(', ');
    errors.push(
      `sprite-catalog.json contains ${committedGenerated.length} committed generated: ` +
        `row(s) (e.g. ${sample}) — generated rows must be derived, not committed`,
    );
  }

  // 4. Composed full catalog has unique ids.
  const full = composeFullCatalog(committed, manifest);
  const seen = new Map<string, number>();
  for (const row of full) {
    seen.set(row.id, (seen.get(row.id) ?? 0) + 1);
  }
  const dupes = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  if (dupes.length > 0) {
    errors.push(`composed catalog has duplicate ids: ${dupes.slice(0, 10).join(', ')}`);
  }

  // 5. Every non-placeholder shard derives exactly one row.
  const allShards = readAllShards(GENERATED_DIR);
  const nonPlaceholder = Object.values(allShards).filter(
    (entry) => !isPlaceholderManifestEntry(entry),
  ).length;
  const derived = deriveGeneratedCatalogRows(manifest).length;
  if (derived !== nonPlaceholder) {
    errors.push(
      `derived generated rows (${derived}) != non-placeholder shards (${nonPlaceholder})`,
    );
  }

  // 6. The aggregate manifest.json must not be tracked by git (resurrection
  //    guard). Existence on disk is fine — it is a gitignored build artifact —
  //    but being in the index means it will drift from the shards silently.
  const aggregateRel = 'public/assets/generated/manifest.json';
  try {
    const tracked = execFileSync('git', ['ls-files', '--', aggregateRel], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    }).trim();
    if (tracked.length > 0) {
      errors.push(
        `${aggregateRel} is tracked by git — it must be a gitignored build ` +
          `artifact composed from shards, not a committed file (run ` +
          `\`git rm --cached ${aggregateRel}\`)`,
      );
    }
  } catch (err) {
    // git unavailable (e.g. a source tarball) — skip rather than false-fail.
    console.warn(
      `  (skipped aggregate resurrection check: git unavailable — ${
        err instanceof Error ? err.message : err
      })`,
    );
  }

  if (errors.length > 0) {
    console.error('✗ generated-manifest invariant check failed:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  console.log(
    `✓ generated-manifest invariants hold: ${shardCount} shards, ` +
      `${derived} derived generated rows, ${committed.length - committedGenerated.length} committed non-generated rows.`,
  );
}

main();
