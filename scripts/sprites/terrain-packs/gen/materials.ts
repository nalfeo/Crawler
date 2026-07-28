/**
 * Material prompts + composition parameters for the Floor 1 terrain packs.
 *
 * One Azure generation per SURFACE (not per variant): a single 1024×1024
 * material is cut into quadrants and each quadrant is independently made
 * seamless, which yields a 4-variant pool with natural variation for the price
 * of one image.
 *
 * Prompt rules learned the hard way and encoded here:
 *  - always say "seamless tileable" AND "no border/frame/vignette" — generators
 *    love to add a decorative edge that destroys tiling;
 *  - always say "top-down orthographic, flat even lighting, no cast shadows" —
 *    baked directional light makes neighbouring cells disagree;
 *  - always say "no objects, no props, no text" — a barrel baked into the
 *    material repeats across the whole floor.
 */
import type { MaterialTileOptions } from './image-ops.js';

export interface SurfaceMaterialSpec {
  /** Stable `.cache/terrain-gen/<cacheKey>.png` name. */
  readonly cacheKey: string;
  readonly prompt: string;
  readonly tile: MaterialTileOptions;
}

/** Walls must stay dark: the edge validator scores transparent pixels as 255 ("open"). */
const WALL_TILE: MaterialTileOptions = {
  sizePx: 64,
  // 6 levels = 51-luminance steps, which leaves a dark wall only 2 usable bands.
  // Finer steps keep visible rock detail inside the narrow dark range.
  posterizeLevels: 12,
  targetMeanLuminance: 62,
  maxLuminance: 130,
  targetStdDev: 16,
};

const FLOOR_TILE: MaterialTileOptions = {
  sizePx: 64,
  posterizeLevels: 10,
  targetMeanLuminance: 74,
  maxLuminance: 150,
  targetStdDev: 18,
};

const ACCENT_FLOOR_TILE: MaterialTileOptions = {
  sizePx: 64,
  posterizeLevels: 10,
  targetMeanLuminance: 84,
  maxLuminance: 165,
  targetStdDev: 20,
};

const SHARED_STYLE =
  'seamless tileable texture, top-down orthographic view, flat even lighting, ' +
  'no cast shadows, no directional highlight, no border, no frame, no vignette, ' +
  'no objects, no props, no characters, no text, no watermark, ' +
  'edge-to-edge repeating pattern, muted desaturated palette, dark fantasy dungeon crawler game texture';

export interface PackGenSpec {
  readonly id: string;
  readonly name: string;
  readonly wall: SurfaceMaterialSpec;
  readonly floor: SurfaceMaterialSpec;
  readonly corridor: SurfaceMaterialSpec;
  /** Wood material used for the closed-door slab. */
  readonly doorSlab: SurfaceMaterialSpec;
  /**
   * Compose the Floor 1 role-keyed floor pools (welcome / safe / boss-stair)
   * into this pack. They share this pack's walls and doors, so only the pack
   * that owns those surfaces should carry them.
   */
  readonly includeSpecialFloorPools?: boolean;
}

export const FLOOR1_DUNGEON_SPEC: PackGenSpec = {
  id: 'floor1-dungeon',
  name: 'Floor 1 Dungeon',
  includeSpecialFloorPools: true,
  wall: {
    cacheKey: 'floor1-dungeon-wall',
    prompt:
      'Ancient mortared dungeon masonry wall of rough-cut grey granite blocks with ' +
      'crumbling pale mortar joints and faint moss in the cracks. ' +
      SHARED_STYLE,
    tile: WALL_TILE,
  },
  floor: {
    cacheKey: 'floor1-dungeon-floor',
    prompt:
      'Worn dungeon flagstone floor of irregular grey-brown paving slabs with ' +
      'grit-filled seams, small chips and scuff marks. ' +
      SHARED_STYLE,
    tile: FLOOR_TILE,
  },
  corridor: {
    cacheKey: 'floor1-dungeon-corridor',
    prompt:
      'Narrow dungeon corridor floor of tightly fitted cold grey stone slabs, ' +
      'darker and damper than a room floor, with a faint worn walking path. ' +
      SHARED_STYLE,
    tile: FLOOR_TILE,
  },
  doorSlab: {
    cacheKey: 'floor1-door-wood',
    prompt:
      'Heavy weathered oak plank door surface with dark iron banding and rivets, ' +
      'vertical plank grain, aged and scarred. ' +
      SHARED_STYLE,
    tile: {
      sizePx: 64,
      posterizeLevels: 10,
      targetMeanLuminance: 78,
      maxLuminance: 150,
      targetStdDev: 20,
    },
  },
};

export const FLOOR1_CAVE_SPEC: PackGenSpec = {
  id: 'floor1-cave',
  name: 'Floor 1 Cave',
  wall: {
    cacheKey: 'floor1-cave-wall',
    prompt:
      'Rough natural cave rock wall, jagged unhewn limestone with mineral veining, ' +
      'pitted and uneven, damp dark stone. ' +
      SHARED_STYLE,
    tile: WALL_TILE,
  },
  floor: {
    cacheKey: 'floor1-cave-floor',
    prompt:
      'Damp cave floor of packed earth, loose gravel and scattered small stones, ' +
      'brown and grey, uneven natural ground. ' +
      SHARED_STYLE,
    tile: FLOOR_TILE,
  },
  corridor: {
    cacheKey: 'floor1-cave-corridor',
    prompt:
      'Narrow cave passage floor of wet bedrock and fine gravel, darker and ' +
      'smoother than open cave ground. ' +
      SHARED_STYLE,
    tile: FLOOR_TILE,
  },
  doorSlab: FLOOR1_DUNGEON_SPEC.doorSlab,
};

