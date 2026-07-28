/**
 * CLI: build the Floor 2 INDUSTRIAL LINEWORK atlases from generated materials.
 *
 * Writes into the industrial-cave pack directory:
 *   linework-track.png   16 edge-Wang frames of mine-cart track (1024x64)
 *   linework-pipe.png    16 edge-Wang frames of pipe run        (1024x64)
 *   linework-props.png   4 keyed prop frames                    (256x64)
 *
 * WHY THIS IS A SEPARATE SCRIPT FROM `import-floor2-materials.ts`. That script
 * requires EVERY cached ground/wall material to be present and rewrites the pool
 * bases as one atomic act; a half run leaves the pack inconsistent. Linework is
 * additive and shares none of those inputs, so bolting it on would make a cheap
 * art iteration depend on re-fetching the expensive ground materials. Keeping it
 * standalone means `npx tsx scripts/sprites/terrain-packs/import-floor2-linework.ts`
 * is safe to re-run on a clean checkout that has an Azure key and nothing cached.
 *
 * Division of labour (the session's governing law): Azure supplies the three
 * surface materials and the prop sheet; every silhouette, every join, all the
 * lighting and the binary-alpha enforcement are local and deterministic.
 */
import fs from 'node:fs';
import path from 'node:path';
import { decodePng, encodePng, type RgbaImage } from './png-buffer.js';
import {
  restylePixelArtMaterial,
  toMaterialTile,
  type PixelArtMaterialStyle,
} from './gen/image-ops.js';
import { generateMaterial, loadEnvLocal } from './gen/azure-image.js';
import {
  FLOOR2_LINEWORK_MATERIALS,
  FLOOR2_LINEWORK_PROPS,
  type SurfaceMaterialSpec,
} from './gen/materials.js';
import {
  LINEWORK_CELL_PX,
  LINEWORK_PIXEL,
  PIPE_PROFILE,
  TRACK_PROFILE,
  isEndCapMask,
  rasterizeLineworkFrame,
  stubSpan,
  type LineworkProfile,
} from './gen/linework-geometry.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const PACK_DIR = path.join(REPO_ROOT, 'public', 'assets', 'terrain-packs', 'industrial-cave');

const FRAME_COUNT = 16;
const PROP_FRAME_COUNT = 4;

/** Prop sheet quadrants; the generated sheet is a 2x2 grid. */
const PROP_GRID = 2;

async function material(spec: SurfaceMaterialSpec): Promise<RgbaImage> {
  const generated = await generateMaterial({
    repoRoot: REPO_ROOT,
    cacheKey: spec.cacheKey,
    prompt: spec.prompt,
  });
  console.log(`  ${spec.cacheKey} ${generated.fromCache ? '(cache)' : '(azure)'}`);
  return decodePng(generated.png);
}

/**
 * Collapse a material tile into uniform NxN blocks.
 *
 * Sampling a 1024px generated material at 1:1 into a 64px cell keeps the
 * model's photographic micro-grain, and at play scale that grain reads as noise
 * — it fights the shading bands and makes the metal look photographed rather
 * than drawn. Quantising the texture to 2px blocks gives the surface a visible
 * pixel size that matches the rest of the pack, so the eye reads "pixel art
 * metal" instead of "downsampled photo of metal".
 */
const TEXTURE_BLOCK_PX = 2;

/** Fraction of the generated texture's local contrast kept under the bands. */
const TEXTURE_KEEP = 0.34;

/**
 * Pull every pixel toward the tile's mean colour, keeping `keep` of its
 * deviation.
 *
 * The shading bands are multiplicative gains of roughly 0.15 each, which on a
 * 74-luminance body is a step of ~11. Raw generated metal carries far more
 * local contrast than that, so at full strength the texture noise swamps the
 * bands and the pipe reads as a flat noisy stripe rather than a cylinder.
 * Flattening first lets the bands be the dominant signal — the texture then
 * survives as surface grain on top of a legible round form, which is exactly
 * the division of labour we want (Azure supplies texture, geometry supplies
 * form).
 */
