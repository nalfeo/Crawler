/**
 * Azure-generation glue for the industrial-cave terrain pack's NEW material
 * sources (2026-07-25 terrain-variance design): 4 additional floor motifs, 4
 * additional corridor motifs, and 4 wall-accent decal motifs (crack /
 * mineral-vein / rust-brace / damp-stain).
 *
 * This is a TRACKED, deliberately narrow generation script — it does not
 * reuse the brief/sheet/slicer pipeline in `scripts/sprites/*` (that
 * machinery is purpose-built for multi-variant CHARACTER/ITEM icon sheets on
 * a flat/transparent background; these are single full-bleed MATERIAL tiles
 * and small decal motifs, a different composition contract). It DOES reuse
 * the project's sanctioned Azure sidecar plumbing:
 *   - `.env.local` bootstrap via the same `loadEnvLocal` helper the sidecar
 *     CLI uses (`scripts/setup-azure-env.ps1` / `npm run setup:azure:env`
 *     writes that file).
 *   - The SAME env var names + defaults as `scripts/sprites/provider/factory.ts`
 *     (`AZURE_OPENAI_ENDPOINT` / `_API_KEY` / `_IMAGE_DEPLOYMENT` / `_API_VERSION`).
 *   - The project's Azure-required-sidecar policy (AGENTS.md): a missing/invalid
 *     credential is a hard failure here, never a silent fallback to a
 *     procedural/local placeholder.
 *
 * Usage:
 *   pwsh scripts/setup-azure-env.ps1                      # writes .env.local
 *   npx tsx scripts/sprites/terrain-packs/generate-industrial-cave-motifs.ts
 *
 * Raw generations are cached under `.cache/terrain-gen/`, then routed through
 * the tracked seamless-material pipeline before being constrained to Floor 2's
 * subdued pixel-art value/chroma range.
 *
 * Accent motifs are composed on a flat magenta (#ff00ff) background — the
 * project's established chroma-key convention (`docs/agent-os/sprite-style.md`
 * hard constraint #4) — then keyed to transparent via the SAME
 * `removeBackgroundB` flood-fill the character/item sprite pipeline uses
 * (`scripts/sprites/postprocess.ts`), before being clipped to each mask's
 * wall silhouette by `buildWallAccentAtlas`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { removeBackgroundB } from '../postprocess.js';
import { decodePng, encodePng, nearestNeighborResize, type RgbaImage } from './png-buffer.js';
import { buildWallAccentAtlas } from './wall-accent-tools.js';
import { deriveAllowedTransforms } from './transform-eligibility.js';
import {
  TERRAIN_PACK_CELL_PX,
  type TerrainPackDef,
} from '../../../src/shared/terrain-pack-types.js';
import { generateMaterial, loadEnvLocal } from './gen/azure-image.js';
import {
  restylePixelArtMaterial,
  toMaterialTile,
  type MaterialTileOptions,
  type PixelArtMaterialStyle,
} from './gen/image-ops.js';

const FLOOR_MATERIAL_TILE: MaterialTileOptions = {
  sizePx: TERRAIN_PACK_CELL_PX,
  posterizeLevels: 10,
  targetMeanLuminance: 42,
  maxLuminance: 72,
  targetStdDev: 11,
};
const CORRIDOR_MATERIAL_TILE: MaterialTileOptions = {
  sizePx: TERRAIN_PACK_CELL_PX,
  posterizeLevels: 10,
  targetMeanLuminance: 32,
  maxLuminance: 60,
  targetStdDev: 9,
};
const FLOOR_PIXEL_STYLE: PixelArtMaterialStyle = {
  targetMeanLuminance: 42,
  maxLuminance: 72,
  targetStdDev: 10,
  valueStep: 8,
  maxChroma: 20,
};
const CORRIDOR_PIXEL_STYLE: PixelArtMaterialStyle = {
  targetMeanLuminance: 32,
  maxLuminance: 60,
  targetStdDev: 8,
  valueStep: 8,
  maxChroma: 18,
};
const ACCENT_PIXEL_STYLE: PixelArtMaterialStyle = {
  targetMeanLuminance: 52,
  maxLuminance: 104,
  targetStdDev: 20,
  valueStep: 8,
  maxChroma: 56,
};

interface MaterialSpec {
  readonly id: string; // e.g. 'floor-4'
  readonly cacheKey: string;
  readonly prompt: string;
  readonly tile: MaterialTileOptions;
  readonly style: PixelArtMaterialStyle;
}

interface AccentSpec {
  readonly id: string; // e.g. 'crack'
  readonly cacheKey: string;
  readonly prompt: string;
}

const STYLE_NOTE =
  'Industrial-cave dungeon material for a retro pixel-art dungeon crawler: hard 1-pixel outlines ' +
  'where the material has visible seams/edges, 3-5 distinct color tone steps (base, shadow, deep ' +
  'shadow, optional highlight), bold color separation, no smooth airbrush gradients, no text, no ' +
  'numbers, no watermark, no UI chrome, no vignette, no drop shadow. Restrained muted terrain ' +
  'palette with sparse highlights; game tile art, not realistic photography or physically based rendering.';

const NEW_FLOOR_MOTIFS: readonly MaterialSpec[] = [
  {
    id: 'floor-4',
    cacheKey: 'industrial-cave-floor-4',
    tile: FLOOR_MATERIAL_TILE,
    style: FLOOR_PIXEL_STYLE,
    prompt:
      'A seamless full-bleed top-down texture tile of corroded riveted scrap-metal deck plating with ' +
      'rust streaks, filling the entire square frame edge-to-edge with no border and no background — ' +
      'the material itself is the whole image. ' +
      STYLE_NOTE,
  },
  {
    id: 'floor-5',
    cacheKey: 'industrial-cave-floor-5',
    tile: FLOOR_MATERIAL_TILE,
    style: FLOOR_PIXEL_STYLE,
    prompt:
      'A seamless full-bleed top-down texture tile of damp dark cavern silt with glinting mineral ' +
      'flecks, filling the entire square frame edge-to-edge with no border and no background — the ' +
      'material itself is the whole image. ' +
      STYLE_NOTE,
  },
  {
    id: 'floor-6',
    cacheKey: 'industrial-cave-floor-6',
    tile: FLOOR_MATERIAL_TILE,
    style: FLOOR_PIXEL_STYLE,
    prompt:
      'A seamless full-bleed top-down texture tile of rusted iron floor grating with small square ' +
      'drainage holes in shadow, filling the entire square frame edge-to-edge with no border and no ' +
      'background — the material itself is the whole image. ' +
      STYLE_NOTE,
  },
  {
    id: 'floor-7',
    cacheKey: 'industrial-cave-floor-7',
    tile: FLOOR_MATERIAL_TILE,
    style: FLOOR_PIXEL_STYLE,
    prompt:
      'A seamless full-bleed top-down texture tile of ash-caked cracked volcanic rock floor, filling ' +
      'the entire square frame edge-to-edge with no border and no background — the material itself is ' +
      'the whole image. ' +
      STYLE_NOTE,
  },
];

const NEW_CORRIDOR_MOTIFS: readonly MaterialSpec[] = [
  {
    id: 'corridor-4',
    cacheKey: 'industrial-cave-corridor-4',
    tile: CORRIDOR_MATERIAL_TILE,
    style: CORRIDOR_PIXEL_STYLE,
    prompt:
      'A seamless full-bleed top-down texture tile of a narrow rail-track service floor with oily ' +
      'grime between rusty rail ties, filling the entire square frame edge-to-edge with no border and ' +
      'no background — the material itself is the whole image. ' +
      STYLE_NOTE,
  },
  {
    id: 'corridor-5',
    cacheKey: 'industrial-cave-corridor-5',
    tile: CORRIDOR_MATERIAL_TILE,
    style: CORRIDOR_PIXEL_STYLE,
    prompt:
      'A seamless full-bleed top-down texture tile of rough stone corridor floor with dripping ' +
      'condenser-pipe mineral runoff stains, filling the entire square frame edge-to-edge with no ' +
      'border and no background — the material itself is the whole image. ' +
      STYLE_NOTE,
  },
  {
    id: 'corridor-6',
    cacheKey: 'industrial-cave-corridor-6',
    tile: CORRIDOR_MATERIAL_TILE,
    style: CORRIDOR_PIXEL_STYLE,
    prompt:
      'A seamless full-bleed top-down texture tile of cracked reinforced concrete corridor floor with ' +
      'exposed rebar at the broken edges, filling the entire square frame edge-to-edge with no border ' +
      'and no background — the material itself is the whole image. ' +
      STYLE_NOTE,
  },
  {
    id: 'corridor-7',
    cacheKey: 'industrial-cave-corridor-7',
    tile: CORRIDOR_MATERIAL_TILE,
    style: CORRIDOR_PIXEL_STYLE,
    prompt:
      'A seamless full-bleed top-down texture tile of oxidized diamond-plate catwalk grating with rust ' +
      'patina, filling the entire square frame edge-to-edge with no border and no background — the ' +
      'material itself is the whole image. ' +
      STYLE_NOTE,
  },
];

const ACCENT_MOTIFS: readonly AccentSpec[] = [
  {
    id: 'crack',
    cacheKey: 'industrial-cave-accent-crack',
    prompt:
      'A single small isolated hairline rock-crack decal — a jagged branching fracture line in dark ' +
      'stone — centered in the frame with generous empty margin on every side. Flat solid vivid ' +
      'magenta #ff00ff fills the rest of the frame with no other objects, no gradient, no shadow. ' +
      STYLE_NOTE,
  },
  {
    id: 'mineral-vein',
    cacheKey: 'industrial-cave-accent-mineral-vein',
    prompt:
      'A single small isolated glowing turquoise mineral-vein decal — a thin branching seam of ' +
      'luminous crystal in dark rock — centered in the frame with generous empty margin on every ' +
      'side. Flat solid vivid magenta #ff00ff fills the rest of the frame with no other objects, no ' +
      'gradient, no shadow. ' +
      STYLE_NOTE,
  },
  {
    id: 'rust-brace',
    cacheKey: 'industrial-cave-accent-rust-brace',
    prompt:
      'A single small isolated rusted metal support-brace decal with two large bolts — a corroded ' +
      'orange-brown steel bracket — centered in the frame with generous empty margin on every side. ' +
      'Flat solid vivid magenta #ff00ff fills the rest of the frame with no other objects, no ' +
      'gradient, no shadow. ' +
      STYLE_NOTE,
  },
  {
    id: 'damp-stain',
    cacheKey: 'industrial-cave-accent-damp-stain',
    prompt:
      'A single small isolated damp mineral-stain decal — a dark irregular water-seepage blotch with a ' +
      'pale mineral-deposit rim — centered in the frame with generous empty margin on every side. Flat ' +
      'solid vivid magenta #ff00ff fills the rest of the frame with no other objects, no gradient, no ' +
      'shadow. ' +
      STYLE_NOTE,
  },
];

export interface GeneratedMotifResult {
  readonly id: string;
  readonly image: RgbaImage;
}

async function loadRawMaterial(
  repoRoot: string,
  cacheKey: string,
  prompt: string,
  force: boolean,
): Promise<RgbaImage> {
  const result = await generateMaterial({ repoRoot, cacheKey, prompt, force });
  console.log(`  material ${cacheKey}: ${result.fromCache ? 'cache' : 'generated'}`);
  return decodePng(result.png);
}

/** Generate, tile, and pixel-art-normalize the 8 new floor/corridor sources. */
export async function generateNewPoolMotifs(
  repoRoot: string,
  force = false,
): Promise<{ floors: GeneratedMotifResult[]; corridors: GeneratedMotifResult[] }> {
  const floors: GeneratedMotifResult[] = [];
  for (const spec of NEW_FLOOR_MOTIFS) {
    const raw = await loadRawMaterial(repoRoot, spec.cacheKey, spec.prompt, force);
    floors.push({
      id: spec.id,
      image: restylePixelArtMaterial(toMaterialTile(raw, spec.tile), spec.style),
    });
  }
  const corridors: GeneratedMotifResult[] = [];
  for (const spec of NEW_CORRIDOR_MOTIFS) {
    const raw = await loadRawMaterial(repoRoot, spec.cacheKey, spec.prompt, force);
    corridors.push({
      id: spec.id,
      image: restylePixelArtMaterial(toMaterialTile(raw, spec.tile), spec.style),
    });
  }
  return { floors, corridors };
}

