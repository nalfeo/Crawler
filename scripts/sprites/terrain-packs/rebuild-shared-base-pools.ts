/**
 * Rebuild the industrial-cave floor/corridor pools as ONE shared base plus
 * sparse interior detail.
 *
 * Why this exists
 * ---------------
 * The 2026-07-25 first pass generated eight INDEPENDENT seamless Azure
 * materials per surface. Each tiled perfectly against itself and badly against
 * its siblings — measured mean |dL| across a shared edge was 5.3 self vs 17.3
 * cross on floors (3.3x), 4.6 vs 14.3 on corridors — and the generated tiles
 * were stylistically foreign to the originals (23-61 colors at sd ~10 vs the
 * base's 232 colors at sd 3.5). Rendered together they read as a patchwork
 * quilt rather than as ground.
 *
 * This script rebuilds every non-base variant as `base + interior detail`:
 * - `floor-0` / `corridor-0` are the canonical bases and are NOT modified.
 * - `floor-1..7` / `corridor-1..7` are rewritten as that base plus a sparse
 *   detail patch whose structure is generated deterministically by
 *   `buildDetailStructure`.
 * - Detail never touches the outer `BORDER_MARGIN_PX` of the cell, so every
 *   variant keeps byte-identical borders. Cross-variant seams therefore equal
 *   the base's self-seam by construction, and that holds under flips too
 *   (a seamless tile's left edge equals its right edge, so mirroring preserves
 *   the shared border profile).
 *
 * Detail structures are procedural rather than image inputs on purpose: the
 * script then reads ONLY `*-0`, which it never writes, so it is idempotent and
 * safe to re-run. The previous revision seeded details from the committed art
 * at each index — which meant its outputs overwrote its own inputs, and a
 * single bad run destroyed the sources it needed to recover.
 *
 * The manifest is also re-weighted: the plain base becomes dominant so ground
 * reads as ground, with detail as occasional punctuation.
 *
 * Usage:
 *   npx tsx scripts/sprites/terrain-packs/rebuild-shared-base-pools.ts
 *   npx tsx scripts/sprites/terrain-packs/rebuild-shared-base-pools.ts --dry-run
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { compositeInto, createImage, decodePng, encodePng, type RgbaImage } from './png-buffer.js';
import { toPixelArtGround } from './gen/image-ops.js';
import {
  ATLAS_GRID_COLS,
  ATLAS_HEIGHT_PX,
  ATLAS_WIDTH_PX,
  buildMaskFrameAssignments,
} from './atlas-grid.js';
import { composeWallCellOutput } from './compose-wall-cell.js';
import { generateQuadrantKit } from './quadrant-kit.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import { isFullyOpaqueWallAlpha, isWallAlpha } from './wall-opacity.js';

const PACK_DIR = 'public/assets/terrain-packs/industrial-cave';
const MANIFEST_PATH = 'src/shared/data/terrain-packs/industrial-cave.manifest.json';

/** Untouched border on all four sides — the shared-edge guarantee. */ export const BORDER_MARGIN_PX = 10;

/**
 * Canonical pixel-art ground style, PER SURFACE.
 *
 * Why the restyle exists at all: the shipped bases were continuous-tone —
 * 232-640 colors over 4096px across 28-78 luminance levels, mean adjacent-pixel
 * delta ~2. Measured against Crawler's own characters and props (chunky
 * hard-stepped clusters, 24-45% of adjacent pairs stepping >=16 luminance) the
 * ground read as a different medium: a downsampled photograph sitting under
 * hand-authored pixel art.
 *
 * Why the two surfaces are styled DIFFERENTLY — this is the load-bearing part:
 *
 * - `corridor` is a MANUFACTURED surface (plate steel, rivet rows, seams). Its
 *   regular 64px repeat is not a defect, it is what the material is. Reading a
 *   rivet grid as "repetitive" would be reading a floor plate as a mistake, so
 *   `flattenRadius` is 0 here and the motif is preserved intact. Corridor
 *   variance comes from WEAR applied on top — scratches, scuffs, stains — which
 *   is how a real industrial floor differentiates, and which the detail pool
 *   supplies (see `KIND_BY_INDEX`).
 *
 * - `floor` is a NATURAL surface (rock, grit, dirt). Natural ground has no
 *   manufactured period, so any recognizable repeating shape reads immediately
 *   as tiled wallpaper. `flattenRadius` subtracts the base's large-scale
 *   structure so only fine grain survives; the tile still repeats, but there is
 *   no shape left large enough for the eye to lock onto. Verified at 2x gameplay
 *   zoom over a 5x5 tiling: at radius 0 the repeat is obvious, at 4 it is not.
 *
 * The remaining knobs are shared and interact:
 * - `targetStdDev` restores the variance block-averaging removes. It supersedes
 *   the old corridor-only contrast damping, which existed to hide that same
 *   large-scale motif and is the wrong tool now that the motif is deliberate.
 * - `valueStep` collapses the result onto ~7 levels, which is what produces
 *   visible hard steps rather than a gradient.
 */
const GROUND_STYLE = {
  floor: {
    flattenRadius: 4,
    blockPx: 2,
    valueStep: 5,
    targetStdDev: 7,
    maxChroma: 24,
  },
  corridor: {
    flattenRadius: 0,
    blockPx: 2,
    valueStep: 5,
    targetStdDev: 7,
    maxChroma: 24,
  },
} as const;

/**
 * Pool index 1 is a deliberately *quiet* variant: the same real-material
 * interior at a fraction of the blend strength.
 *
 * A single dominant base tile guarantees cohesion but reintroduces plain 64px
 * repetition. A second near-plain-but-not-identical tile sharing most of the
 * weight breaks that grid without adding visual noise, because both still share
 * byte-identical borders with the base.
 */
const QUIET_INDEX = 1;
const QUIET_STRENGTH_SCALE = 0.6;

/**
 * Relative pool weights. 10 : 8 : 1x6 puts the plain base at 10/24 = 41.7% and
 * the quiet variant at 33.3%, so three quarters of tiles read as calm ground
 * while still alternating between two distinct images. The six detail variants
 * split the remaining 25%, each showing on ~4.2% of tiles — frequent enough to
 * read as texture, rare enough to read as an event.
 */
const BASE_WEIGHT = 10;
const QUIET_WEIGHT = 8;
const DETAIL_WEIGHT = 1;