function flatten(tile: RgbaImage, keep: number): RgbaImage {
  const px = tile.width * tile.height;
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < px; i++) {
    sr += tile.data[i * 4] ?? 0;
    sg += tile.data[i * 4 + 1] ?? 0;
    sb += tile.data[i * 4 + 2] ?? 0;
  }
  const mr = sr / px;
  const mg = sg / px;
  const mb = sb / px;
  const out: RgbaImage = {
    width: tile.width,
    height: tile.height,
    data: Buffer.alloc(tile.data.length),
  };
  for (let i = 0; i < px; i++) {
    out.data[i * 4] = clamp8(mr + ((tile.data[i * 4] ?? 0) - mr) * keep);
    out.data[i * 4 + 1] = clamp8(mg + ((tile.data[i * 4 + 1] ?? 0) - mg) * keep);
    out.data[i * 4 + 2] = clamp8(mb + ((tile.data[i * 4 + 2] ?? 0) - mb) * keep);
    out.data[i * 4 + 3] = 255;
  }
  return out;
}

function chunkify(tile: RgbaImage, blockPx: number): RgbaImage {
  const out: RgbaImage = {
    width: tile.width,
    height: tile.height,
    data: Buffer.alloc(tile.data.length),
  };
  for (let y = 0; y < tile.height; y++) {
    const by = Math.floor(y / blockPx) * blockPx;
    for (let x = 0; x < tile.width; x++) {
      const bx = Math.floor(x / blockPx) * blockPx;
      tile.data.copy(
        out.data,
        (y * tile.width + x) * 4,
        (by * tile.width + bx) * 4,
        (by * tile.width + bx) * 4 + 4,
      );
    }
  }
  return out;
}

/**
 * Sample a seamless 64px material tile at an atlas coordinate, offset per frame.
 *
 * Without the per-frame offset every frame would sample the SAME 64x64 window
 * (the atlas is only one cell tall), so all 16 frames would carry byte-identical
 * weathering and a long run would read as one motif stamped over and over — the
 * exact repetition complaint that drove the Floor 2 rework. The offset is a
 * fixed function of the frame index, and a multiple of the texture block size so
 * it never cuts a block in half.
 *
 * The outermost `EDGE_LOCK_PX` ring of every cell is exempt, because that ring
 * is exactly what the Wang stub contract compares. Locking it to offset zero is
 * NOT enough: a tile's north row abuts its neighbour's SOUTH row, so those two
 * rows must agree, and at offset zero they sample material rows 0 and 63 —
 * different pixels. The ring therefore samples a canonical strip indexed by
 * (distance along the edge, depth into the cell), which is identical for a row
 * and the opposite row, and for a column and the opposite column. Corner pixels
 * belong to two edges at once, so they resolve their along-coordinate from the
 * vertical edge; that choice is symmetric under both reflections, so all four
 * corners agree too.
 */
const EDGE_LOCK_PX = 2;