/** Generate + chroma-key + downsample the 4 wall-accent decal motifs. */
export async function generateAccentMotifs(
  repoRoot: string,
  force = false,
): Promise<GeneratedMotifResult[]> {
  const out: GeneratedMotifResult[] = [];
  for (const spec of ACCENT_MOTIFS) {
    const decoded = await loadRawMaterial(repoRoot, spec.cacheKey, spec.prompt, force);
    const keyed = removeBackgroundB(decoded);
    const resized = nearestNeighborResize(
      { width: keyed.width, height: keyed.height, data: Buffer.from(keyed.data) },
      TERRAIN_PACK_CELL_PX,
      TERRAIN_PACK_CELL_PX,
    );
    out.push({ id: spec.id, image: restylePixelArtMaterial(resized, ACCENT_PIXEL_STYLE) });
  }
  return out;
}

/**
 * Merge freshly-generated motifs into the COMMITTED industrial-cave
 * manifest: keeps the existing 8 (wallAutotile + floor-0..3 + corridor-0..3 +
 * doorSet) byte-identical, appends the 4 new floor/corridor sources (with
 * derived `allowedTransforms`), backfills `allowedTransforms` on the
 * pre-existing 4+4 sources (same derivation, applied to their already-shipped
 * pixels — no re-generation), and adds the 4 new `wallAccents` atlases.
 */