const POOL_SIZE = 8;

/**
 * How strongly a variant's real-material interior replaces the base interior.
 *
 * 1.0 would make each variant a wholly different tile, which reads as a patchwork;
 * this keeps the base clearly dominant while letting genuine generated structure
 * come through.
 */
const MATERIAL_BLEND_STRENGTH = 0.92;
/**
 * Interior contrast each variant carries, as a multiple of the base tile's own.
 * Both are > 1: a variant that is flatter than the plain base is not a detail
 * variant. The gap between them is the pool's loudness ordering, and it is what
 * makes cracks read at gameplay zoom instead of dissolving into grain.
 */
const DETAIL_CONTRAST_RATIO = 2.1;
const QUIET_CONTRAST_RATIO = 1.25;
/** Fraction of the contrast gain the ABOVE-mean side of a variant receives. */
const LIGHT_GAIN_SHARE = 0.2;
const SURFACES = ['floor', 'corridor'] as const;

/**
 * Ceiling on wall-accent chroma.
 *
 * The generated accents came back at up to 56 chroma against floors at 20-24
 * and corridors at 15. That inverts the intended hierarchy: decorative specks
 * on a wall were the most saturated thing on screen, pulling the eye off the
 * player and props. Clamping to 28 keeps accents inside the pack's own range
 * and, as a side effect, neutralizes the one accent whose blue read as foreign
 * against industrial-cave stone.
 *
 * The clamp targets an ABSOLUTE maximum, so re-running is a fixed point.
 */
const ACCENT_MAX_CHROMA = 28;

/** Skip a rewrite when already within this much of the ceiling (rounding slack). */
const ACCENT_CHROMA_TOLERANCE = 1;

/**
 * Pull wall-accent saturation down into the pack's palette range, then clip the
 * result to the canonical blob47 silhouette — one read, one write, per accent.
 *
 * The two operations are FUSED deliberately. When they were separate passes the
 * clip re-read each accent from disk, so it only saw the retuned bytes because
 * the caller happened to have flushed them in between. That made `--dry-run`
 * silently wrong (it never writes, so the clip measured stale art and the two
 * passes double-counted the same file), and it left a window where a crash
 * between the two writes committed retuned-but-spilling accents.
 *
 * RETUNE. Luminance-preserving: each channel moves toward the pixel's own gray,
 * so shape and shading survive and only colourfulness drops. The clamp targets
 * an ABSOLUTE maximum, so re-running is a fixed point.
 *
 * CLIP. The accent atlases are authored once against whatever `wall-atlas.png`
 * held at the time (see `buildWallAccentAtlas`), so they inherit that atlas's
 * silhouette permanently. When the wall silhouette is corrected — as it is
 * here, from 16 distinct shapes to the full 47 — every accent keeps painting
 * over the area the wall used to occupy and now spills onto open floor.
 * `validateCompatibleAccentTopology` fails that as `accent-spill`.
 *
 * Clipping is a pure INTERSECTION, so it can only ever remove accent coverage,
 * never invent it. That makes the step idempotent and safe to re-run, and it
 * keeps the accents correct for free the next time the silhouette changes.
 *
 * The cut is BINARY and keeps a pixel only where the wall is FULLY opaque.
 * Accents are asserted elsewhere to be binary-alpha overlays
 * (`terrain-pack-committed.test.ts`), so a `min()` blend is not available; and
 * a hard 255 accent sitting on a 128-254 wall pixel would paint an
 * anti-aliased rounded corner back into a square. Cutting at full opacity costs
 * an accent stopping a pixel short of the curve — invisible at play scale, and
 * accents are restrained interior detail by design anyway.
 */
export function processWallAccents(packDir: string = PACK_DIR): readonly WrittenFile[] {
  const wall = composeCanonicalSilhouetteAtlas();
  const out: WrittenFile[] = [];
  const files = fs
    .readdirSync(packDir)
    .filter((f) => f.startsWith('accent-') && f.endsWith('.png'))
    .sort();

  for (const file of files) {
    const rel = path.join(packDir, file);
    const img = decodePng(fs.readFileSync(rel));
    if (img.width !== wall.width || img.height !== wall.height) {
      throw new Error(
        `processWallAccents: ${file} is ${img.width}x${img.height}, expected ${wall.width}x${wall.height}`,
      );
    }
    let changed = false;

    let maxChroma = 0;
    for (let i = 0; i < img.data.length; i += 4) {
      if (img.data[i + 3]! === 0) continue;
      const r = img.data[i]!;
      const g = img.data[i + 1]!;
      const b = img.data[i + 2]!;
      const c = Math.max(r, g, b) - Math.min(r, g, b);
      if (c > maxChroma) maxChroma = c;
    }
    if (maxChroma > ACCENT_MAX_CHROMA + ACCENT_CHROMA_TOLERANCE) {
      const k = ACCENT_MAX_CHROMA / maxChroma;
      for (let i = 0; i < img.data.length; i += 4) {
        if (img.data[i + 3]! === 0) continue;
        const r = img.data[i]!;
        const g = img.data[i + 1]!;
        const b = img.data[i + 2]!;
        const gray = 0.299 * r + 0.587 * g + 0.114 * b;
        img.data[i] = Math.round(gray + (r - gray) * k);
        img.data[i + 1] = Math.round(gray + (g - gray) * k);
        img.data[i + 2] = Math.round(gray + (b - gray) * k);
      }
      changed = true;
    }

    for (let i = 3; i < img.data.length; i += 4) {
      if (img.data[i]! === 0) continue;
      if (isFullyOpaqueWallAlpha(wall.data[i]!)) continue;
      img.data[i] = 0;
      changed = true;
    }

    if (!changed) continue;
    out.push({ relPath: rel, bytes: encodePng(img) });
  }
  return out;
}

interface WrittenFile {
  readonly relPath: string;
  readonly bytes: Buffer;
}

/** Near-black outline where the silhouette meets open space. */
const WALL_OUTLINE_MEAN = 5;
const WALL_OUTLINE_PX = 1;
/**
 * Mean luminance of the wall's TOP surface — the face you look down on.
 *
 * Deliberately ABOVE the floor's ~45. This was 22 (far below the floor) for two
 * iterations and it is why "no verticality" survived the outline, the bevel and
 * the streaked face: with an overhead light, a surface that is darker than the
 * ground reads as a HOLE, not a block. Observed in the real cave — the wall
 * blobs looked like pits punched through the floor. The raised read comes from
 * the ordering `cap > top > floor > face > contact`, not from separation alone.
 */