function sampleTile(
  tile: RgbaImage,
  frame: number,
  x: number,
  y: number,
): [number, number, number] {
  const far = LINEWORK_CELL_PX - EDGE_LOCK_PX;
  const inVerticalBand = x < EDGE_LOCK_PX || x >= far;
  const inHorizontalBand = y < EDGE_LOCK_PX || y >= far;
  let sx: number;
  let sy: number;
  if (inVerticalBand || inHorizontalBand) {
    const depth = Math.min(x, y, LINEWORK_CELL_PX - 1 - x, LINEWORK_CELL_PX - 1 - y);
    const along = inVerticalBand ? y : x;
    sx = along % tile.width;
    sy = depth % tile.height;
  } else {
    sx = (x + frame * 38) % tile.width;
    sy = (y + frame * 24) % tile.height;
  }
  const i = (sy * tile.width + sx) * 4;
  return [tile.data[i] as number, tile.data[i + 1] as number, tile.data[i + 2] as number];
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Local lighting for one classified frame.
 *
 * Two things have to be true at once. Flat top-down art needs relief or a pipe
 * reads as an 18px stripe of texture — the first thing the human called out.
 * But the relief must not read as a smooth 3D render either: this pack is
 * stepped pixel art, and a continuous cylinder gradient is exactly the
 * "downsampled photograph" look the judge has rejected before.
 *
 * So the cross-section ramp is QUANTISED INTO A FEW HARD BANDS, hand-shaded
 * style: a bright crown band offset off-centre, one or two mid tones, and a dark
 * band on the far edge, with a dark rim on the silhouette. Bands, not gradients,
 * are what make it read as drawn rather than rendered. The final atlas then goes
 * through the pack's own `restylePixelArtMaterial`, which is the same value
 * stepping and chroma compression every other Floor 2 surface already gets — so
 * linework lands in the pack's palette instead of beside it.
 *
 * The bands are indexed by the cross-section coordinate the rasteriser hands
 * out, so both sides of a join always land in the same band and a run stays
 * continuous in tone as well as in silhouette.
 */
const RIM_SCALE = 0.55;

/**
 * Stepped cylinder, authored as non-uniform bands.
 *
 * Two things make a small pipe read as round rather than as a flat stripe:
 *
 * 1. **The specular must sit near the lit edge, not past the middle.** An
 *    earlier uniform 5-band split put the crown at ~70% across, which on a
 *    horizontal run is *below* centre — the eye reads that as a flat plate with
 *    a stray light line rather than a tube. `t` is therefore taken as
 *    `(1 - shade) / 2` so band 0 is the up/left edge.
 * 2. **The bands must not be equal width.** A real cylinder has a narrow
 *    specular and a wide body; equal fifths give five stripes of identical
 *    weight, which is exactly the "flat" read the human called out. The stops
 *    below are a thin rim, a thin crown, two wide body bands, then a thin
 *    shadow and a dark far rim.
 *
 * Widths are chosen so that at the shipped 18px bore each band survives the
 * on-screen downscale as at least one pixel.
 */
const PIPE_STOPS = [
  { t: 0.1, gain: 0.32 },
  { t: 0.3, gain: 1.55 },
  { t: 0.53, gain: 1.16 },
  { t: 0.76, gain: 0.88 },
  { t: 0.9, gain: 0.62 },
  { t: Number.POSITIVE_INFINITY, gain: 0.34 },
] as const;
/** Rail head: bright running surface, dark web at the outside. */
const RAIL_BANDS = [1.12, 0.94, 0.66] as const;
/** Cross-members sit lower than the body, with a slight crown of their own. */
const TIE_BANDS = [0.86, 1.14, 0.9] as const;

function bandGain(bands: readonly number[], shade: number): number {
  // shade is in [-1, 1]; map to a band index without ever landing out of range.
  const t = (shade + 1) / 2;
  const i = Math.min(bands.length - 1, Math.max(0, Math.floor(t * bands.length)));
  return bands[i] as number;
}

/** Non-uniform band lookup. `shade` in [-1, 1]; band 0 is the up/left edge. */
function stopGain(stops: readonly { t: number; gain: number }[], shade: number): number {
  const t = (1 - shade) / 2;
  for (const stop of stops) if (t < stop.t) return stop.gain;
  return stops[stops.length - 1]?.gain ?? 1;
}

function memberGain(cls: number, shade: number, round: boolean): number {
  if (cls === LINEWORK_PIXEL.Rail) {
    return round ? stopGain(PIPE_STOPS, shade) : bandGain(RAIL_BANDS, Math.abs(shade) * 2 - 1);
  }
  if (cls === LINEWORK_PIXEL.Tie) return bandGain(TIE_BANDS, shade);
  return bandGain(TIE_BANDS, shade) * 1.12;
}

/**
 * Pixel-art restyle applied to the finished atlas.
 *
 * Deliberately DARKER than it wants to be. Floor 2's walls sit near 62 mean
 * luminance and its floors near 74; a first pass at 96 produced rails and pipes
 * that read as polished aluminium lying on a dark cave, which is both wrong for
 * rusted mine hardware and loud enough to pull the eye off the gameplay layer.
 * Sitting just above floor tone keeps the linework legible as structure without
 * making it the brightest thing on screen. Chroma is clamped hard for the same
 * reason the pools are: saturated metal is what makes an industrial tileset look
 * like a factory-builder rather than a dungeon crawler.
 */
const LINEWORK_PIXEL_STYLE: PixelArtMaterialStyle = {
  targetMeanLuminance: 74,
  maxLuminance: 148,
  targetStdDev: 24,
  valueStep: 8,
  maxChroma: 18,
};

/**
 * Props get a harder chroma clamp than the linework atlases.
 *
 * They are cut out of a magenta field, so whatever fringe survives the erode is
 * still the most saturated thing in the frame; normalising the sheet with the
 * ordinary clamp leaves a lavender cast on the light metal. Squeezing chroma
 * further costs nothing here — everything in the mine is rust, iron and timber.
 */
const PROP_PIXEL_STYLE: PixelArtMaterialStyle = {
  ...LINEWORK_PIXEL_STYLE,
  maxChroma: 6,
};

function isRim(cls: Uint8Array, size: number, x: number, y: number): boolean {
  const neighbours = [
    [x, y - 1],
    [x + 1, y],
    [x, y + 1],
    [x - 1, y],
  ] as const;
  for (const [nx, ny] of neighbours) {
    // Out of bounds counts as SOLID, not empty: a run continues into the next
    // tile, so rimming the cell border would draw a dark seam across every join.
    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
    if (cls[ny * size + nx] === LINEWORK_PIXEL.Empty) return true;
  }
  return false;
}

function buildAtlas(
  profile: LineworkProfile,
  bodyTile: RgbaImage,
  tieTile: RgbaImage,
  /** True when the body is a single round tube rather than paired rail heads. */
  round: boolean,
): RgbaImage {
  const size = LINEWORK_CELL_PX;
  const width = size * FRAME_COUNT;
  const out: RgbaImage = { width, height: size, data: Buffer.alloc(width * size * 4) };
  for (let frame = 0; frame < FRAME_COUNT; frame++) {
    const { cls, shade } = rasterizeLineworkFrame(frame, profile, isEndCapMask(frame));
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const c = cls[y * size + x] as number;
        const o = (y * width + frame * size + x) * 4;
        if (c === LINEWORK_PIXEL.Empty) continue;
        const src = c === LINEWORK_PIXEL.Tie ? tieTile : bodyTile;
        const [r, g, b] = sampleTile(src, frame, x, y);
        const gain =
          memberGain(c, shade[y * size + x] as number, round) *
          (isRim(cls, size, x, y) ? RIM_SCALE : 1);
        out.data[o] = clamp8(r * gain);
        out.data[o + 1] = clamp8(g * gain);
        out.data[o + 2] = clamp8(b * gain);
        // Binary alpha, pack-wide rule. All gradation lives in the RGB.
        out.data[o + 3] = 255;
      }
    }
  }
  return restylePixelArtMaterial(out, LINEWORK_PIXEL_STYLE);
}