export function mergeIntoManifest(
  existing: TerrainPackDef,
  existingImages: {
    readonly floors: readonly RgbaImage[];
    readonly corridors: readonly RgbaImage[];
  },
  newPool: {
    readonly floors: readonly GeneratedMotifResult[];
    readonly corridors: readonly GeneratedMotifResult[];
  },
  accents: readonly GeneratedMotifResult[],
  wallAtlas: RgbaImage,
  packDir: string,
): { manifest: TerrainPackDef; files: { relativePath: string; buffer: Buffer }[] } {
  const files: { relativePath: string; buffer: Buffer }[] = [];

  function extendPool(
    _kind: 'floor' | 'corridor',
    existingVariants: TerrainPackDef['floorPool'],
    existingDecoded: readonly RgbaImage[],
    added: readonly GeneratedMotifResult[],
  ): TerrainPackDef['floorPool'] {
    const backfilled = existingVariants.map((variant, i) => ({
      ...variant,
      allowedTransforms: deriveAllowedTransforms(existingDecoded[i]!),
    }));
    const appended = added.map((motif) => {
      const relPath = `${packDir}/${motif.id}.png`;
      files.push({ relativePath: relPath, buffer: encodePng(motif.image) });
      return {
        id: motif.id,
        imagePath: relPath,
        textureKey: `terrain-pack-industrial-cave-${motif.id}`,
        allowedTransforms: deriveAllowedTransforms(motif.image),
      };
    });
    return [...backfilled, ...appended];
  }

  const floorPool = extendPool('floor', existing.floorPool, existingImages.floors, newPool.floors);
  const corridorPool = extendPool(
    'corridor',
    existing.corridorPool,
    existingImages.corridors,
    newPool.corridors,
  );

  const wallAccents = accents.map((accent) => {
    const atlas = buildWallAccentAtlas(accent.image, wallAtlas);
    const relPath = `${packDir}/accent-${accent.id}.png`;
    files.push({ relativePath: relPath, buffer: encodePng(atlas) });
    return {
      id: accent.id,
      imagePath: relPath,
      textureKey: `terrain-pack-industrial-cave-accent-${accent.id}`,
    };
  });

  const manifest: TerrainPackDef = {
    ...existing,
    provenance: {
      kind: 'authored',
      author:
        existing.provenance.kind === 'authored' ? existing.provenance.author : 'Crawler agent',
      derivationNote:
        (existing.provenance.kind === 'authored' ? existing.provenance.derivationNote : '') +
        ' 2026-07-25 terrain-variance update: grew floorPool/corridorPool from 4 to 8 sources each ' +
        '(floor-4..7 / corridor-4..7 are freshly Azure OpenAI gpt-image-1 generated material motifs, ' +
        'box-downsampled, made seamless, contrast-normalized, posterized, and constrained to a muted ' +
        'pixel-art value/chroma range at 64x64; floor-0..3/corridor-0..3 keep their original ' +
        'shipped pixels byte-identical, only gaining derived allowedTransforms metadata) and added 4 ' +
        'mask-aware wallAccents overlay atlases (crack, mineral-vein, rust-brace, damp-stain), each ' +
        'built from one Azure gpt-image-1 generated decal motif (magenta-keyed to transparent via the ' +
        'same removeBackgroundB flood-fill the sprite pipeline uses) clipped per-mask to the wall ' +
        "atlas's own alpha silhouette so accents can never spill onto floor.",
    },
    floorPool,
    corridorPool,
    wallAccents,
  };

  return { manifest, files };
}

