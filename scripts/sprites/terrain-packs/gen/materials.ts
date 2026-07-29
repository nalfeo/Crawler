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

/**
 * Floor 2 — INDUSTRIAL LINEWORK source materials.
 *
 * These are pure SURFACE textures. All linework geometry (rail head profile,
 * sleeper spacing, pipe bore and flange rings, the 16 edge-Wang masks and the
 * stub contract that makes them join) is computed locally and deterministically
 * in `import-floor2-linework.ts`; Azure only ever supplies the material that is
 * sampled through those masks. That is the same division of labour as
 * `buildWallAccents`, which clips a generated facet motif to a locally computed
 * wall-cell alpha.
 *
 * Consequence for the prompts: they must describe a FLAT UNIFORM SURFACE and
 * explicitly forbid rails, pipes, sleepers and any object silhouette. A
 * generated rail baked into the texture would fight the geometry mask and read
 * as a double image.
 */
export const FLOOR2_LINEWORK_MATERIALS = {
  /** Rail heads and switch hardware. */
  steel: {
    cacheKey: 'floor2-linework-steel',
    prompt:
      'Weathered industrial steel surface, cool blue-grey metal with patches of ' +
      'orange-brown rust bloom, fine scratches, pitting and old grease staining. ' +
      'Flat uniform metal surface only — no rails, no pipes, no rivets arranged ' +
      'in lines, no bolts, no machinery, no edges, no silhouettes. ' +
      SHARED_STYLE,
    tile: {
      sizePx: 64,
      posterizeLevels: 8,
      targetMeanLuminance: 80,
      maxLuminance: 150,
      targetStdDev: 12,
    },
  },
  /** Sleepers / ties under the rails. */
  timber: {
    cacheKey: 'floor2-linework-timber',
    prompt:
      'Creosote-soaked railway sleeper timber surface, very dark brown weathered ' +
      'wood with straight open grain, splits along the grain, and dark oily ' +
      'staining. Flat uniform wood surface only — no planks arranged as boards, ' +
      'no nails, no metal, no objects, no edges, no silhouettes. ' +
      SHARED_STYLE,
    tile: {
      sizePx: 64,
      posterizeLevels: 8,
      targetMeanLuminance: 56,
      maxLuminance: 120,
      targetStdDev: 12,
    },
  },
  /** Pipe runs. */
  iron: {
    cacheKey: 'floor2-linework-iron',
    prompt:
      'Corroded cast iron surface, dull dark grey-green metal with heavy rust ' +
      'scale, flaking patches, mineral crust and old verdigris staining. Flat ' +
      'uniform metal surface only — no pipes, no tubes, no flanges, no bolts, ' +
      'no valves, no machinery, no edges, no silhouettes. ' +
      SHARED_STYLE,
    tile: {
      sizePx: 64,
      posterizeLevels: 8,
      targetMeanLuminance: 74,
      maxLuminance: 140,
      targetStdDev: 12,
    },
  },
} as const satisfies Record<string, SurfaceMaterialSpec>;

/**
 * Floor 2 linework PROP sheet.
 *
 * Unlike every other spec in this file this is NOT a tileable material — it is a
 * 3x2 grid of discrete objects on a flat pure-magenta field that local code keys
 * out into six square frames. Chroma keying is derivation (the same class of
 * operation as the crack-mask isolation in `buildGroundDecals`), not texture
 * synthesis, so it stays on the correct side of the governing law: the object's
 * shape and surface both come from Azure, only the cut-out is local.
 *
 * `tile` is unused for this spec — the sheet is never made seamless — but the
 * field is kept so it satisfies `SurfaceMaterialSpec` and can flow through the
 * same generation harness.
 */
export const FLOOR2_LINEWORK_PROPS: SurfaceMaterialSpec = {
  cacheKey: 'floor2-linework-props-v2',
  prompt:
    'Six separate mining objects arranged in a 3x2 grid on a plain flat pure ' +
    'magenta background, one object centred in each cell with a wide magenta ' +
    'margin around it and no object touching another. Top row, left to right: a ' +
    'rusty iron mine cart on small wheels seen from directly above; an overturned ' +
    'empty mine cart seen from directly above; a track switch lever stand, a short ' +
    'iron lever on a base plate, seen from directly above. Bottom row, left to ' +
    'right: a chunky bolted iron pipe collar, a thick ring of metal with square ' +
    'bolt heads around its rim, seen from directly above; a small round pressure ' +
    'gauge with a dark dial face in a heavy iron bezel, seen from directly above; ' +
    'a compact iron handwheel with four thick spokes and a solid hub, seen from ' +
    'directly above. Every bottom-row object must be circular and symmetrical so ' +
    'it reads the same at any rotation. Top-down orthographic view, flat even ' +
    'lighting, no cast shadows, no perspective, no ground texture, no pipes, no ' +
    'rails, no text, no watermark, muted desaturated rusted industrial palette, ' +
    'dark fantasy dungeon crawler game asset sheet. The background must be a ' +
    'single uniform magenta colour everywhere it is not an object.',
  tile: {
    sizePx: 64,
    posterizeLevels: 12,
    targetMeanLuminance: 96,
    maxLuminance: 190,
    targetStdDev: 22,
  },
};

/**
 * Floor 2 linework WEAR overlay.
 *
 * A tileable field of corrosion damage that local code thresholds into a
 * darkening mask and multiplies over the pipe body. Only the *damage* comes from
 * Azure; the decision about which pixels of a frame it may touch (never the
 * edge-locked border band, never off-silhouette) is geometry, and stays local.
 *
 * The prompt asks for high contrast on a mid field precisely because the local
 * side only keeps the dark tail: a low-contrast material would threshold into
 * either nothing or a solid blot.
 */
export const FLOOR2_LINEWORK_WEAR: SurfaceMaterialSpec = {
  cacheKey: 'floor2-linework-wear',
  prompt:
    'Seamless tileable corrosion damage overlay: long vertical rust streaks ' +
    'running down a metal surface, dark hairline cracks in the crust, flaking ' +
    'scale patches and dark pitting, scattered unevenly with plenty of clean ' +
    'space between them. High contrast, very dark damage on a mid neutral grey ' +
    'field. No objects, no pipes, no rivets, no edges, no silhouettes, no text. ' +
    SHARED_STYLE,
  tile: {
    sizePx: 64,
    posterizeLevels: 6,
    targetMeanLuminance: 120,
    maxLuminance: 210,
    targetStdDev: 46,
  },
};

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
        // Still the darkest floor in the game (normal floor targets 74), but it
        // MUST stay above WALL_TILE's 62: a floor that reads darker than its
        // walls stops the walls reading as vertical. Authored at 58 originally,
        // which inverted that hierarchy in the boss room specifically.
        targetMeanLuminance: 70,
        maxLuminance: 140,
        targetStdDev: 18,
      },
    },
  },
];