/**
 * Colour distance used by the background flood.
 *
 * Generous on purpose: the generated "flat" magenta field is never actually
 * flat — it carries the model's own shading, so a fixed hue predicate keys the
 * bright centre of the field and leaves a dark magenta halo hugging every
 * object. A flood constrained to pixels reachable FROM THE BORDER can afford a
 * loose threshold, because an object pixel that happens to fall inside it is
 * still protected as long as the object's outline is not itself background
 * coloured.
 */
const PROP_KEY_TOLERANCE = 110;

/** Pixels of antialiased key-colour fringe removed from every prop silhouette. */
const PROP_ERODE_PX = 3;

/** Shrink a binary mask in place by `radius` 4-connected steps. */
function eroded(mask: Uint8Array, w: number, h: number, radius: number): void {
  for (let step = 0; step < radius; step++) {
    const prev = mask.slice();
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!prev[y * w + x]) continue;
        const open =
          x === 0 ||
          y === 0 ||
          x === w - 1 ||
          y === h - 1 ||
          !prev[(y - 1) * w + x] ||
          !prev[(y + 1) * w + x] ||
          !prev[y * w + x - 1] ||
          !prev[y * w + x + 1];
        if (open) mask[y * w + x] = 0;
      }
    }
  }
}

function colourDistance(
  r: number,
  g: number,
  b: number,
  kr: number,
  kg: number,
  kb: number,
): number {
  return Math.hypot(r - kr, g - kg, b - kb);
}

