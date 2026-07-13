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
import {
  validateTerrainPack,
  validatePoolAndDoorImages,
  validateManifestSchema,
  validateWallAutotileImagePath,
} from './validate.js';
import type { TerrainPackDef } from '../../../src/shared/terrain-pack-types.js';

function repoRootFromHere(): string {
  return path.resolve(import.meta.dirname, '..', '..', '..');
}

function runBuild(): void {
  const repoRoot = repoRootFromHere();
  writeIndustrialCavePack(repoRoot);
  writeCaelesFixturePack(repoRoot);
}

function runValidate(): void {
  const repoRoot = repoRootFromHere();
  const packs = [{ id: 'industrial-cave' }, { id: 'caeles-fixture' }];
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

    // Now safe to read atlas bytes — path has been validated and confirmed safe above.
    const atlasRelPath = manifest.wallAutotile.imagePath.replace(/\\/g, '/');
    const atlasAbsPath = path.join(repoRoot, 'public', atlasRelPath);
    const atlasBytes = fs.readFileSync(atlasAbsPath);
    const result = validateTerrainPack(manifestJson, atlasBytes);

    const allIssues = [...result.issues, ...poolResult.issues];
    if (result.ok && poolResult.ok) {
      console.log(`[${pack.id}] OK`);
    } else {
      allOk = false;
      console.error(`[${pack.id}] FAILED:`);
      for (const issue of allIssues) {
        console.error(`  - (${issue.code}) ${issue.message}`);
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
