/**
 * Compose a complete terrain pack (wall atlas + floor/corridor pools + doors +
 * manifest) from generated material art.
 *
 * The wall silhouettes come from the SAME tracked `quadrant-kit` compositor the
 * procedural packs use, so edge-compatibility remains provable by construction:
 * this module only ever repaints RGB inside an existing silhouette and never
 * touches alpha.
 */
import {
  ATLAS_GRID_COLS,
  ATLAS_GRID_ROWS,
  ATLAS_HEIGHT_PX,
  ATLAS_WIDTH_PX,
  buildMaskFrameAssignments,
} from '../atlas-grid.js';
import { composeWallCellOutput } from '../compose-wall-cell.js';
import { compositeInto, createImage, cropImage, encodePng, type RgbaImage } from '../png-buffer.js';
import { generateQuadrantKit } from '../quadrant-kit.js';
import {
  DEFAULT_WALL_CORNER_STYLE,
  wallCornerStyleForPack,
  type WallCornerStyle,
} from '../wall-corner-style.js';
import {
  TERRAIN_PACK_CELL_PX,
  type TerrainPackDef,
} from '../../../../src/shared/terrain-pack-types.js';
import {
  applyMaterial,
  applyRimShading,
  maxOpaqueLuminance,
  meanOpaqueLuminance,
  toMaterialTile,
  type MaterialTileOptions,
} from './image-ops.js';

export interface PackOutputFile {
  readonly relativePath: string;
  readonly buffer: Buffer;
}

/** How far in from a silhouette boundary the wall darkening reaches. */
const WALL_RIM = { rimPx: 3, rimDarken: 0.35, topLift: 0.5 } as const;

/**
 * Cut a raw material into 4 quadrants and turn each into an independent
 * seamless tile — one Azure generation yields a full 4-variant pool.
 */
export function deriveVariantTiles(
  raw: RgbaImage,
  options: MaterialTileOptions,
  count = 4,
): readonly RgbaImage[] {
  const halfW = Math.floor(raw.width / 2);
  const halfH = Math.floor(raw.height / 2);
  const quadrants: RgbaImage[] = [
    cropImage(raw, 0, 0, halfW, halfH),
    cropImage(raw, halfW, 0, halfW, halfH),
    cropImage(raw, 0, halfH, halfW, halfH),
    cropImage(raw, halfW, halfH, halfW, halfH),
  ];
  if (count > quadrants.length) {
    throw new Error(`deriveVariantTiles supports at most ${quadrants.length} variants`);
  }
  return quadrants.slice(0, count).map((q) => toMaterialTile(q, options));
}

/** Build the 512×384 wall atlas by re-texturing every blob47 silhouette. */
export function composeWallAtlas(
  wallTile: RgbaImage,
  cornerStyle: WallCornerStyle = DEFAULT_WALL_CORNER_STYLE,
): {
  readonly atlas: RgbaImage;
  readonly masks: readonly { readonly maskId: number; readonly frameIndex: number }[];
} {
  const quadrantKit = generateQuadrantKit(cornerStyle);
  const assignments = buildMaskFrameAssignments();
  const atlas = createImage(ATLAS_WIDTH_PX, ATLAS_HEIGHT_PX);
  for (const { maskId, frameIndex } of assignments) {
    const silhouette = composeWallCellOutput(maskId, quadrantKit);
    const textured = applyRimShading(applyMaterial(silhouette, wallTile), WALL_RIM);
    const col = frameIndex % ATLAS_GRID_COLS;
    const row = Math.floor(frameIndex / ATLAS_GRID_COLS);
    compositeInto(atlas, textured, col * TERRAIN_PACK_CELL_PX, row * TERRAIN_PACK_CELL_PX);
  }
  return { atlas, masks: assignments.map(({ maskId, frameIndex }) => ({ maskId, frameIndex })) };
}