/**
 * Mean luminance of the wall's flat TOP surface — the face you look down on.
 *
 * This sits BELOW the floor's ~45 on purpose. Two earlier passes fought over
 * this value and both were wrong for the same reason: they treated brightness
 * as the wall/floor separator.
 *
 * - Dark top (22) with no lit front face read as a HOLE punched in the floor.
 * - Bright top (72) read as the walkable surface itself — playtest feedback was
 *   "reads as standing on a ledge, not in a room", because the eye assigns the
 *   brightest, largest, most detailed surface to the space it occupies.
 *
 * The resolution is that brightness is not the cue at all. The floor stays the
 * brightest broad surface because that is the space you occupy; the wall reads
 * as raised from STRUCTURE — a lit rim along its top edge, a bright lit front
 * face along its bottom edge, a dark contact line under that, and a hard
 * outline. The top surface is the part turned away from the light, so it is
 * dark and desaturated, which is also what stops it competing with the floor.
 */
const WALL_TOP_MEAN = 34;
/** Height, in px, of the vertical front face drawn where a wall meets open floor below. */
const WALL_FACE_PX = 20;
/**
 * Height, in px, of one horizontal stratum band on the front face.
 *
 * The face is textured as layered rock rather than vertical grain. Vertical
 * grain is the more obvious cue for "this plane is vertical", and it was tried
 * first, but at this thickness it always resolved into evenly spaced ribbing
 * that vision review read as wooden slats or a grate — a manufactured look,
 * which the design law forbids on a natural surface. Horizontal strata carry
 * the same "this is not the top surface" signal via a different, geological
 * vocabulary, and the near-black contact shadow does the rest.
 */
const WALL_FACE_BAND_PX = 5;
/**
 * Mean luminance at the TOP of the front face.
 *
 * The front face is the brightest broad element of the wall. It is the plane
 * turned toward the camera and the light, so lighting it is physically right,
 * and it is also the only surface whose orientation is unambiguous — a lit
 * band hanging below a dark top surface can only be read as the front of a
 * raised block. That is what carries verticality now that the top surface has
 * been taken out of the brightness contest with the floor.
 */
const WALL_FACE_TOP_MEAN = 70;
/** ...and at its base, where less light reaches. Still above the floor. */
const WALL_FACE_BOTTOM_MEAN = 48;
/**
 * Lit rim along the wall's top edge.
 *
 * Thin and only modestly above the floor: it marks where the top surface
 * begins without turning the wall mass back into the brightest thing on
 * screen.
 */
const WALL_CAP_MEAN = 54;
/** Thickness of that hard-lit lip, in px (measured inside the outline). */
const WALL_CAP_PX = 3;
/** A dimmer band under the lip, so the edge rolls off instead of cutting. */
const WALL_CAP_FALLOFF_PX = 6;
const WALL_CAP_FALLOFF_DELTA = 11;
/**
 * Contact shadow along the very bottom of the front face.
 *
 * Deep and thin. This is the line that grounds the wall: a lit vertical plane
 * meeting the floor with no dark seam floats, while the same plane with a hard
 * shadow under it sits ON the ground. The renderer stamps each wall strictly
 * inside its own 64px cell, so a real cast shadow ONTO the floor tile is not
 * available — this in-cell line is the closest legal substitute.
 */
const WALL_CONTACT_DELTA = 34;
const WALL_CONTACT_PX = 2;
/** Side shading: left catches light, right falls away. */
const WALL_SIDE_DELTA = 6;
const WALL_SIDE_PX = 4;
/**
 * Internal contrast multiplier applied to the material's deviation from its own
 * mean.
 *
 * >1 on purpose. Simply scaling luminance down to darken the walls scales their
 * VARIANCE down with it, and the first attempt at that produced flat dark
 * slabs that read as "darker floor" rather than rock. Re-centring the mean and
 * amplifying the deviation separately darkens the surface while giving it more
 * internal structure than the ground it borders.
 */
const WALL_CONTRAST_GAIN = 1.0;
/** Value quantization for the wall material — same grid as the ground. */
const WALL_VALUE_STEP = 12;
/**
 * Chroma ceiling, matching the ground's own. `WALL_CONTRAST_GAIN` amplifies
 * per-channel deviation as well as luminance, which pushed the walls to chroma
 * 32 against the floor's 24 — visibly more saturated than the surface they are
 * cut from. Clamping restores the shared palette.
 */
const WALL_MAX_CHROMA = 30;
/**
 * Warm bias applied to the LIT FRONT FACE, in luminance-neutral units per
 * channel (R up, B down, G held).
 *
 * The warmth moved here from the top surface. Warmth reads as "this plane is
 * catching the light", so putting it on the top surface actively fought the
 * goal — a warm, bright top is what made the wall read as the walkable floor.
 * On the front face it reinforces exactly the right thing.
 */
const WALL_FACE_WARMTH = 10;
/**
 * Chroma multiplier for the wall's shadowed TOP surface.
 *
 * Shadowed rock desaturates. Practically, this is the second half of taking the
 * top surface out of competition with the floor: the floor keeps its warm dirt
 * chroma, the wall top goes grey, and the two stop reading as the same
 * material even where no edge lighting is visible.
 */
const WALL_TOP_DESAT = 0.4;
/**
 * Radius, in px, over which wall detail fades out toward the interior.
 *
 * Under blob47 autotiling a big wall mass is overwhelmingly ONE frame (the
 * fully-enclosed interior), so any detail that frame carries repeats on a rigid
 * 64px grid — the "very repetitive" complaint. Fading detail to zero more than
 * this far from an edge removes the repeating unit entirely; the surviving
 * detail sits on edges, which differ frame to frame.
 *
 * Kept narrow now that the material is real generated rock sampled by absolute
 * atlas position: its facets already span several cells, so it does not carry a
 * per-frame repeat that needs hiding. This now only softens the very centre.
 */
