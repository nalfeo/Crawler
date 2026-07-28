/**
 * CLI: fetch the Floor 2 (industrial cave) source materials from Azure and cache
 * them under `.cache/terrain-gen/`.
 *
 * Floor 2 does not go through `composePack`. Its pools are cut from a single
 * shared base by `rebuild-shared-base-pools.ts` so neighbouring cells stay
 * cohesive, which quadrant-derivation cannot express. This CLI only produces the
 * SOURCE TEXTURE; the pool construction, silhouettes and lighting stay local and
 * deterministic.
 *
 * Usage:
 *   npx tsx scripts/sprites/terrain-packs/gen/floor2-cli.ts
 *   npx tsx scripts/sprites/terrain-packs/gen/floor2-cli.ts --force
 *
 * Raw Azure output is cached, so only the first run costs credits.
 */
import path from 'node:path';
import { generateMaterial, loadEnvLocal } from './azure-image.js';
import { FLOOR2_INDUSTRIAL_CAVE_MATERIALS } from './materials.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

async function main(): Promise<void> {
  const force = process.argv.slice(2).includes('--force');
  loadEnvLocal(REPO_ROOT);

  // Serial, never Promise.all: the S0 image tier throttles concurrent
  // generations, and a 429 storm is slower than issuing them one at a time.
  for (const spec of Object.values(FLOOR2_INDUSTRIAL_CAVE_MATERIALS)) {
    const result = await generateMaterial({
      repoRoot: REPO_ROOT,
      cacheKey: spec.cacheKey,
      prompt: spec.prompt,
      force,
    });
    console.log(`  material ${spec.cacheKey}: ${result.fromCache ? 'cache' : 'generated'}`);
  }
  console.log('\nFloor 2 materials ready in .cache/terrain-gen/');
}

await main();