/**
 * Cut the 2x2 generated prop sheet into four keyed 64px frames.
 *
 * Chroma keying is DERIVATION, not synthesis: the object's silhouette and its
 * surface both come from the generated image, local code only decides which
 * pixels are background. That is the same class of operation as the crack-mask
 * isolation the ground decals already use, so it stays on the correct side of
 * the generated-art boundary.
 *
 * The background is found by flooding inward from the quadrant border rather
 * than by testing every pixel against a hue rule. Flooding also closes the
 * object automatically: a magenta-ish pixel enclosed by the object (inside a
 * cart, between the spokes of a valve wheel) is never reached from the border,
 * so it stays opaque instead of punching a hole through the sprite.
 */
function buildPropAtlas(sheet: RgbaImage): RgbaImage {
  const size = LINEWORK_CELL_PX;
  const width = size * PROP_FRAME_COUNT;
  const out: RgbaImage = { width, height: size, data: Buffer.alloc(width * size * 4) };
  const qw = Math.floor(sheet.width / PROP_GRID);
  const qh = Math.floor(sheet.height / PROP_GRID);

  for (let frame = 0; frame < PROP_FRAME_COUNT; frame++) {
    const qx = (frame % PROP_GRID) * qw;
    const qy = Math.floor(frame / PROP_GRID) * qh;
    const at = (x: number, y: number): number => ((qy + y) * sheet.width + qx + x) * 4;

    // Key colour = mean of the quadrant's outermost ring, which is background
    // everywhere by construction (the prompt demands a wide margin).
    let kr = 0;
    let kg = 0;
    let kb = 0;
    let ringCount = 0;
    for (let x = 0; x < qw; x++) {
      for (const y of [0, qh - 1]) {
        const i = at(x, y);
        kr += sheet.data[i] as number;
        kg += sheet.data[i + 1] as number;
        kb += sheet.data[i + 2] as number;
        ringCount++;
      }
    }
    kr /= ringCount;
    kg /= ringCount;
    kb /= ringCount;

    // Flood the background inward from the border.
    const background = new Uint8Array(qw * qh);
    const stack: number[] = [];
    const push = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= qw || y >= qh) return;
      const idx = y * qw + x;
      if (background[idx]) return;
      const i = at(x, y);
      const d = colourDistance(
        sheet.data[i] as number,
        sheet.data[i + 1] as number,
        sheet.data[i + 2] as number,
        kr,
        kg,
        kb,
      );
      if (d > PROP_KEY_TOLERANCE) return;
      background[idx] = 1;
      stack.push(idx);
    };
    for (let x = 0; x < qw; x++) {
      push(x, 0);
      push(x, qh - 1);
    }
    for (let y = 0; y < qh; y++) {
      push(0, y);
      push(qw - 1, y);
    }
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % qw;
      const y = (idx - x) / qw;
      push(x, y - 1);
      push(x + 1, y);
      push(x, y + 1);
      push(x - 1, y);
    }

    const mask = new Uint8Array(qw * qh);
    let minX = qw;
    let minY = qh;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < qh; y++) {
      for (let x = 0; x < qw; x++) {
        if (background[y * qw + x]) continue;
        mask[y * qw + x] = 1;
      }
    }
    // Erode the object by a couple of pixels. The generator antialiases every
    // object against the magenta field, so the outermost ring of "object" pixels
    // is really a magenta blend — leave it in and the sprite keeps a pink halo
    // and, after chroma normalisation, a lavender cast on anything light.
    eroded(mask, qw, qh, PROP_ERODE_PX);
    for (let y = 0; y < qh; y++) {
      for (let x = 0; x < qw; x++) {
        if (!mask[y * qw + x]) continue;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) {
      throw new Error(
        `Prop quadrant ${frame} keyed to nothing — the generated sheet has no object on a flat field.`,
      );
    }

    // Square the bounding box so the downscale does not distort the object.
    const side = Math.max(maxX - minX + 1, maxY - minY + 1);
    const cx = Math.floor((minX + maxX) / 2);
    const cy = Math.floor((minY + maxY) / 2);
    const x0 = cx - Math.floor(side / 2);
    const y0 = cy - Math.floor(side / 2);
    const step = side / size;

    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // Box filter over the source block: average only the covered pixels, and
        // threshold coverage so alpha stays binary.
        const sx0 = x0 + Math.floor(x * step);
        const sy0 = y0 + Math.floor(y * step);
        const sx1 = x0 + Math.floor((x + 1) * step);
        const sy1 = y0 + Math.floor((y + 1) * step);
        let r = 0;
        let g = 0;
        let b = 0;
        let covered = 0;
        let total = 0;
        for (let sy = sy0; sy < Math.max(sy1, sy0 + 1); sy++) {
          for (let sx = sx0; sx < Math.max(sx1, sx0 + 1); sx++) {
            total++;
            if (sx < 0 || sy < 0 || sx >= qw || sy >= qh) continue;
            if (!mask[sy * qw + sx]) continue;
            const i = ((qy + sy) * sheet.width + qx + sx) * 4;
            r += sheet.data[i] as number;
            g += sheet.data[i + 1] as number;
            b += sheet.data[i + 2] as number;
            covered++;
          }
        }
        if (covered * 2 < total || covered === 0) continue;
        const o = (y * width + frame * size + x) * 4;
        out.data[o] = clamp8(r / covered);
        out.data[o + 1] = clamp8(g / covered);
        out.data[o + 2] = clamp8(b / covered);
        out.data[o + 3] = 255;
      }
    }
  }
  return out;
}