/** The two flat colors `renderDoorTile` paints, used as re-texture keys. */
export interface SpecialFloorPoolInput {
  /** Manifest key under `specialFloorPools`. */
  readonly key: 'welcome' | 'safe' | 'bossStair';
  /** Filename/texture-key slug (e.g. `boss-stair`). */
  readonly slug: string;
  readonly variants: readonly RgbaImage[];
}

export interface ComposePackInput {
  readonly id: string;
  readonly name: string;
  readonly derivationNote: string;
  readonly wallTile: RgbaImage;
  readonly floorVariants: readonly RgbaImage[];
  readonly corridorVariants: readonly RgbaImage[];
  /** Role-keyed floor pools (welcome/safe/boss-stair); walls are shared. */
  readonly specialFloorPools?: readonly SpecialFloorPoolInput[];
}

export interface ComposePackResult {
  readonly manifest: TerrainPackDef;
  readonly files: readonly PackOutputFile[];
  readonly diagnostics: {
    readonly wallMeanLuminance: number;
    readonly wallMaxLuminance: number;
  };
}

/** Assemble every PNG + the manifest for one pack, entirely in memory. */
export function composePack(input: ComposePackInput): ComposePackResult {
  const packDir = `assets/terrain-packs/${input.id}`;
  const files: PackOutputFile[] = [];

  const { atlas, masks } = composeWallAtlas(input.wallTile, wallCornerStyleForPack(input.id));
  const atlasRelPath = `${packDir}/wall-atlas.png`;
  files.push({ relativePath: atlasRelPath, buffer: encodePng(atlas) });

  // DURABLE REBUILD INPUT. The pool tiles below are terminal outputs, so they
  // are their own source, but `wallTile` is consumed into the atlas and would
  // otherwise survive only in the gitignored Azure cache. Committing it means a
  // fresh clone can recompose this pack byte-for-byte with no Azure access —
  // which is what a canonical-geometry change (as in #2189) requires.
  // Deliberately NOT referenced by the manifest; it is a build input, not a
  // runtime asset. `industrial-cave` ships `wall-material.png` for the same
  // reason.
  files.push({ relativePath: `${packDir}/wall-material.png`, buffer: encodePng(input.wallTile) });

  const buildPool = (
    kind: string,
    variants: readonly RgbaImage[],
  ): { id: string; imagePath: string; textureKey: string }[] =>
    variants.map((img, i) => {
      const relPath = `${packDir}/${kind}-${i}.png`;
      files.push({ relativePath: relPath, buffer: encodePng(img) });
      return {
        id: `${kind}-${i}`,
        imagePath: relPath,
        textureKey: `terrain-pack-${input.id}-${kind}-${i}`,
      };
    });

  const floorPool = buildPool('floor', input.floorVariants);
  const corridorPool = buildPool('corridor', input.corridorVariants);

  const specialFloorPools: Record<string, ReturnType<typeof buildPool>> = {};
  for (const pool of input.specialFloorPools ?? []) {
    specialFloorPools[pool.key] = buildPool(`special-${pool.slug}`, pool.variants);
  }

  const manifest: TerrainPackDef = {
    id: input.id,
    name: input.name,
    provenance: {
      kind: 'authored',
      author: 'Crawler agent (Azure gpt-image-1 materials + local blob47 composition)',
      derivationNote: input.derivationNote,
    },
    wallAutotile: {
      imagePath: atlasRelPath,
      textureKey: `terrain-pack-${input.id}-walls`,
      cellPx: TERRAIN_PACK_CELL_PX,
      gridCols: ATLAS_GRID_COLS,
      gridRows: ATLAS_GRID_ROWS,
      masks,
    },
    floorPool,
    corridorPool,
    ...(Object.keys(specialFloorPools).length > 0
      ? { specialFloorPools: specialFloorPools as TerrainPackDef['specialFloorPools'] }
      : {}),
  } as TerrainPackDef;

  return {
    manifest,
    files,
    diagnostics: {
      wallMeanLuminance: meanOpaqueLuminance(input.wallTile),
      wallMaxLuminance: maxOpaqueLuminance(input.wallTile),
    },
  };
}