const WALL_INTERIOR_PX = 10;
/**
 * Residual detail kept in the deep interior.
 *
 * Zero here removes the 64px repeat completely but leaves the wall a dead flat
 * black slab, which reads as a hole rather than rock. A small residual keeps
 * the surface alive while holding the repeating unit well below the threshold
 * where the eye latches onto it as a grid.
 *
 * Raised from 0.3 once the procedural rock was replaced by generated material:
 * 0.3 was crushing real multi-cell facets that are the whole reason the wall
 * reads as rock at all.
 */
const WALL_INTERIOR_MIN_DETAIL = 0.85;

/**
 * Pixel-art grain for the WALL material.
 *
 * Deliberately the same shape as `GROUND_STYLE` — same 2px block, same value
 * quantization — so wall and floor share one pixel scale. `flattenRadius` is 0
 * because the wall material is intentionally motifless already, and
 * `targetStdDev` is lower than the floor's: the wall's structure is supposed to
 * come from the accent overlays and the edge lighting, not from body texture.
 */
const WALL_GROUND_STYLE = {
  flattenRadius: 0,
  blockPx: 2,
  valueStep: 6,
  targetStdDev: 9,
  maxChroma: 24,
};

/**
 * The 47-mask silhouette sheet, alpha-only ground truth for the wall atlas.
 *
 * This is the same composition `composeWallAtlas` performs, minus the material
 * pass — `restyleWallAtlas` does its own lighting and material sampling, so it
 * only needs the geometry.
 */
function composeCanonicalSilhouetteAtlas(): RgbaImage {
  const quadrantKit = generateQuadrantKit();
  const sheet = createImage(ATLAS_WIDTH_PX, ATLAS_HEIGHT_PX);
  for (const { maskId, frameIndex } of buildMaskFrameAssignments()) {
    const col = frameIndex % ATLAS_GRID_COLS;
    const row = Math.floor(frameIndex / ATLAS_GRID_COLS);
    compositeInto(
      sheet,
      composeWallCellOutput(maskId, quadrantKit),
      col * TERRAIN_PACK_CELL_PX,
      row * TERRAIN_PACK_CELL_PX,
    );
  }
  return sheet;
}

/**
 * Re-stamps `wall-atlas.png` with the floor's own material, lit as a solid block.
 *
 * WHY THIS EXISTS. The walls were the last continuous-tone surface in the pack:
 * 475 colors across 50 luminance levels against the restyled ground's 69-178 /
 * 11-18. Standing next to hard-stepped ground they read as smooth photographic
 * rock — the blurriest thing on screen.
 *
 * WHY IT STAMPS RATHER THAN FILTERS. Running the ground restyle over the
 * committed atlas would have produced *a* pixel-art wall, but nothing would
 * have tied its palette or grain to the floor's; the two would drift apart on
 * every future retune. Walls and floor are the same rock in the same cave, so
 * the wall material IS the floor material — sampled from the already-restyled
 * `floor-0` and re-snapped to the same value grid.
 *
 * WHY IT IS LIT RATHER THAN JUST DARKENED. Sharing the material is necessary
 * for cohesion but not sufficient: a uniformly darkened stamp reads as *darker
 * floor*, because nothing in it says "this is above the ground". Height has to
 * be drawn, so the silhouette is shaded as a block under a fixed light — a lit
 * cap along its top lip, a flat top surface, a vertical front face wherever it
 * meets open floor below, and a contact shadow where that face lands. This is
 * the standard top-down pixel-art read, and it is what separates wall from
 * ground at a glance rather than by brightness alone.
 *
 * This also fixes a latent build bug. `generateQuadrantKit` emits solid-fill
 * silhouettes (correct alpha, no material), so `terrain-packs:build` on its own
 * overwrote the textured atlas with flat grey; the shipped art was only ever
 * reachable by hand. Output RGB here is a pure function of `floor-0` plus the
 * silhouette's alpha, so the step is idempotent no matter what the atlas held
 * before, and the build now reproduces the shipped art end to end.
 *
 * Alpha comes from the CANONICAL blob47 silhouettes, not from the file this
 * step overwrites. Reading alpha back out of `wall-atlas.png` made the shipped
 * silhouette self-perpetuating: whatever geometry happened to be in the PNG was
 * copied forward on every run, so a wrong silhouette could never be corrected
 * by re-running the build, only by hand-editing art. That is exactly how the
 * pack came to ship 16 distinct shapes across its 47 mask slots — the diagonal
 * bits were never expressed, and `restyleWallAtlas` faithfully preserved the
 * defect. Deriving alpha from `composeWallCellOutput` makes the step
 * self-healing and keeps the silhouette a pure function of the mask set, which
 * is what `validateCompatibleCorners` gates on.
 *
 * `packDir` exists so a test can point the whole step at an isolated copy of
 * the pack. Proving alpha is DERIVED rather than inherited requires feeding it
 * a deliberately corrupted `wall-atlas.png` — and doing that to the committed
 * one would race every other suite that reads the shipped sheet.
 */