function write(relName: string, image: RgbaImage): void {
  fs.writeFileSync(path.join(PACK_DIR, relName), encodePng(image));
  console.log(`  wrote ${relName} (${image.width}x${image.height})`);
}

async function main(): Promise<void> {
  loadEnvLocal(REPO_ROOT);
  fs.mkdirSync(PACK_DIR, { recursive: true });
  console.log('Floor 2 linework: materials');
  const steelRaw = await material(FLOOR2_LINEWORK_MATERIALS.steel);
  const timberRaw = await material(FLOOR2_LINEWORK_MATERIALS.timber);
  const ironRaw = await material(FLOOR2_LINEWORK_MATERIALS.iron);
  const propsRaw = await material(FLOOR2_LINEWORK_PROPS);

  const steel = chunkify(
    flatten(toMaterialTile(steelRaw, FLOOR2_LINEWORK_MATERIALS.steel.tile), TEXTURE_KEEP),
    TEXTURE_BLOCK_PX,
  );
  const timber = chunkify(
    flatten(toMaterialTile(timberRaw, FLOOR2_LINEWORK_MATERIALS.timber.tile), TEXTURE_KEEP),
    TEXTURE_BLOCK_PX,
  );
  const iron = chunkify(
    flatten(toMaterialTile(ironRaw, FLOOR2_LINEWORK_MATERIALS.iron.tile), TEXTURE_KEEP),
    TEXTURE_BLOCK_PX,
  );

  console.log('Floor 2 linework: atlases');
  write('linework-track.png', buildAtlas(TRACK_PROFILE, steel, timber, false));
  write('linework-pipe.png', buildAtlas(PIPE_PROFILE, iron, iron, true));
  write('linework-props.png', restylePixelArtMaterial(buildPropAtlas(propsRaw), PROP_PIXEL_STYLE));

  console.log(
    `  track stub ${JSON.stringify(stubSpan(TRACK_PROFILE))}  pipe stub ${JSON.stringify(
      stubSpan(PIPE_PROFILE),
    )}`,
  );
}

await main();
