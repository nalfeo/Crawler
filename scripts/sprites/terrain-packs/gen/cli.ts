/**
 * CLI: generate Floor 1 terrain-pack art on Azure, compose it onto the tracked
 * blob47 silhouettes, write the pack PNGs + manifests, and validate the result.
 *
 * Usage:
 *   npx tsx scripts/sprites/terrain-packs/gen/cli.ts               # both packs + specials
 *   npx tsx scripts/sprites/terrain-packs/gen/cli.ts --pack floor1-cave
 *   npx tsx scripts/sprites/terrain-packs/gen/cli.ts --force       # re-request from Azure
 *   npx tsx scripts/sprites/terrain-packs/gen/cli.ts --compose-only
 *
 * Raw Azure output is cached under `.cache/terrain-gen/` (gitignored), so only
 * the first run costs credits; every later run recomposes the same bytes for
 * free. `--compose-only` refuses to call Azure at all and fails loudly if the
 * cache is incomplete.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, type RgbaImage } from '../png-buffer.js';
import {
  validateAtlasDimensions,
  validateMaskCoverage,
  validateCompatibleBoundaries,
  validateWallAutotileImagePath,
  validatePoolAndDoorImages,
  validateGenManifestSchema,
  type ValidationResult,
} from '../validate.js';
import type { TerrainPackDef } from '../../../../src/shared/terrain-pack-types.js';
import { generateMaterial, loadEnvLocal } from './azure-image.js';
import { toMaterialTile } from './image-ops.js';
import { composePack, deriveVariantTiles, type SpecialFloorPoolInput } from './compose-pack.js';
import {
  FLOOR1_CAVE_SPEC,
  FLOOR1_DUNGEON_SPEC,
  FLOOR1_SPECIAL_FLOOR_SPECS,
  type PackGenSpec,
  type SurfaceMaterialSpec,
} from './materials.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

interface CliOptions {
  readonly packs: readonly string[];
  readonly force: boolean;
  readonly composeOnly: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const packs: string[] = [];
  let force = false;
  let composeOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--force') force = true;
    else if (arg === '--compose-only') composeOnly = true;
    else if (arg === '--pack') {
      const value = argv[++i];
      if (!value) throw new Error('--pack requires a pack id');
      packs.push(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { packs, force, composeOnly };
}

async function loadMaterial(spec: SurfaceMaterialSpec, options: CliOptions): Promise<RgbaImage> {
  const cachePath = path.join(REPO_ROOT, '.cache', 'terrain-gen', `${spec.cacheKey}.png`);
  if (options.composeOnly && !fs.existsSync(cachePath)) {
    throw new Error(
      `--compose-only but no cached material at ${cachePath}. Run without --compose-only first.`,
    );
  }
  const result = await generateMaterial({
    repoRoot: REPO_ROOT,
    cacheKey: spec.cacheKey,
    prompt: spec.prompt,
    force: options.force && !options.composeOnly,
  });
  console.log(`  material ${spec.cacheKey}: ${result.fromCache ? 'cache' : 'generated'}`);
  return decodePng(result.png);
}

function writeFileRelativeToPublic(relativePath: string, buffer: Buffer): void {
  const outPath = path.join(REPO_ROOT, 'public', ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, buffer);
}

function reportValidation(label: string, results: readonly ValidationResult[]): boolean {
  const issues = results.flatMap((r) => r.issues);
  if (issues.length === 0) {
    console.log(`  ✅ ${label}: valid`);
    return true;
  }
  console.error(`  ❌ ${label}: ${issues.length} issue(s)`);
  for (const issue of issues) console.error(`     [${issue.code}] ${issue.message}`);
  return false;
}

async function buildPack(spec: PackGenSpec, options: CliOptions): Promise<boolean> {
  console.log(`\n[${spec.id}] building`);
  // Serial, never Promise.all: the S0 image tier throttles concurrent
  // generations, and a 429 storm is slower than issuing them one at a time.
  const wallRaw = await loadMaterial(spec.wall, options);
  const floorRaw = await loadMaterial(spec.floor, options);
  const corridorRaw = await loadMaterial(spec.corridor, options);
  const woodRaw = await loadMaterial(spec.doorSlab, options);

  const wallTile = toMaterialTile(wallRaw, spec.wall.tile);
  const woodTile = toMaterialTile(woodRaw, spec.doorSlab.tile);
  const floorVariants = deriveVariantTiles(floorRaw, spec.floor.tile);
  const corridorVariants = deriveVariantTiles(corridorRaw, spec.corridor.tile);

  // Special-room floors ride along with the pack that owns the walls + doors
  // they are rendered next to, so they land in that pack's manifest rather than
  // as loose, unreferenced PNGs.
  const specialFloorPools: SpecialFloorPoolInput[] = [];
  if (spec.includeSpecialFloorPools) {
    for (const special of FLOOR1_SPECIAL_FLOOR_SPECS) {
      const raw = await loadMaterial(special.material, options);
      specialFloorPools.push({
        key: special.manifestKey,
        slug: special.id,
        variants: deriveVariantTiles(raw, special.material.tile),
      });
    }
  }

  const { manifest, files, diagnostics } = composePack({
    id: spec.id,
    name: spec.name,
    derivationNote:
      'Materials generated with Azure OpenAI gpt-image-1 (images/generations), then made ' +
      'seamlessly tileable, posterized and luminance-normalized locally and composited onto the ' +
      'deterministic 20-quadrant blob47 wall silhouettes from ' +
      'scripts/sprites/terrain-packs/quadrant-kit.ts. Alpha is taken from the silhouette ' +
      'unchanged, so the authored 100% edge-compatibility invariant is preserved. Image ' +
      'generation is not byte-reproducible: the committed PNGs are the source of truth. ' +
      'Rebuild with scripts/sprites/terrain-packs/gen/cli.ts.',
    wallTile,
    floorVariants,
    corridorVariants,
    woodTile,
    specialFloorPools,
  });

  console.log(
    `  wall material luminance: mean=${diagnostics.wallMeanLuminance.toFixed(1)} ` +
      `max=${diagnostics.wallMaxLuminance.toFixed(1)}`,
  );

  for (const file of files) writeFileRelativeToPublic(file.relativePath, file.buffer);
  const manifestDir = path.join(REPO_ROOT, 'src', 'shared', 'data', 'terrain-packs');
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(
    path.join(manifestDir, `${spec.id}.manifest.json`),
    JSON.stringify(manifest, null, 2) + '\n',
  );
  console.log(`  wrote ${files.length} PNG(s) + manifest`);

  const atlasBytes = files.find((f) => f.relativePath.endsWith('wall-atlas.png'))!.buffer;
  const atlas = decodePng(atlasBytes);
  const typed = manifest as TerrainPackDef;
  return reportValidation(spec.id, [
    // Use the gen-specific schema validator: the pack id ('floor1-dungeon',
    // 'floor1-cave') is intentionally not yet in TERRAIN_PACK_IDS — these are
    // generation targets that get registered once their manifests are committed.
    // All non-id fields are validated against the same strict schema.
    validateGenManifestSchema(manifest),
    validateAtlasDimensions(typed, atlas),
    validateMaskCoverage(typed),
    validateCompatibleBoundaries(typed, atlas, { minEdgePassRate: 1.0 }),
    validateWallAutotileImagePath(typed, { repoRoot: REPO_ROOT }),
    validatePoolAndDoorImages(typed, { repoRoot: REPO_ROOT }),
  ]);
}

/**
 * Special-room floor pools are composed as part of the pack that owns the walls
 * and doors they sit next to (see `buildPack`), so there is no separate pass.
 */
async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  loadEnvLocal(REPO_ROOT);

  const allSpecs: readonly PackGenSpec[] = [FLOOR1_DUNGEON_SPEC, FLOOR1_CAVE_SPEC];
  const selected =
    options.packs.length === 0 ? allSpecs : allSpecs.filter((s) => options.packs.includes(s.id));
  if (selected.length === 0) {
    throw new Error(`No pack matched ${options.packs.join(', ')}`);
  }

  let ok = true;
  for (const spec of selected) {
    ok = (await buildPack(spec, options)) && ok;
  }

  if (!ok) {
    console.error('\nOne or more packs failed validation.');
    process.exitCode = 1;
    return;
  }
  console.log('\nAll packs valid.');
}

await main();
