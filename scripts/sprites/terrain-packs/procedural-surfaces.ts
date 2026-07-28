/**
 * Deterministic procedural generators for the industrial-cave pack's
 * floor-pool, corridor-pool, and door images. All original geometric art
 * (no external assets), driven entirely by `SeededRandom` — never
 * `Math.random()` — so a rebuild from the same inputs is byte-identical.
 */
import { hashStringToSeed, SeededRandom } from '../../../src/shared/random.js';
import { TERRAIN_PACK_CELL_PX } from '../../../src/shared/terrain-pack-types.js';
import {
  createImage,
  fillRect,
  nearestNeighborResize,
  setPixel,
  type RgbaImage,
} from './png-buffer.js';

/** Base color + speckle color for one procedural surface variant. */
export interface SurfacePalette {
  readonly base: readonly [number, number, number, number];
  readonly speckle: readonly [number, number, number, number];
  readonly speckleDensity: number; // 0..1 probability per pixel
}

/**
 * Render one deterministic speckled-floor-style tile. `seed` should be a
 * stable per-variant integer (e.g. from `hashStringToSeed`) so the same
 * variant id always renders the same bytes.
 *
 * `gradientAxis`/`gradientStrength` (optional) overlay a linear luminance
 * gradient along the given axis on top of the speckle — used to deliberately
 * author a DIRECTIONALLY-UNSAFE placeholder variant (e.g. gravity-fed
 * grime pooling toward one edge) so the transform-eligibility deriver
 * (`scripts/sprites/terrain-packs/transform-eligibility.ts`) has a real,
 * non-synthetic case to restrict in the procedural placeholder pack, not
 * just in unit-test fixtures. Omit for a uniform (non-directional, safe to
 * flip on any axis) surface — the default for most variants.
 */
export function renderSpeckledSurface(
  seed: number,
  palette: SurfacePalette,
  gradient?: { readonly axis: 'vertical' | 'horizontal'; readonly strength: number },
): RgbaImage {
  const size = TERRAIN_PACK_CELL_PX;
  const img = createImage(size, size);
  const [br, bg, bb, ba] = palette.base;
  const [sr, sg, sb, sa] = palette.speckle;
  const rng = new SeededRandom(seed);

  // Decide, per pixel, base-vs-speckle FIRST (into a plain boolean grid) so
  // the optional gradient shading below is a single, uniform pass over every
  // pixel exactly once — no "was this already painted?" pixel-color sniffing
  // (which is unreliable once both layers can carry the same shade).
  const isSpeckle = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (rng.next() < palette.speckleDensity) {
        isSpeckle[y * size + x] = 1;
      }
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const speckle = isSpeckle[y * size + x] === 1;
      const [baseR, baseG, baseB, baseA] = speckle ? [sr, sg, sb, sa] : [br, bg, bb, ba];
      if (gradient) {
        const t = gradient.axis === 'vertical' ? y / (size - 1) : x / (size - 1);
        const shade = Math.round(gradient.strength * (t - 0.5) * 2);
        setPixel(
          img,
          x,
          y,
          clampByte(baseR + shade),
          clampByte(baseG + shade),
          clampByte(baseB + shade),
          baseA,
        );
      } else {
        setPixel(img, x, y, baseR, baseG, baseB, baseA);
      }
    }
  }
  return img;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, v));
}

export type DoorOrientation = 'horizontal' | 'vertical';

type Rgb = readonly [number, number, number];

/**
 * Quantized steel-bulkhead palette (Floor 2 industrial-cave: heavy powered
 * blast doors cut into rock). Chosen to sit in the SAME chunky-pixel-art world
 * as the restyled ground: body chroma stays <= 30 (cool neutral steel), only
 * the hazard marking is allowed a little saturation (chroma <= 45), luminance
 * lands in the ~23..142 band with ~14 discrete levels, and every value is used
 * as a flat fill (no per-pixel arithmetic shading) so the tile reads as
 * deliberate pixel art rather than a downsampled render.
 */