/**
 * Reprocess the already-committed generated motifs without an Azure call. This
 * is the deterministic repair path for art-direction tuning when the raw cache
 * is unavailable: large motifs remain intact, while realistic gradients,
 * excessive brightness, and tile-wide saturation are constrained.
 */
export function restyleExistingIndustrialCaveArt(
  existing: TerrainPackDef,
  repoRoot: string,
): { manifest: TerrainPackDef; files: { relativePath: string; buffer: Buffer }[] } {
  const files: { relativePath: string; buffer: Buffer }[] = [];
  const restylePool = (
    pool: TerrainPackDef['floorPool'],
    style: PixelArtMaterialStyle,
  ): TerrainPackDef['floorPool'] =>
    pool.map((variant) => {
      const generatedIndex = Number(variant.id.match(/-(\d+)$/)?.[1] ?? -1);
      if (generatedIndex < 4) return variant;
      const absolutePath = path.join(repoRoot, 'public', variant.imagePath);
      const image = restylePixelArtMaterial(decodePng(fs.readFileSync(absolutePath)), style);
      files.push({ relativePath: variant.imagePath, buffer: encodePng(image) });
      return { ...variant, allowedTransforms: deriveAllowedTransforms(image) };
    });

  const wallAccents = (existing.wallAccents ?? []).map((accent) => {
    const absolutePath = path.join(repoRoot, 'public', accent.imagePath);
    const image = restylePixelArtMaterial(
      decodePng(fs.readFileSync(absolutePath)),
      ACCENT_PIXEL_STYLE,
    );
    files.push({ relativePath: accent.imagePath, buffer: encodePng(image) });
    return accent;
  });

  const styleNote =
    ' Deterministic pixel-art normalization constrains generated Floor 2 motifs to subdued ' +
    'stepped values and limited chroma so terrain remains secondary to characters and props.';
  const previousNote =
    existing.provenance.kind === 'authored' ? existing.provenance.derivationNote : '';
  const manifest: TerrainPackDef = {
    ...existing,
    provenance: {
      kind: 'authored',
      author:
        existing.provenance.kind === 'authored' ? existing.provenance.author : 'Crawler agent',
      derivationNote: previousNote.includes(styleNote.trim())
        ? previousNote
        : previousNote + styleNote,
    },
    floorPool: restylePool(existing.floorPool, FLOOR_PIXEL_STYLE),
    corridorPool: restylePool(existing.corridorPool, CORRIDOR_PIXEL_STYLE),
    ...(wallAccents.length > 0 ? { wallAccents } : {}),
  };
  return { manifest, files };
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const args = new Set(process.argv.slice(2));
  for (const arg of args) {
    if (arg !== '--force' && arg !== '--restyle-existing') {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  const force = args.has('--force');
  const restyleExisting = args.has('--restyle-existing');

  const packDir = 'assets/terrain-packs/industrial-cave';
  const manifestPath = path.join(
    repoRoot,
    'src',
    'shared',
    'data',
    'terrain-packs',
    'industrial-cave.manifest.json',
  );
  const existing = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as TerrainPackDef;

  const existingFloorImages = existing.floorPool.map((v) =>
    decodePng(fs.readFileSync(path.join(repoRoot, 'public', v.imagePath))),
  );
  const existingCorridorImages = existing.corridorPool.map((v) =>
    decodePng(fs.readFileSync(path.join(repoRoot, 'public', v.imagePath))),
  );
  const wallAtlas = decodePng(
    fs.readFileSync(path.join(repoRoot, 'public', existing.wallAutotile.imagePath)),
  );

  if (restyleExisting) {
    const { manifest, files } = restyleExistingIndustrialCaveArt(existing, repoRoot);
    for (const file of files) {
      const outPath = path.join(repoRoot, 'public', ...file.relativePath.split('/'));
      fs.writeFileSync(outPath, file.buffer);
    }
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    console.log(
      `[generate-industrial-cave-motifs] restyled ${files.length} committed PNG(s) without Azure.`,
    );
    return;
  }

  loadEnvLocal(repoRoot);
  console.log('[generate-industrial-cave-motifs] generating 8 new floor/corridor sources...');
  const newPool = await generateNewPoolMotifs(repoRoot, force);
  console.log('[generate-industrial-cave-motifs] generating 4 wall-accent motifs...');
  const accents = await generateAccentMotifs(repoRoot, force);

  const { manifest, files } = mergeIntoManifest(
    existing,
    { floors: existingFloorImages, corridors: existingCorridorImages },
    newPool,
    accents,
    wallAtlas,
    packDir,
  );

  for (const file of files) {
    const outPath = path.join(repoRoot, 'public', ...file.relativePath.split('/'));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, file.buffer);
  }
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`[generate-industrial-cave-motifs] wrote ${files.length} PNG(s) + updated manifest.`);
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