export function restyleWallAtlas(packDir: string = PACK_DIR): readonly WrittenFile[] {
  const atlasPath = path.join(packDir, 'wall-atlas.png');
  const atlas = composeCanonicalSilhouetteAtlas();
  // Generated cave-rock art, imported from Azure output by
  // `import-floor2-materials.ts` and committed. Sampled by ABSOLUTE atlas
  // position (see below), so its large facets span several cells rather than
  // reprinting inside every one.
  const rawMaterial = decodePng(fs.readFileSync(path.join(PACK_DIR, 'wall-material.png')));
  // Same pixel-art re-grain the ground pools get. Without it the wall keeps the
  // generator's fine continuous-tone noise and reads as downsampled photographic
  // stone next to block-grained floors — a judged, repeated finding.
  const material = toPixelArtGround(rawMaterial, WALL_GROUND_STYLE);

  let sum = 0;
  let count = 0;
  for (let i = 0; i < material.data.length; i += 4) {
    sum +=
      0.299 * material.data[i]! + 0.587 * material.data[i + 1]! + 0.114 * material.data[i + 2]!;
    count++;
  }
  const materialMean = sum / count;

  const opaque = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= atlas.width || y >= atlas.height) return false;
    return isWallAlpha(atlas.data[(y * atlas.width + x) * 4 + 3]!);
  };
  /**
   * Steps to the nearest transparent pixel along one direction, capped.
   *
   * Deliberately clipped to the 64px CELL the pixel lives in, not the whole
   * atlas: frames sit edge to edge, so an unclipped scan would run out of one
   * frame and into its neighbour, and a wall would be lit by the silhouette of
   * an unrelated tile.
   */
  const runTo = (x: number, y: number, dx: number, dy: number, cap: number): number => {
    const cellLeft = Math.floor(x / 64) * 64;
    const cellTop = Math.floor(y / 64) * 64;
    for (let step = 1; step <= cap; step++) {
      const nx = x + dx * step;
      const ny = y + dy * step;
      const outside = nx < cellLeft || nx >= cellLeft + 64 || ny < cellTop || ny >= cellTop + 64;
      if (outside) return cap + 1;
      if (!opaque(nx, ny)) return step;
    }
    return cap + 1;
  };

  const out = composeCanonicalSilhouetteAtlas();
  for (let y = 0; y < atlas.height; y++) {
    for (let x = 0; x < atlas.width; x++) {
      const i = (y * atlas.width + x) * 4;
      // Shade every pixel the silhouette paints at all, including the partially
      // transparent anti-aliased fringe of a rounded corner. Skipping those at
      // the <128 lighting threshold would leave them at the silhouette's flat
      // fill colour, drawing a grey halo around every rounded corner.
      if (atlas.data[i + 3]! === 0) continue;

      const up = runTo(x, y, 0, -1, WALL_CAP_FALLOFF_PX);
      const down = runTo(x, y, 0, 1, WALL_FACE_PX);
      const left = runTo(x, y, -1, 0, WALL_SIDE_PX);
      const right = runTo(x, y, 1, 0, WALL_SIDE_PX);
      // Distance to the nearest open space in any direction, probed well past
      // the lighting bands. See WALL_INTERIOR_PX for why this exists.
      const edgeDist = Math.min(
        runTo(x, y, 0, -1, WALL_INTERIOR_PX),
        runTo(x, y, 0, 1, WALL_INTERIOR_PX),
        runTo(x, y, -1, 0, WALL_INTERIOR_PX),
        runTo(x, y, 1, 0, WALL_INTERIOR_PX),
      );

      let mean: number;
      let onFace = false;
      let onOutline = false;
      if (Math.min(up, down, left, right) <= WALL_OUTLINE_PX) {
        // Hard outline against open space. Cheap, and it does more for
        // separating wall from floor than any amount of body shading.
        mean = WALL_OUTLINE_MEAN;
        onOutline = true;
      } else if (up <= WALL_CAP_PX) {
        // Hard-lit lip along the top edge.
        mean = WALL_CAP_MEAN;
      } else if (up <= WALL_CAP_FALLOFF_PX) {
        // Roll-off under the lip, so the edge reads as a rounded lit surface
        // rather than a decal stripe.
        mean = WALL_TOP_MEAN + WALL_CAP_FALLOFF_DELTA;
      } else if (down <= WALL_FACE_PX) {
        // Vertical front face, darkening toward its base.
        onFace = true;
        const t = 1 - (down - 1) / WALL_FACE_PX;
        mean = WALL_FACE_TOP_MEAN + (WALL_FACE_BOTTOM_MEAN - WALL_FACE_TOP_MEAN) * t;
        if (down <= WALL_CONTACT_PX) mean -= WALL_CONTACT_DELTA;
      } else {
        mean = WALL_TOP_MEAN;
      }
      if (!onFace) {
        if (left <= WALL_SIDE_PX) mean += WALL_SIDE_DELTA;
        else if (right <= WALL_SIDE_PX) mean -= WALL_SIDE_DELTA;
      }

      // Sample the material by absolute atlas position, not per-frame position:
      // adjacent wall cells in the world come from arbitrary atlas frames, so
      // tying the material to the frame origin would print a visible 64px
      // checker across every wall run.
      //
      // The face is sampled as HORIZONTAL STRATA: y is snapped to a band and
      // each band is offset in x. Earlier passes smeared the material downward,
      // which produced evenly spaced vertical ribbing that two vision reviews
      // read as wooden slats or a drainage grate — a manufactured look, which
      // the design law forbids on a natural surface. Strata run the other way
      // and read as fractured sedimentary rock.
      let sx = x;
      let sy = y;
      if (onFace) {
        const band = Math.floor(y / WALL_FACE_BAND_PX);
        sy = band * WALL_FACE_BAND_PX * 3;
        sx = x + band * 37;
      }
      const mi =
        ((((sy % material.height) + material.height) % material.height) * material.width +
          (((sx % material.width) + material.width) % material.width)) *
        4;
      const mr = material.data[mi]!;
      const mg = material.data[mi + 1]!;
      const mb = material.data[mi + 2]!;
      const luma = 0.299 * mr + 0.587 * mg + 0.114 * mb;
      // Quiet the deep interior.
      //
      // This is the fix for the complaint that started this whole task: the
      // wall "repeats". A large wall mass is, under blob47 autotiling, almost
      // entirely ONE frame — the fully-enclosed interior tile — so whatever
      // rock detail that single frame carries gets printed in a rigid 64px
      // grid across the mass. Two independent vision reviews named that exact
      // period. No material, palette or lighting change can fix it, because
      // the repeating unit is the tile itself.
      //
      // So: make the deep interior carry no salient detail. Detail survives
      // only near an edge, and edges vary from frame to frame, so what the eye
      // actually tracks along a wall run is non-repeating. The interior
      // becomes flat dark rock, which is also what a shadowed rock mass looks
      // like from directly above.
      const detailWeight =
        onFace || onOutline
          ? 1
          : WALL_INTERIOR_MIN_DETAIL +
            (1 - WALL_INTERIOR_MIN_DETAIL) *
              Math.min(1, Math.max(0, 1 - edgeDist / WALL_INTERIOR_PX));
      const target = mean + (luma - materialMean) * WALL_CONTRAST_GAIN * detailWeight;
      const snapped = Math.max(
        WALL_VALUE_STEP,
        Math.round(target / WALL_VALUE_STEP) * WALL_VALUE_STEP,
      );
      const chroma = Math.max(mr, mg, mb) - Math.min(mr, mg, mb);
      let chromaScale =
        chroma * WALL_CONTRAST_GAIN > WALL_MAX_CHROMA
          ? WALL_MAX_CHROMA / Math.max(chroma, 1e-6)
          : WALL_CONTRAST_GAIN;
      if (!onFace && !onOutline) chromaScale *= WALL_TOP_DESAT;
      chromaScale *= detailWeight;
      const warm = onFace ? WALL_FACE_WARMTH : 0;
      const chan = (c: number, bias: number): number =>
        Math.max(0, Math.min(255, Math.round(snapped + (c - luma) * chromaScale + bias)));
      out.data[i] = chan(mr, warm);
      out.data[i + 1] = chan(mg, 0);
      out.data[i + 2] = chan(mb, -warm);
      out.data[i + 3] = atlas.data[i + 3]!;
    }
  }
  flattenTilingFrames(out);
  return [{ relPath: atlasPath, bytes: encodePng(out) }];
}