const DOOR_PALETTE = {
  jamb: [36, 38, 44], // s0 shadow steel (frame + recessed grooves)
  deep: [26, 27, 32], // rivet cores / deepest recess
  seam: [22, 23, 27], // the near-black centre seam / leaf gap
  leafDark: [44, 46, 52], // s1 leaf shadow / stacking seams
  panel: [52, 54, 62], // recessed panel field
  leaf: [56, 58, 66], // s2 leaf face
  lit: [88, 90, 98], // s3 bevel highlight / rail
  hi: [116, 118, 126], // s4 leading-edge specular
  rivetHi: [138, 140, 148], // rivet catch-light
  rust: [74, 58, 48], // wear streak (chroma 26)
  rustDark: [56, 44, 38], // deep wear (chroma 18)
  hazard: [112, 102, 72], // muted caution amber (chroma 40 <= 45)
  hazardDark: [66, 60, 42], // caution shadow band (chroma 24)
} satisfies Record<string, Rgb>;

/** The tile is authored on a 32px grid then nearest-neighbor upscaled x2 so
 *  every authored feature is at least 2px in the shipped 64px tile. */
const DOOR_LOGICAL_PX = 32;
const DOOR_JAMB_PX = 5; // jamb strip thickness on the logical grid
const DOOR_SEAM = 15; // first of the two centre-seam columns (15,16)

function paint(img: RgbaImage, x: number, y: number, c: Rgb): void {
  if (x < 0 || x >= img.width || y < 0 || y >= img.height) return;
  setPixel(img, x, y, c[0], c[1], c[2], 255);
}

function block(img: RgbaImage, x: number, y: number, w: number, h: number, c: Rgb): void {
  fillRect(img, x, y, w, h, c[0], c[1], c[2], 255);
}

/** Diagonally transpose a square image so a horizontal-passage layout becomes
 *  the exact vertical-passage transpose (a left/right centre seam becomes a
 *  top/bottom one, top/bottom jambs become left/right jambs). Deterministic. */
function transposeSquare(src: RgbaImage): RgbaImage {
  const n = src.width;
  const out = createImage(n, n);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const from = (y * n + x) * 4;
      const to = (x * n + y) * 4;
      out.data[to] = src.data[from]!;
      out.data[to + 1] = src.data[from + 1]!;
      out.data[to + 2] = src.data[from + 2]!;
      out.data[to + 3] = src.data[from + 3]!;
    }
  }
  return out;
}

/** A row of bolts/rivets: a dark core with a single catch-light pixel. */
function rivetRow(img: RgbaImage, y: number, xs: readonly number[]): void {
  for (const x of xs) {
    paint(img, x, y, DOOR_PALETTE.deep);
    paint(img, x + 1, y, DOOR_PALETTE.deep);
    paint(img, x, y - 1, DOOR_PALETTE.rivetHi);
  }
}

/** Recessed rectangular panel with a beveled frame: dark top/left (in shadow,
 *  since it is sunk in), lit bottom/right. */
function recessedPanel(img: RgbaImage, x0: number, y0: number, w: number, h: number): void {
  block(img, x0, y0, w, h, DOOR_PALETTE.panel);
  block(img, x0, y0, w, 1, DOOR_PALETTE.deep); // top edge (shadow)
  block(img, x0, y0, 1, h, DOOR_PALETTE.deep); // left edge (shadow)
  block(img, x0, y0 + h - 1, w, 1, DOOR_PALETTE.lit); // bottom edge (lit)
  block(img, x0 + w - 1, y0, 1, h, DOOR_PALETTE.lit); // right edge (lit)
}

/** Seeded rust/scuff wear near the floor of the door band. Deterministic. */
function addWear(
  img: RgbaImage,
  rng: SeededRandom,
  rows: readonly number[],
  xLo: number,
  xHi: number,
): void {
  const streaks = 5;
  for (let s = 0; s < streaks; s++) {
    const x = xLo + Math.floor(rng.next() * (xHi - xLo));
    const len = 1 + Math.floor(rng.next() * (rows.length - 1));
    for (let k = 0; k < len; k++) {
      const y = rows[rows.length - 1 - k]!;
      const c = rng.next() < 0.5 ? DOOR_PALETTE.rust : DOOR_PALETTE.rustDark;
      paint(img, x, y, c);
      if (rng.next() < 0.4) paint(img, x + 1, y, DOOR_PALETTE.rustDark);
    }
  }
}

