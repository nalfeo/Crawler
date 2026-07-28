/**
 * CLI entry points for terrain-pack build/validate.
 *
 * Usage:
 *   npx tsx scripts/sprites/terrain-packs/cli.ts build
 *   npx tsx scripts/sprites/terrain-packs/cli.ts validate
 *
 * Wired to `npm run terrain-packs:build` / `npm run terrain-packs:validate`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeIndustrialCavePack } from './build-industrial-cave.js';
import { writeCaelesFixturePack } from './build-caeles-fixture.js';
import { applySharedBasePoolRestyle } from './rebuild-shared-base-pools.js';
import {
  validateTerrainPack,
  validatePoolAndDoorImages,
  validateManifestSchema,
  validateWallAutotileImagePath,
  validateWallAccentImagePaths,
  validateWallAccentTopology,
  validateCrossPackWallSilhouettes,
  validateVariantTransformEligibility,
} from './validate.js';
import { decodePng } from './png-buffer.js';
import {
  RUNTIME_TERRAIN_PACK_IDS,
  type TerrainPackDef,
} from '../../../src/shared/terrain-pack-types.js';
import { getAvailableFloorIds, getFloorManifest } from '../../../src/shared/floor-registry.js';

function repoRootFromHere(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

function runBuild(): void {
  const repoRoot = repoRootFromHere();
  writeIndustrialCavePack(repoRoot);
  writeCaelesFixturePack(repoRoot);
  // `writeIndustrialCavePack` emits plain procedural floor/corridor tiles and a
  // manifest with no pool weights. The shipped Floor 2 art is that output plus
  // the shared-base restyle, so the two steps are ONE build — running the pack
  // write alone silently reverts the restyle and the weighted distribution.
  applySharedBasePoolRestyle();
}

function runValidate(): void {
  const repoRoot = repoRootFromHere();
  const manifestDir = path.join(repoRoot, 'src', 'shared', 'data', 'terrain-packs');
  const packs = fs
    .readdirSync(manifestDir)
    .filter((fileName) => fileName.endsWith('.manifest.json'))
    .map((fileName) => ({ id: fileName.replace(/\.manifest\.json$/, '') }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const decodedPacks: Array<{
    id: string;
    manifest: TerrainPackDef;
    wallAtlas: ReturnType<typeof decodePng>;
  }> = [];
  const coResidentPairs = new Set<string>();
  for (const floorId of getAvailableFloorIds()) {
    const floor = getFloorManifest(floorId);
    if (!floor) continue;
    const ids = [floor.terrainPackId, floor.terrainPacks?.stone, floor.terrainPacks?.cave]
      .filter((id): id is NonNullable<typeof id> => id !== undefined)
      .filter((id, index, all) => all.indexOf(id) === index)
      .sort();
    for (let leftIndex = 0; leftIndex < ids.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex++) {
        coResidentPairs.add(`${ids[leftIndex]}:${ids[rightIndex]}`);
      }
    }
  }
  let allOk = true;
  for (const pack of packs) {
    const manifestPath = path.join(
      repoRoot,
      'src',
      'shared',
      'data',
      'terrain-packs',
      `${pack.id}.manifest.json`,
    );
    if (!fs.existsSync(manifestPath)) {
      console.error(`[${pack.id}] missing manifest — run 'terrain-packs:build' first`);
      allOk = false;
      continue;
    }
    let manifestJson: unknown;
    try {
      manifestJson = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (err) {
      console.error(`[${pack.id}] manifest is not valid JSON: ${String(err)}`);
      allOk = false;
      continue;
    }

    // Schema-gate: validate before any cast or field access to prevent TypeError on malformed input.
    const schemaResult = validateManifestSchema(manifestJson);
    if (!schemaResult.ok) {
      allOk = false;
      console.error(`[${pack.id}] FAILED:`);
      for (const issue of schemaResult.issues) {
        console.error(`  - (${issue.code}) ${issue.message}`);
      }
      continue;
    }

    const manifest = manifestJson as TerrainPackDef;

    // Wall-path containment / allowed-root / existence / PNG / dimension validation
    // MUST run before any direct fs read of atlas bytes.  A schema-valid but unsafe
    // path (traversal, wrong root) is rejected here; structured issues are reported
    // and we skip the rest of this pack entirely.
    const wallPathResult = validateWallAutotileImagePath(manifest, { repoRoot });
    if (!wallPathResult.ok) {
      allOk = false;
      console.error(`[${pack.id}] FAILED:`);
      for (const issue of wallPathResult.issues) {
        console.error(`  - (${issue.code}) ${issue.message}`);
      }
      continue;
    }

    // Pool/door image paths carry their own traversal checks internally.
    const poolResult = validatePoolAndDoorImages(manifest, { repoRoot });
    const accentPathResult = validateWallAccentImagePaths(manifest, { repoRoot });

    // Now safe to read atlas bytes — path has been validated and confirmed safe above.
    const atlasRelPath = manifest.wallAutotile.imagePath.replace(/\\/g, '/');
    const atlasAbsPath = path.join(repoRoot, 'public', atlasRelPath);
    const atlasBytes = fs.readFileSync(atlasAbsPath);
    const result = validateTerrainPack(manifestJson, atlasBytes);

    const allIssues = [...result.issues, ...poolResult.issues, ...accentPathResult.issues];

    // Wall-accent topology ("no spill") — only meaningful once paths/dims are
    // confirmed safe above; skip if the accent path validation already failed
    // (avoids reading an unsafe/missing path).
    const wallAtlas = decodePng(atlasBytes);
    if (accentPathResult.ok) {
      for (const accent of manifest.wallAccents ?? []) {
        const accentAbsPath = path.join(repoRoot, 'public', accent.imagePath.replace(/\\/g, '/'));
        const accentAtlas = decodePng(fs.readFileSync(accentAbsPath));
        const topologyResult = validateWallAccentTopology(
          manifest,
          wallAtlas,
          accentAtlas,
          accent.id,
        );
        allIssues.push(...topologyResult.issues);
      }
    }

    // Transform-eligibility ("seam closure") — only meaningful once pool
    // image paths/dims are confirmed safe above.
    if (poolResult.ok) {
      for (const [label, pool] of [
        ['floorPool', manifest.floorPool] as const,
        ['corridorPool', manifest.corridorPool] as const,
      ]) {
        for (const variant of pool) {
          const variantAbsPath = path.join(
            repoRoot,
            'public',
            variant.imagePath.replace(/\\/g, '/'),
          );
          const variantImg = decodePng(fs.readFileSync(variantAbsPath));
          const transformResult = validateVariantTransformEligibility(variantImg, variant, label);
          allIssues.push(...transformResult.issues);
        }
      }
    }

    if (result.ok && poolResult.ok && accentPathResult.ok && allIssues.length === 0) {
      console.log(`[${pack.id}] OK`);
      if ((RUNTIME_TERRAIN_PACK_IDS as readonly string[]).includes(pack.id)) {
        decodedPacks.push({ id: pack.id, manifest, wallAtlas });
      }
    } else {
      allOk = false;
      console.error(`[${pack.id}] FAILED:`);
      for (const issue of allIssues) {
        console.error(`  - (${issue.code}) ${issue.message}`);
      }
    }
  }
  for (let leftIndex = 0; leftIndex < decodedPacks.length; leftIndex++) {
    const left = decodedPacks[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < decodedPacks.length; rightIndex++) {
      const right = decodedPacks[rightIndex];
      if (!right) continue;
      const pairId = [left.id, right.id].sort().join(':');
      if (!coResidentPairs.has(pairId)) continue;
      const result = validateCrossPackWallSilhouettes(
        left.manifest,
        left.wallAtlas,
        right.manifest,
        right.wallAtlas,
      );
      if (!result.ok) {
        allOk = false;
        console.error(`[${left.id} vs ${right.id}] FAILED:`);
        for (const issue of result.issues) {
          console.error(`  - (${issue.code}) ${issue.message}`);
        }
      }
    }
  }
  if (!allOk) {
    process.exitCode = 1;
  }
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  const cmd = process.argv[2];
  if (cmd === 'build') {
    runBuild();
  } else if (cmd === 'validate') {
    runValidate();
  } else {
    console.error('Usage: cli.ts <build|validate>');
    process.exitCode = 1;
  }
}
