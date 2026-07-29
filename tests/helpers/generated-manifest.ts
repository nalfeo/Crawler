/**
 * Test helper: load the shipped generated manifest.
 *
 * The aggregate `public/assets/generated/manifest.json` is a build artifact and
 * is NOT committed — the source of truth is the per-asset shard directory
 * (`public/assets/generated/entries/<key>.json`). Tests that used to
 * `readFileSync` the aggregate must compose it from shards instead. This helper
 * routes through the single Node-side composer so there is one implementation.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  composeManifestFromShards,
  serializeManifest,
  shardsDir,
} from '../../scripts/sprites/generated-shards.js';
import type { GeneratedManifest } from '../../src/shared/generated-assets.js';

/** Absolute path to the shipped generated dir (`public/assets/generated`). */
const SHIPPED_GENERATED_DIR = fileURLToPath(
  new URL('../../public/assets/generated', import.meta.url),
);

/**
 * True when the shipped shard directory has content on disk. Fresh checkouts
 * with no generated art return false so art-conditional tests can skip.
 */
export function shippedManifestShardsExist(): boolean {
  const dir = shardsDir(SHIPPED_GENERATED_DIR);
  return existsSync(dir);
}

/** Compose the shipped aggregate manifest object from its per-asset shards. */
export function loadShippedManifest(): GeneratedManifest {
  return composeManifestFromShards(SHIPPED_GENERATED_DIR);
}

/**
 * Compose the shipped aggregate manifest and serialize it to the canonical
 * on-disk JSON string (the exact bytes the Vite plugin / build script emit).
 */
export function loadShippedManifestRaw(): string {
  return serializeManifest(loadShippedManifest());
}