/**
 * Floor 2 — industrial cave.
 *
 * These feed the shared-base pool builder
 * (`scripts/sprites/terrain-packs/rebuild-shared-base-pools.ts`) rather than
 * `composePack`: Floor 2 needs an 8-variant weighted pool cut from one base so
 * neighbouring cells stay cohesive, which quadrant-derivation cannot express.
 * The Azure material is the SOURCE TEXTURE; all silhouette, pooling and
 * lighting work stays local and deterministic.
 */
export const FLOOR2_INDUSTRIAL_CAVE_MATERIALS = {
  wall: {
    cacheKey: 'floor2-industrial-cave-wall',
    prompt:
      'Rough natural cave rock face of dark grey-brown stone, broken into a few ' +
      'large flat angular facets separated by deep hairline fractures, with ' +
      'chipped corners and shallow pits. Sparse, irregular, non-repeating ' +
      'geological detail — not cobblestone, not brickwork, not masonry, not ' +
      'planks. ' +
      SHARED_STYLE,
    tile: WALL_TILE,
  },
  floor: {
    cacheKey: 'floor2-industrial-cave-floor-v3',
    prompt:
      'Dry cracked cave floor of packed dark earth, warm brown-grey. BOLD LARGE ' +
      'FEATURES: roughly ten to fifteen long branching dark cracks that each run ' +
      'across a large part of the image, several wide irregular dark stains and ' +
      'dried mud smears the size of dinner plates, and a few broad shallow ' +
      'depressions. Features are big, high contrast and clearly readable from a ' +
      'distance, not fine speckle. Scattered irregularly at different sizes and ' +
      'angles, never evenly spaced, never a grid. Only a little fine grit between ' +
      'the large features. No tiles, no slabs, no masonry seams. ' +
      SHARED_STYLE,
    tile: FLOOR_TILE,
  },
  detail: {
    cacheKey: 'floor2-industrial-cave-detail-v2',
    prompt:
      'Sparse scatter of loose rubble on bare dark brown ground: a few small ' +
      'angular rock chips and clumps of coarse gravel gathered into uneven ' +
      'clusters with wide empty ground between them, plus thin dark cracks. ' +
      'Dark warm brown, low contrast, no light grey stones. Clustered and ' +
      'irregular, never evenly spaced, never a grid. ' +
      SHARED_STYLE,
    tile: FLOOR_TILE,
  },
  /**
   * Source for the four WALL ACCENT overlay atlases.
   *
   * The judge's standing finding is that a large wall mass is one blob47 frame
   * repeated, so the interior needs real per-tile variants. Wall accents are the
   * already-wired mechanism for that, and four disjoint crops of one generated
   * facet material give four genuinely different interiors that still share a
   * palette and scale.
   */
  wallFacet: {
    cacheKey: 'floor2-industrial-cave-wall-facet',
    prompt:
      'Large irregular fractured rock facets on dark charcoal stone: broad flat ' +
      'faces roughly a third to a half of the frame across, separated by deep ' +
      'black fractures, with a few chipped corners and long thin cracks running ' +
      'between them. Bold large-scale geological structure, high contrast ' +
      'between face and fracture. Not cobblestone, not brickwork, not masonry, ' +
      'not pebbles, not small uniform stones. ' +
      SHARED_STYLE,
    tile: WALL_TILE,
  },
} as const satisfies Record<string, SurfaceMaterialSpec>;

export interface SpecialFloorSpec {
  /** Pool id, also the on-disk file prefix. */
  readonly id: string;
  /** Key under the pack manifest's `specialFloorPools`. */
  readonly manifestKey: 'welcome' | 'safe' | 'bossStair';
  readonly material: SurfaceMaterialSpec;
}

export const FLOOR1_SPECIAL_FLOOR_SPECS: readonly SpecialFloorSpec[] = [
  {
    id: 'welcome',
    manifestKey: 'welcome',
    material: {
      cacheKey: 'floor1-welcome-floor',
      prompt:
        'Ceremonial entrance hall floor of polished dark slate tiles with thin ' +
        'brass inlay lines and a faint engraved geometric border pattern repeating ' +
        'across the surface. ' +
        SHARED_STYLE,
      tile: ACCENT_FLOOR_TILE,
    },
  },
  {
    id: 'safe',
    manifestKey: 'safe',
    material: {
      cacheKey: 'floor1-safe-floor',
      prompt:
        'Warm sanctuary floor of smooth sandstone tiles in muted amber and tan, ' +
        'swept clean, softly worn at the joints. ' +
        SHARED_STYLE,
      tile: ACCENT_FLOOR_TILE,
    },
  },
  {
    id: 'boss-stair',
    manifestKey: 'bossStair',
    material: {
      cacheKey: 'floor1-boss-stair-floor',
      prompt:
        'Ominous obsidian-black stone floor veined with dull red mineral cracks, ' +
        'ritual carvings faintly etched into the slabs. ' +
        SHARED_STYLE,
      tile: {
        sizePx: 64,
        posterizeLevels: 10,
        targetMeanLuminance: 58,
        maxLuminance: 140,
        targetStdDev: 18,
      },
    },
  },
];