/**
 * Removes the large-scale luminance ramp from fully-opaque wall frames.
 *
 * WHY. Under blob47, the interior of any large wall mass is ONE frame stamped
 * over and over. Whatever low-frequency structure that single frame carries —
 * here a ~15-luma vertical ramp inherited from the generated material — is
 * therefore reprinted on a rigid 64px grid and reads as banding, which is the
 * original "very repetitive" complaint in its final form.
 *
 * The fix is frequency-selective rather than tonal: subtract each frame's own
 * blurred self, keeping the high-frequency cracks and facets that make it read
 * as rock while flattening the ramp that tiles. Only frames with no transparent
 * pixel are touched — edge frames are seen once per silhouette boundary, never
 * tiled, and their lighting bands must survive intact.
 */
function flattenTilingFrames(img: RgbaImage): void {
  const CELL = 64;
  /** Box-blur radius. Well above facet scale, well below the cell. */
  const R = 12;
  const lumaAt = (x: number, y: number): number => {
    const i = (y * img.width + x) * 4;
    return 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
  };

  for (let cy = 0; cy + CELL <= img.height; cy += CELL) {
    for (let cx = 0; cx + CELL <= img.width; cx += CELL) {
      let opaque = true;
      for (let y = 0; y < CELL && opaque; y++) {
        for (let x = 0; x < CELL; x++) {
          if (!isWallAlpha(img.data[((cy + y) * img.width + cx + x) * 4 + 3]!)) {
            opaque = false;
            break;
          }
        }
      }
      if (!opaque) continue;

      let mean = 0;
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) mean += lumaAt(cx + x, cy + y);
      }
      mean /= CELL * CELL;

      const delta = new Float32Array(CELL * CELL);
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          let sum = 0;
          let n = 0;
          for (let by = -R; by <= R; by++) {
            const sy = y + by;
            if (sy < 0 || sy >= CELL) continue;
            for (let bx = -R; bx <= R; bx++) {
              const sx = x + bx;
              if (sx < 0 || sx >= CELL) continue;
              sum += lumaAt(cx + sx, cy + sy);
              n++;
            }
          }
          delta[y * CELL + x] = mean - sum / n;
        }
      }

      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const d = delta[y * CELL + x]!;
          const i = ((cy + y) * img.width + cx + x) * 4;
          for (let c = 0; c < 3; c++) {
            img.data[i + c] = Math.max(0, Math.min(255, Math.round(img.data[i + c]! + d)));
          }
        }
      }
    }
  }
}

/**
 * Copy `base`'s border margin back over `variant`, restoring byte-identical
 * borders.
 *
 * The compositor already leaves the margin untouched, but the pixel-art re-grain
 * that runs afterwards is a global operation: block-averaging and value-snapping
 * a border pixel is *very nearly* the identity (the snap's chroma offsets are
 * mean-preserving by construction) but only to within 8-bit rounding. "Very
 * nearly" is not good enough — the whole cohesion guarantee is that cross-variant
 * seams equal the base's self-seam BY CONSTRUCTION, and a 1-LSB drift would
 * downgrade that to "by measurement". Restoring the margin verbatim keeps it
 * exact. Safe to do bluntly because BORDER_MARGIN_PX is a multiple of blockPx,
 * so no grain block straddles the restore boundary.
 */
function restoreBorder(variant: RgbaImage, base: RgbaImage, marginPx: number): RgbaImage {
  if (variant.width !== base.width || variant.height !== base.height) {
    throw new Error('restoreBorder: variant and base must be the same size');
  }
  for (let y = 0; y < variant.height; y++) {
    for (let x = 0; x < variant.width; x++) {
      const inside =
        x >= marginPx &&
        y >= marginPx &&
        x < variant.width - marginPx &&
        y < variant.height - marginPx;
      if (inside) continue;
      const i = (y * variant.width + x) * 4;
      variant.data[i] = base.data[i]!;
      variant.data[i + 1] = base.data[i + 1]!;
      variant.data[i + 2] = base.data[i + 2]!;
      variant.data[i + 3] = base.data[i + 3]!;
    }
  }
  return variant;
}

/**
 * Blend a real generated-material tile into the interior of the shared base.
 *
 * WHY FEATHERED RATHER THAN PASTED. Every pool variant must keep byte-identical
 * border pixels or adjacent tiles seam — that is the cohesion rule the earlier
 * "8 independent materials" attempt violated, and it is pinned by a byte-equality
 * test. Hard-pasting an interior and then restoring the border satisfies the byte
 * test but leaves a visible ring where the pasted interior meets the base. So the
 * variant's weight ramps from 0 at `marginPx` to 1 by `marginPx * 2` inward: the
 * border is untouched, the transition is invisible, and the deep interior is
 * entirely real generated rock.
 */
function blendMaterialInterior(
  base: RgbaImage,
  variant: RgbaImage,
  marginPx: number,
  strength: number,
): RgbaImage {
  const out: RgbaImage = { width: base.width, height: base.height, data: Buffer.from(base.data) };
  const ramp = marginPx;
  for (let y = 0; y < base.height; y++) {
    for (let x = 0; x < base.width; x++) {
      const edge = Math.min(x, y, base.width - 1 - x, base.height - 1 - y);
      if (edge < marginPx) continue;
      const w = Math.min(1, (edge - marginPx) / ramp) * strength;
      if (w <= 0) continue;
      const i = (y * base.width + x) * 4;
      for (let c = 0; c < 3; c++) {
        out.data[i + c] = Math.round(base.data[i + c]! * (1 - w) + variant.data[i + c]! * w);
      }
    }
  }
  return out;
}