/** Central wheel-lock focal point straddling the seam (reads as "sealed"). */
function wheelLock(img: RgbaImage, cx: number, cy: number, r: number): void {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) continue;
      if (d > r - 1.4) {
        // outer rim, lit toward the top-left
        paint(img, x, y, dx + dy < 0 ? DOOR_PALETTE.hi : DOOR_PALETTE.lit);
      } else if (d > r - 2.6) {
        paint(img, x, y, DOOR_PALETTE.deep); // groove between rim and hub
      } else {
        paint(img, x, y, DOOR_PALETTE.leaf); // hub
      }
    }
  }
  // four spokes + centre bolt
  for (let k = -r + 1; k <= r - 1; k++) {
    paint(img, cx + k, cy, DOOR_PALETTE.deep);
    paint(img, cx, cy + k, DOOR_PALETTE.deep);
  }
  paint(img, cx, cy, DOOR_PALETTE.rivetHi);
}

/** Closed blast door in the horizontal-passage layout (jambs top+bottom, two
 *  leaves meeting at a vertical centre seam). 32x32 logical. */
function renderClosedDoorHorizontal(rng: SeededRandom): RgbaImage {
  const S = DOOR_LOGICAL_PX;
  const J = DOOR_JAMB_PX;
  const img = createImage(S, S);
  const bandTop = J;
  const bandH = S - 2 * J;

  // Two leaves fill the band; seam columns 15,16 split them.
  block(img, 0, bandTop, DOOR_SEAM, bandH, DOOR_PALETTE.leaf); // left leaf
  block(img, DOOR_SEAM + 2, bandTop, S - (DOOR_SEAM + 2), bandH, DOOR_PALETTE.leaf); // right leaf
  block(img, DOOR_SEAM, bandTop, 2, bandH, DOOR_PALETTE.seam); // centre seam
  block(img, DOOR_SEAM - 1, bandTop, 1, bandH, DOOR_PALETTE.hi); // left leaf lit edge
  block(img, DOOR_SEAM + 2, bandTop, 1, bandH, DOOR_PALETTE.lit); // right leaf edge

  // Recessed leaf panels (leave the central seam + wheel clear).
  recessedPanel(img, 2, 10, 9, 12);
  recessedPanel(img, S - 11, 10, 9, 12);

  // Jambs (top/bottom), each with an inner lit lip and a bolt row.
  block(img, 0, 0, S, J, DOOR_PALETTE.jamb);
  block(img, 0, S - J, S, J, DOOR_PALETTE.jamb);
  block(img, 0, J - 1, S, 1, DOOR_PALETTE.lit); // top jamb inner lip
  block(img, 0, S - J, S, 1, DOOR_PALETTE.lit); // bottom jamb inner lip
  const boltXs = [3, 9, 15, 21, 27];
  rivetRow(img, 2, boltXs);
  rivetRow(img, S - 3, boltXs);

  // Hazard chevron band just under the top jamb (the one saturation accent).
  for (let y = J + 1; y <= J + 3; y++) {
    for (let x = 0; x < S; x++) {
      const on = (x + (y - (J + 1))) % 6 < 3;
      paint(img, x, y, on ? DOOR_PALETTE.hazard : DOOR_PALETTE.hazardDark);
    }
  }

  // Bolt rows along the leaf tops/bottoms.
  rivetRow(img, J + 5, [3, 11, 20, 28]);
  rivetRow(img, S - J - 2, [3, 11, 20, 28]);

  // Central wheel-lock focal point.
  wheelLock(img, 16, 15, 5);

  // Rust/scuff wear near the bottom of the leaves.
  addWear(img, rng, [S - J - 4, S - J - 3, S - J - 2, S - J - 1], 2, S - 2);
  return img;
}

/** Retracted door leaf viewed edge-on, parked against one side of the passage.
 *  `side` = 'left' puts the leaf's lit leading face on its right (toward the
 *  open centre); 'right' mirrors it. 32x32 logical layout. */
