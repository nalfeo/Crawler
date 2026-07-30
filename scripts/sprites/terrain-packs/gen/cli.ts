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
import { fileURLToPath } from 'node:url';
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
  readonly fromSource: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const packs: string[] = [];
  let force = false;
  let composeOnly = false;
  let fromSource = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--force') force = true;
    else if (arg === '--compose-only') composeOnly = true;
    else if (arg === '--from-source') fromSource = true;
    else if (arg === '--pack') {
      const value = argv[++i];
      if (!value) throw new Error('--pack requires a pack id');
      packs.push(value);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { packs, force, composeOnly, fromSource };
}

/**
 * Read a committed pack asset as a rebuild input.
 *
 * `--from-source` exists so the packs are REPAIRABLY reproducible, not merely
 * detectably stale. Azure generation is not byte-reproducible and the raw
 * material cache is gitignored, so without tracked inputs only the original
 * author's machine could recompose after a canonical-geometry change (#2189).
 * Every input this reads is committed, so a fresh clone reproduces the pack
 * byte-for-byte with no Azure access.
 */
function readPackAsset(packId: string, fileName: string): RgbaImage {
  const abs = path.join(REPO_ROOT, 'public', 'assets', 'terrain-packs', packId, fileName);
  if (!fs.existsSync(abs)) {
    throw new Error(`--from-source but no committed input at ${abs}. Rebuild the pack first.`);
  }
  return decodePng(fs.readFileSync(abs));
}

/**
 * Discover and validate the sorted pool indices for `${prefix}-N.png` in `dir`.
 *
 * Reads the directory listing so interior gaps are detected: if floor-0.png and
 * floor-2.png exist but floor-1.png is absent, the sequential-break approach would
 * silently return a one-variant pool and trigger a destructive rebuild downgrade.
 * This function requires a strictly contiguous 0..N sequence and throws on any gap.
 *
 * Exported for unit testing.
 */
export function discoverPoolIndices(dir: string, prefix: string): number[] {
  const re = new RegExp(`^${prefix}-(\\d+)\\.png$`);
  const indices: number[] = [];
  if (fs.existsSync(dir)) {
    for (const entry of fs.readdirSync(dir)) {
      const m = re.exec(entry);
      if (m) indices.push(parseInt(m[1]!, 10));
    }
  }
  if (indices.length === 0) {
    throw new Error(`--from-source found no ${prefix}-*.png in ${dir}`);
  }
  indices.sort((a, b) => a - b);
  for (let i = 0; i < indices.length; i++) {
    if (indices[i] !== i) {
      throw new Error(
        `--from-source: non-contiguous source pool for "${prefix}" in ${path.basename(dir)}; ` +
          `found indices [${indices.join(', ')}] but expected 0..${indices.length - 1}. ` +
          `Restore or regenerate all source files before rebuilding.`,
      );
    }
  }
  return indices;
}

/** Read `<prefix>-0.png`, `<prefix>-1.png`, … from the committed pack sources. */
function readPackPool(packId: string, prefix: string): readonly RgbaImage[] {
  const dir = path.join(REPO_ROOT, 'public', 'assets', 'terrain-packs', packId);
  const indices = discoverPoolIndices(dir, prefix);
  return indices.map((i) => decodePng(fs.readFileSync(path.join(dir, `${prefix}-${i}.png`))));
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
  console.log(`\n[${spec.id}] building${options.fromSource ? ' (from committed source)' : ''}`);

  let wallTile: RgbaImage;
  let woodTile: RgbaImage;
  let floorVariants: readonly RgbaImage[];
  let corridorVariants: readonly RgbaImage[];
  const specialFloorPools: SpecialFloorPoolInput[] = [];

  if (options.fromSource) {
    wallTile = readPackAsset(spec.id, 'wall-material.png');
    woodTile = readPackAsset(spec.id, 'door-material.png');
    floorVariants = readPackPool(spec.id, 'floor');
    corridorVariants = readPackPool(spec.id, 'corridor');
    if (spec.includeSpecialFloorPools) {
      for (const special of FLOOR1_SPECIAL_FLOOR_SPECS) {
        specialFloorPools.push({
          key: special.manifestKey,
          slug: special.id,
          variants: readPackPool(spec.id, `special-${special.id}`),
        });
      }
    }
  } else {
    // Serial, never Promise.all: the S0 image tier throttles concurrent
    // generations, and a 429 storm is slower than issuing them one at a time.
    const wallRaw = await loadMaterial(spec.wall, options);
    const floorRaw = await loadMaterial(spec.floor, options);
    const corridorRaw = await loadMaterial(spec.corridor, options);
    const woodRaw = await loadMaterial(spec.doorSlab, options);

    wallTile = toMaterialTile(wallRaw, spec.wall.tile);
    woodTile = toMaterialTile(woodRaw, spec.doorSlab.tile);
    floorVariants = deriveVariantTiles(floorRaw, spec.floor.tile);
    corridorVariants = deriveVariantTiles(corridorRaw, spec.corridor.tile);

    // Special-room floors ride along with the pack that owns the walls + doors
    // they are rendered next to, so they land in that pack's manifest rather than
    // as loose, unreferenced PNGs.
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
    // Use the gen-specific schema validator: floor1-dungeon/floor1-cave are now
    // registered in RUNTIME_TERRAIN_PACK_IDS, but validateManifestSchema also
    // validates the id field against the runtime registry, so either validator
    // works here. All non-id fields are validated against the same strict schema.
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

const invokedAsScript = (() => {
  try {
    const entry = process.argv[1];
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedAsScript) {
  await main();
}