/** Slice tile `i` out of a horizontal 64px strip. */
function sliceStrip(strip: RgbaImage, i: number, sizePx: number): RgbaImage {
  const out: RgbaImage = { width: sizePx, height: sizePx, data: Buffer.alloc(sizePx * sizePx * 4) };
  for (let y = 0; y < sizePx; y++) {
    const si = (y * strip.width + i * sizePx) * 4;
    strip.data.copy(out.data, y * sizePx * 4, si, si + sizePx * 4);
  }
  return out;
}

/**
 * Restore interior contrast lost to blending, relative to the base tile.
 *
 * WHY THIS EXISTS. Blending two decorrelated textures at weight `s` retains only
 * `sqrt(s^2 + (1-s)^2)` of their deviation — always less than 1. So the mixer
 * that gives us a seamless variant interior also, unavoidably, mushes it: a
 * "detail" variant came out FLATTER than the plain base it was supposed to add
 * detail to. That is a defect of the blend, not a property of the art, and this
 * corrects it rather than papering over it.
 *
 * The gain is expressed as a RATIO to the base's own interior contrast, so the
 * pool's intended loudness ordering (plain base < quiet variant < detail
 * variants) is guaranteed by construction and cannot drift when the source
 * material is re-generated. Mean-preserving and interior-only, so tone and the
 * byte-identical border are both untouched.
 */
function normalizeInteriorContrast(
  composed: RgbaImage,
  base: RgbaImage,
  marginPx: number,
  ratio: number,
): RgbaImage {
  const interiorStats = (image: RgbaImage): { mean: number; stdDev: number } => {
    let sum = 0;
    let sumSq = 0;
    let n = 0;
    for (let y = marginPx; y < image.height - marginPx; y++) {
      for (let x = marginPx; x < image.width - marginPx; x++) {
        const i = (y * image.width + x) * 4;
        const luma =
          0.299 * image.data[i]! + 0.587 * image.data[i + 1]! + 0.114 * image.data[i + 2]!;
        sum += luma;
        sumSq += luma * luma;
        n += 1;
      }
    }
    const mean = sum / n;
    return { mean, stdDev: Math.sqrt(Math.max(0, sumSq / n - mean * mean)) };
  };

  const composedStats = interiorStats(composed);
  const baseStats = interiorStats(base);
  if (composedStats.stdDev <= 0.01) return composed;
  const gain = (baseStats.stdDev * ratio) / composedStats.stdDev;
  // ASYMMETRIC ON PURPOSE. A crack, a stain and a scuff are all DARKNESS. A
  // symmetric gain amplifies the bright grit just as hard, which turned detail
  // variants into pale blobs that read as a different tile stamped in rather
  // than as a feature in the ground. Bright side is barely touched.
  const lightGain = 1 + (gain - 1) * LIGHT_GAIN_SHARE;
  // Per-channel means, not the luma mean: scaling every channel around a single
  // shared midpoint drags hue as it expands, which pushed the variants green.
  const channelMeans = [0, 1, 2].map((ch) => {
    let sum = 0;
    let n = 0;
    for (let y = marginPx; y < composed.height - marginPx; y++) {
      for (let x = marginPx; x < composed.width - marginPx; x++) {
        sum += composed.data[(y * composed.width + x) * 4 + ch]!;
        n += 1;
      }
    }
    return sum / n;
  });
  const out: RgbaImage = {
    width: composed.width,
    height: composed.height,
    data: Buffer.from(composed.data),
  };
  for (let y = marginPx; y < composed.height - marginPx; y++) {
    for (let x = marginPx; x < composed.width - marginPx; x++) {
      const i = (y * composed.width + x) * 4;
      const luma =
        0.299 * composed.data[i]! + 0.587 * composed.data[i + 1]! + 0.114 * composed.data[i + 2]!;
      const applied = luma < composedStats.mean ? gain : lightGain;
      for (let ch = 0; ch < 3; ch++) {
        const mid = channelMeans[ch]!;
        const value = mid + (composed.data[i + ch]! - mid) * applied;
        out.data[i + ch] = Math.min(255, Math.max(0, Math.round(value)));
      }
    }
  }
  // The asymmetric gain expands the dark side harder than the bright side, so
  // unlike a symmetric gain it is NOT mean-preserving — it drags the variant
  // darker than the base and breaks the shared-tone cohesion law. Re-centre the
  // interior back onto its original mean.
  const shift = composedStats.mean - interiorStats(out).mean;
  if (Math.abs(shift) > 0.01) {
    for (let y = marginPx; y < out.height - marginPx; y++) {
      for (let x = marginPx; x < out.width - marginPx; x++) {
        const i = (y * out.width + x) * 4;
        for (let ch = 0; ch < 3; ch++) {
          out.data[i + ch] = Math.min(255, Math.max(0, Math.round(out.data[i + ch]! + shift)));
        }
      }
    }
  }
  return out;
}

export function rebuildSharedBasePools(): readonly WrittenFile[] {
  const out: WrittenFile[] = [];

  for (const surface of SURFACES) {
    const style = GROUND_STYLE[surface];
    if (style === undefined) throw new Error(`no ground style configured for ${surface}`);

    // Only the base is read. It may be rewritten in place, but every write is a
    // normalization to an ABSOLUTE target, so re-running is a fixed point and
    // the script cannot compound its own output.
    const rawBase: RgbaImage = decodePng(fs.readFileSync(path.join(PACK_DIR, `${surface}-0.png`)));
    const base = toPixelArtGround(rawBase, style);
    if (base !== rawBase) {
      out.push({
        relPath: path.join(PACK_DIR, `${surface}-0.png`),
        bytes: encodePng(base),
      });
    }

    // Variant interiors are REAL windows of the generated material, cut by the
    // import step. Procedural detail synthesis is deliberately not used here.
    const stripPath = path.join(PACK_DIR, `${surface}-variant-src.png`);
    if (!fs.existsSync(stripPath)) {
      throw new Error(
        `missing ${stripPath}. Run import-floor2-materials.ts first — pool variants are ` +
          `cut from the generated material, not synthesized.`,
      );
    }
    const strip = decodePng(fs.readFileSync(stripPath));

    for (let i = 1; i < POOL_SIZE; i++) {
      const quiet = i === QUIET_INDEX;
      // flattenRadius is deliberately 0 here. On the base it suppresses a
      // tile-wide lighting ramp, but on a variant it is a high-pass that eats
      // exactly the thing the variant exists to carry: a crack and a broad stain
      // ARE low-frequency darkness, so flattening them leaves a faint scratch.
      const variant = toPixelArtGround(sliceStrip(strip, i - 1, base.width), {
        ...style,
        flattenRadius: 0,
      });
      const composed = normalizeInteriorContrast(
        blendMaterialInterior(
          base,
          variant,
          BORDER_MARGIN_PX,
          quiet ? MATERIAL_BLEND_STRENGTH * QUIET_STRENGTH_SCALE : MATERIAL_BLEND_STRENGTH,
        ),
        base,
        BORDER_MARGIN_PX,
        quiet ? QUIET_CONTRAST_RATIO : DETAIL_CONTRAST_RATIO,
      );
      // Re-grain so the blended interior lands on the same block size and value
      // ramp as the base. `targetStdDev` is deliberately omitted: renormalizing
      // here would fight the deliberate per-variant detail amplitude.
      const grained = toPixelArtGround(composed, {
        ...style,
        flattenRadius: 0,
        targetStdDev: undefined,
      });
      out.push({
        relPath: path.join(PACK_DIR, `${surface}-${i}.png`),
        bytes: encodePng(restoreBorder(grained, base, BORDER_MARGIN_PX)),
      });
    }
  }

  return out;
}