function retractedLeaf(img: RgbaImage, side: 'left' | 'right', y0: number, h: number): void {
  const S = DOOR_LOGICAL_PX;
  const w = 8;
  const x0 = side === 'left' ? 0 : S - w;
  block(img, x0, y0, w, h, DOOR_PALETTE.leaf); // leaf body (edge-on slab)
  const outer = side === 'left' ? x0 : x0 + w - 1;
  block(img, outer, y0, 1, h, DOOR_PALETTE.jamb); // outer edge against the wall (shadow)

  // Leading face toward the open passage: lit column, specular edge, then the
  // dark gap the two leaves parted from.
  if (side === 'left') {
    block(img, x0 + w - 2, y0, 1, h, DOOR_PALETTE.lit);
    block(img, x0 + w - 1, y0, 1, h, DOOR_PALETTE.hi);
  } else {
    block(img, x0 + 1, y0, 1, h, DOOR_PALETTE.lit);
    block(img, x0, y0, 1, h, DOOR_PALETTE.hi);
  }

  // Horizontal stacking seams so it reads as a thick paneled leaf, not a bar.
  for (let y = y0 + 3; y < y0 + h; y += 4) {
    block(img, x0, y, w, 1, DOOR_PALETTE.leafDark);
  }
  // A shallow recessed panel down the middle of the leaf face.
  const panelX = side === 'left' ? x0 + 2 : x0 + w - 5;
  block(img, panelX, y0 + 2, 3, h - 4, DOOR_PALETTE.panel);
  block(img, panelX, y0 + 2, 3, 1, DOOR_PALETTE.deep);
  block(img, panelX, y0 + h - 3, 3, 1, DOOR_PALETTE.lit);
  // A column of bolts down the leaf.
  const bx = side === 'left' ? 2 : S - 3;
  for (let y = y0 + 1; y < y0 + h; y += 4) {
    paint(img, bx, y, DOOR_PALETTE.deep);
    paint(img, bx, y - 1, DOOR_PALETTE.rivetHi);
  }
}

/** Open blast door in the horizontal-passage layout: the two leaves are
 *  retracted to the left/right sides on top+bottom guide rails, leaving the
 *  centre transparent so the floor renders through. 32x32 logical. */
function renderOpenDoorHorizontal(rng: SeededRandom): RgbaImage {
  const S = DOOR_LOGICAL_PX;
  const J = DOOR_JAMB_PX;
  const img = createImage(S, S); // starts fully transparent

  // Jambs (top/bottom) with bolt rows and an inner lit lip — same frame as closed.
  block(img, 0, 0, S, J, DOOR_PALETTE.jamb);
  block(img, 0, S - J, S, J, DOOR_PALETTE.jamb);
  const boltXs = [3, 9, 15, 21, 27];
  rivetRow(img, 2, boltXs);
  rivetRow(img, S - 3, boltXs);

  // Guide rails just inside each jamb: a dark channel with a bright rail line
  // that the leaves slide along. These sit at the passage edges, so the open
  // centre stays clear.
  block(img, 0, J, S, 1, DOOR_PALETTE.deep);
  block(img, 0, J + 1, S, 1, DOOR_PALETTE.lit);
  block(img, 0, S - J - 2, S, 1, DOOR_PALETTE.lit);
  block(img, 0, S - J - 1, S, 1, DOOR_PALETTE.deep);

  // Retracted leaves parked left and right between the rails.
  const leafTop = J + 2;
  const leafH = S - 2 * (J + 2);
  retractedLeaf(img, 'left', leafTop, leafH);
  retractedLeaf(img, 'right', leafTop, leafH);
  // Dark parted-gap columns just inside each retracted leaf's lit face.
  block(img, 8, leafTop, 1, leafH, DOOR_PALETTE.seam);
  block(img, S - 9, leafTop, 1, leafH, DOOR_PALETTE.seam);

  // Wear on the retracted leaves near the bottom rail.
  addWear(img, rng, [S - J - 4, S - J - 3], 1, 7);
  addWear(img, rng, [S - J - 4, S - J - 3], S - 8, S - 1);
  return img;
}

/**
 * Render one deterministic 64x64 door tile as real, chunky pixel-art machinery:
 * a heavy powered steel bulkhead. Closed doors show two leaves meeting at a
 * central seam with a wheel-lock, hazard chevrons, bolt rows and floor rust;
 * open doors show the two leaves retracted onto guide rails with the passage
 * centre left transparent so the floor renders through. Orientation
 * 'horizontal' means the passage runs left-right (jambs top/bottom); 'vertical'
 * is its exact transpose. Fully deterministic (seeded, no Math.random /
 * Date.now), binary alpha, authored on a 2px grid.
 */
export function renderDoorTile(isOpen: boolean, orientation: DoorOrientation): RgbaImage {
  const rng = new SeededRandom(
    hashStringToSeed(`industrial-cave-door-${isOpen ? 'open' : 'closed'}`),
  );
  const authored = isOpen ? renderOpenDoorHorizontal(rng) : renderClosedDoorHorizontal(rng);
  const oriented = orientation === 'vertical' ? transposeSquare(authored) : authored;
  return nearestNeighborResize(oriented, TERRAIN_PACK_CELL_PX, TERRAIN_PACK_CELL_PX);
}