/** Apply base-dominant weights to both pools in the committed manifest. */
export function applyPoolWeights(manifest: Record<string, unknown>): Record<string, unknown> {
  const next = { ...manifest };
  for (const surface of SURFACES) {
    const key = `${surface}Pool`;
    const pool = next[key];
    if (!Array.isArray(pool)) throw new Error(`manifest is missing ${key}`);
    next[key] = pool.map((variant: Record<string, unknown>, index: number) => ({
      ...variant,
      weight: index === 0 ? BASE_WEIGHT : index === QUIET_INDEX ? QUIET_WEIGHT : DETAIL_WEIGHT,
    }));
  }
  // Rebuild provenance from its known keys rather than spreading the existing
  // object: `provenanceSchema` is `.strict()`, so any stray key that survives a
  // spread fails validation.
  const provenance = (next.provenance ?? {}) as Record<string, unknown>;
  next.provenance = {
    kind: 'authored',
    author: provenance.author ?? 'crawler-agent',
    derivationNote:
      'Wall autotile atlas, doors and the floor-0 / corridor-0 base tiles are Azure ' +
      'gpt-image-1 material generations composed locally over the blob47 silhouettes. ' +
      'Floor/corridor pools rebuilt 2026-07-27 as ONE shared base (floor-0 / corridor-0) ' +
      `plus an interior blended from REAL disjoint windows of the same generated ` +
      `material (blend strength ${MATERIAL_BLEND_STRENGTH}, border margin ` +
      `${BORDER_MARGIN_PX}px), cut into <surface>-variant-src.png by ` +
      'import-floor2-materials.ts. Interior detail is generated art, not procedural ' +
      'synthesis. Each window is normalized to the same target mean luminance, so ' +
      'variants differ in structure but cannot drift apart in tone. The blend ramps ' +
      'from zero at the border margin, so every variant shares byte-identical ' +
      'edges with the base and cross-variant seams equal the base self-seam by ' +
      `construction. Index ${QUIET_INDEX} is a quiet near-plain variant. Pools are ` +
      `weighted ${BASE_WEIGHT}:${QUIET_WEIGHT}:${DETAIL_WEIGHT} (base:quiet:detail) so ` +
      'ground reads as ground while still alternating between two calm tiles. The ' +
      'corridor base is contrast-normalized to damp its regular rivet motif. Fully ' +
      'reproducible: run scripts/sprites/terrain-packs/rebuild-shared-base-pools.ts.',
  };
  return next;
}

/**
 * Writes the restyled pools + re-weighted manifest to disk.
 *
 * MUST run after `writeIndustrialCavePack`, which regenerates `floor-*` /
 * `corridor-*` from scratch via `renderSpeckledSurface` and rewrites the
 * manifest without pool weights. Leaving this as a remembered second command
 * meant a plain `npm run terrain-packs:build` silently reverted the whole
 * restyle, so `cli.ts` now chains it.
 *
 * Idempotent: `toPixelArtGround` short-circuits on already-canonical art, so
 * repeated runs are hash-stable rather than a compounding contrast stretch.
 */
export function applySharedBasePoolRestyle(): number {
  // Ordered, not batched: `restyleWallAtlas` samples `floor-0` FROM DISK, so the
  // pool restyle has to land before it runs or the walls stamp the pre-restyle
  // material.
  const poolFiles = rebuildSharedBasePools();
  for (const file of poolFiles) fs.writeFileSync(file.relPath, file.bytes);

  const atlasFiles = restyleWallAtlas();
  for (const file of atlasFiles) fs.writeFileSync(file.relPath, file.bytes);

  // Accents retune and clip in one in-memory pass, so there is no window where
  // a crash commits retuned-but-spilling art. It reads the canonical silhouette
  // directly rather than the atlas on disk, so its position relative to the
  // atlas write does not matter.
  const accentFiles = processWallAccents();
  for (const file of accentFiles) fs.writeFileSync(file.relPath, file.bytes);

  const manifestRaw = fs.readFileSync(MANIFEST_PATH, 'utf8');
  const manifest = applyPoolWeights(JSON.parse(manifestRaw) as Record<string, unknown>);
  fs.writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  return poolFiles.length + atlasFiles.length + accentFiles.length;
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');

  if (dryRun) {
    // Must mirror `applySharedBasePoolRestyle` exactly, or the preview lies
    // about what a real run writes.
    const files = [...rebuildSharedBasePools(), ...restyleWallAtlas(), ...processWallAccents()];
    console.log(
      `[rebuild-shared-base-pools] DRY RUN — would write ${files.length} PNG(s) + manifest.`,
    );
    return;
  }

  const written = applySharedBasePoolRestyle();
  console.log(
    `[rebuild-shared-base-pools] wrote ${written} PNG(s) + re-weighted manifest ` +
      `(base ${BASE_WEIGHT} : detail ${DETAIL_WEIGHT}).`,
  );
}

const cliEntry = process.argv[1];
if (cliEntry && import.meta.url === pathToFileURL(cliEntry).href) {
  main();
}
