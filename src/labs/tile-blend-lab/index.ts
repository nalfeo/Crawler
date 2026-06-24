/**
 * Tile Blend Lab — investigates smooth transitions between background tile types.
 *
 * Problem: adjacent terrain types produce a hard, abrupt visual seam.
 * This lab demonstrates three techniques for softening those edges:
 *
 *   1. Hard Edge (baseline)    — raw tile draw, no blending.
 *   2. Gradient Blend          — linear-gradient alpha overlay from the
 *                                neighbour's colour bleeds across the seam.
 *   3. Ordered Dither          — Bayer 4×4 matrix selects neighbour pixels at
 *                                the seam, giving a pixel-art-friendly pattern.
 *
 * All techniques operate on the colour-fallback palette (terrain-colors.ts)
 * AND on spritesheet frames when the sheets are loaded.  For sprite tiles the
 * gradient and dither overlays composite over the pixel-art frame, which is
 * the same approach Phaser's RenderTexture pipeline would use.
 *
 * Phaser mapping notes (how to port to terrain-renderer.ts):
 * ─────────────────────────────────────────────────────────
 * • Gradient: after baking all base tiles, do a second rt.stamp() pass with
 *   semi-transparent gradient textures along every seam edge.
 * • Dither: bake the dither pattern as a pre-generated "blend strip" texture
 *   then rt.stamp() it at each seam with tint set to the neighbour colour.
 *
 * Controls:
 *   Terrain A / B  — choose which two terrains meet at the vertical seam.
 *   Blend Mode     — switch between the three techniques.
 *   Blend Width    — how many pixels the transition covers.
 *   Cell Size      — zoom level (px per tile).
 *   Show Grid      — draw tile boundaries.
 */

import GUI from 'lil-gui';
import { TerrainType } from '../../shared/map-types.js';
import { TERRAIN_FALLBACK_COLORS, colorToCss } from '../../shared/terrain-colors.js';
import { SHEETS } from '../../engine/sprites/index.js';
import {
  TILE_SPRITES,
  type TileVisualDef,
  resolveFrame,
} from '../../engine/sprites/tile-visuals.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

const LAB_ID = 'tile-blend-lab';

// ── Bayer 4×4 ordered-dither matrix (0–15) ──────────────────────────────────
const BAYER4: readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

type BlendMode = 'hard' | 'gradient' | 'dither';

interface TileBlendSettings {
  terrainA: number;
  terrainB: number;
  blendMode: BlendMode;
  blendWidth: number;
  cellSize: number;
  showGrid: boolean;
  mapWidth: number;
  mapHeight: number;
}

// ── Utility ──────────────────────────────────────────────────────────────────

function hexToRGB(color: number): [number, number, number] {
  return [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff];
}

interface SheetImage {
  img: HTMLImageElement;
  loaded: boolean;
  error: boolean;
  frameWidth: number;
  frameHeight: number;
  spacing: number;
  cols: number;
}

function loadSheetImages(): Map<string, SheetImage> {
  const map = new Map<string, SheetImage>();
  for (const sheet of SHEETS) {
    const entry: SheetImage = {
      img: new Image(),
      loaded: false,
      error: false,
      frameWidth: sheet.frameWidth,
      frameHeight: sheet.frameHeight,
      spacing: sheet.spacing,
      cols: sheet.cols,
    };
    entry.img.addEventListener('load', () => {
      entry.loaded = true;
    });
    entry.img.addEventListener('error', () => {
      entry.error = true;
    });
    entry.img.src = sheet.path;
    map.set(sheet.key, entry);
  }
  return map;
}

/** Build a flat Uint8Array terrain map: left half = terrainA, right half = terrainB. */
function buildSplitTerrain(
  width: number,
  height: number,
  terrainA: TerrainType,
  terrainB: TerrainType,
): Uint8Array {
  const terrain = new Uint8Array(width * height);
  const split = Math.floor(width / 2);
  for (let ty = 0; ty < height; ty++) {
    for (let tx = 0; tx < width; tx++) {
      terrain[ty * width + tx] = tx < split ? terrainA : terrainB;
    }
  }
  return terrain;
}

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

// ── Lab ──────────────────────────────────────────────────────────────────────

function createTileBlendLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const TERRAIN_NAMES: Record<number, string> = {
    [TerrainType.STONE_FLOOR]: 'Stone Floor',
    [TerrainType.STONE_WALL]: 'Stone Wall',
    [TerrainType.CORRIDOR]: 'Corridor',
    [TerrainType.CAVE_FLOOR]: 'Cave Floor',
    [TerrainType.CAVE_WALL]: 'Cave Wall',
    [TerrainType.GRASS]: 'Grass',
    [TerrainType.WATER]: 'Water',
    [TerrainType.LAVA]: 'Lava',
    [TerrainType.DIRT]: 'Dirt',
    [TerrainType.WOOD_FLOOR]: 'Wood Floor',
    [TerrainType.RUBBLE]: 'Rubble',
  };

  const settings: TileBlendSettings = {
    terrainA: TerrainType.STONE_FLOOR,
    terrainB: TerrainType.GRASS,
    blendMode: 'gradient',
    blendWidth: 6,
    cellSize: 16,
    showGrid: false,
    mapWidth: 30,
    mapHeight: 22,
    ...(loadLabState<Partial<TileBlendSettings>>(LAB_ID) ?? {}),
  };

  // ── Canvas ───────────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.imageRendering = 'pixelated';
  canvasHost.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;

  // ── Stats bar ─────────────────────────────────────────────────────────────
  const statsEl = document.createElement('div');
  statsEl.style.cssText =
    'font-size:11px;font-family:monospace;color:#94a3b8;margin-top:8px;padding:4px 8px;' +
    'background:#0f172a;border-radius:4px;';
  canvasHost.appendChild(statsEl);

  // ── Technique legend ──────────────────────────────────────────────────────
  const legendEl = document.createElement('div');
  legendEl.style.cssText =
    'margin-top:10px;font-size:11px;font-family:monospace;color:#94a3b8;line-height:1.7;';
  legendEl.innerHTML =
    '<b style="color:#e2e8f0">Techniques:</b><br>' +
    '<b style="color:#a3e635">Hard Edge</b> — raw tile stamps, no blending (baseline).<br>' +
    '<b style="color:#60a5fa">Gradient</b> — linear-gradient alpha overlay along each seam edge.<br>' +
    '  Phaser: stamp a semi-transparent gradient texture over border tiles.<br>' +
    '<b style="color:#f472b6">Ordered Dither</b> — Bayer 4×4 matrix selects neighbour pixels at seam.<br>' +
    "  Phaser: pre-bake a dither strip texture and stamp with neighbour's tint.<br>";
  controls.appendChild(legendEl);

  // ── Sheets ───────────────────────────────────────────────────────────────
  const sheets = loadSheetImages();

  // ── Render helpers ───────────────────────────────────────────────────────

  /** Extract pixel data for a single spritesheet frame into a new canvas. */
  function extractFrame(sheetEntry: SheetImage, frame: number): HTMLCanvasElement {
    const fw = sheetEntry.frameWidth;
    const fh = sheetEntry.frameHeight;
    const col = frame % sheetEntry.cols;
    const row = Math.floor(frame / sheetEntry.cols);
    const srcX = col * (fw + sheetEntry.spacing);
    const srcY = row * (fh + sheetEntry.spacing);

    const offscreen = document.createElement('canvas');
    offscreen.width = fw;
    offscreen.height = fh;
    const octx = offscreen.getContext('2d')!;
    octx.imageSmoothingEnabled = false;
    octx.drawImage(sheetEntry.img, srcX, srcY, fw, fh, 0, 0, fw, fh);
    return offscreen;
  }

  /** Draw a terrain tile (sprite or colour fallback) at (px, py) with size cs×cs. */
  function drawTileBase(
    terrainType: TerrainType,
    terrain: Uint8Array,
    mapW: number,
    mapH: number,
    tx: number,
    ty: number,
    px: number,
    py: number,
    cs: number,
  ): void {
    const visual: TileVisualDef | undefined = TILE_SPRITES[terrainType];
    const colorFallback = TERRAIN_FALLBACK_COLORS[terrainType] ?? 0x05060f;

    if (visual) {
      const sheet = sheets.get(visual.sheetKey);
      if (sheet?.loaded) {
        const frame = resolveFrame(visual, terrain, mapW, mapH, tx, ty, terrainType);
        const frameW = sheet.frameWidth;
        const col = frame % sheet.cols;
        const row = Math.floor(frame / sheet.cols);
        const srcX = col * (frameW + sheet.spacing);
        const srcY = row * (sheet.frameHeight + sheet.spacing);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(sheet.img, srcX, srcY, frameW, sheet.frameHeight, px, py, cs, cs);
        return;
      }
    }
    ctx.fillStyle = colorToCss(colorFallback);
    ctx.fillRect(px, py, cs, cs);
  }

  /** Apply a gradient blend strip on one edge of tile (px, py). */
  function applyGradientBlend(
    px: number,
    py: number,
    cs: number,
    dir: 'N' | 'E' | 'S' | 'W',
    neighbourColor: number,
    blendW: number,
  ): void {
    const bw = Math.min(blendW, cs);
    const css = colorToCss(neighbourColor);

    let x0: number, y0: number, x1: number, y1: number;
    let rx: number, ry: number, rw: number, rh: number;

    if (dir === 'N') {
      // blend strip at top of this tile — neighbour is above
      rx = px;
      ry = py;
      rw = cs;
      rh = bw;
      x0 = px;
      y0 = py;
      x1 = px;
      y1 = py + bw;
    } else if (dir === 'S') {
      rx = px;
      ry = py + cs - bw;
      rw = cs;
      rh = bw;
      x0 = px;
      y0 = py + cs;
      x1 = px;
      y1 = py + cs - bw;
    } else if (dir === 'W') {
      rx = px;
      ry = py;
      rw = bw;
      rh = cs;
      x0 = px;
      y0 = py;
      x1 = px + bw;
      y1 = py;
    } else {
      // E
      rx = px + cs - bw;
      ry = py;
      rw = bw;
      rh = cs;
      x0 = px + cs;
      y0 = py;
      x1 = px + cs - bw;
      y1 = py;
    }

    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    grad.addColorStop(0, css + 'bb'); // ~73% alpha at edge
    grad.addColorStop(1, css + '00'); // 0% alpha at interior

    ctx.fillStyle = grad;
    ctx.fillRect(rx, ry, rw, rh);
  }

  /** Apply ordered Bayer dither blend on one edge of tile (px, py). */
  function applyDitherBlend(
    px: number,
    py: number,
    cs: number,
    dir: 'N' | 'E' | 'S' | 'W',
    neighbourColor: number,
    blendW: number,
  ): void {
    const bw = Math.min(blendW, cs);
    const [nr, ng, nb] = hexToRGB(neighbourColor);

    // Pre-compute which (local px, py) fall in the blend strip and what
    // their distance-from-edge is.  Use a single ImageData call for speed.
    const imgData = ctx.getImageData(px, py, cs, cs);
    const d = imgData.data;

    for (let ly = 0; ly < cs; ly++) {
      for (let lx = 0; lx < cs; lx++) {
        // Distance from the edge in the blend direction
        let dist: number;
        if (dir === 'N') dist = ly;
        else if (dir === 'S') dist = cs - 1 - ly;
        else if (dir === 'W') dist = lx;
        else dist = cs - 1 - lx; // E

        if (dist >= bw) continue;

        // Bayer threshold: high at edge (dist=0) → all pixels replaced,
        // low at interior (dist=bw) → no pixels replaced.
        const threshold = BAYER4[ly % 4]![lx % 4]!;
        const neededThreshold = Math.round(((bw - dist) / bw) * 15);
        if (threshold > neededThreshold) continue;

        const i = (ly * cs + lx) * 4;
        d[i + 0] = nr;
        d[i + 1] = ng;
        d[i + 2] = nb;
        // Preserve alpha from the existing tile pixel
      }
    }
    ctx.putImageData(imgData, px, py);
  }

  // ── Main render ───────────────────────────────────────────────────────────

  function render(): void {
    saveLabState(LAB_ID, settings);

    const { mapWidth: mw, mapHeight: mh, cellSize: cs } = settings;
    const terrainA = settings.terrainA as TerrainType;
    const terrainB = settings.terrainB as TerrainType;

    canvas.width = mw * cs;
    canvas.height = mh * cs;
    ctx.imageSmoothingEnabled = false;

    const terrain = buildSplitTerrain(mw, mh, terrainA, terrainB);

    // Pass 1: draw all base tiles
    for (let ty = 0; ty < mh; ty++) {
      for (let tx = 0; tx < mw; tx++) {
        const t = terrain[ty * mw + tx] as TerrainType;
        drawTileBase(t, terrain, mw, mh, tx, ty, tx * cs, ty * cs, cs);
      }
    }

    // Pass 2: blend overlays (only when not 'hard')
    if (settings.blendMode !== 'hard') {
      const bw = settings.blendWidth;
      const DIRS: Array<['N' | 'E' | 'S' | 'W', number, number]> = [
        ['N', 0, -1],
        ['E', 1, 0],
        ['S', 0, 1],
        ['W', -1, 0],
      ];

      for (let ty = 0; ty < mh; ty++) {
        for (let tx = 0; tx < mw; tx++) {
          const t = terrain[ty * mw + tx] as TerrainType;
          const myColor = TERRAIN_FALLBACK_COLORS[t] ?? 0x05060f;
          const px = tx * cs;
          const py = ty * cs;

          for (const [dir, dx, dy] of DIRS) {
            const nx = tx + dx;
            const ny = ty + dy;
            if (nx < 0 || nx >= mw || ny < 0 || ny >= mh) continue;
            const nt = terrain[ny * mw + nx] as TerrainType;
            if (nt === t) continue;

            // Blend between this tile's colour and the neighbour's colour.
            // We draw the neighbour's colour fading INTO this tile at the edge.
            const nColor = TERRAIN_FALLBACK_COLORS[nt] ?? 0x05060f;
            void myColor; // used for dither variant; gradient uses nColor directly

            if (settings.blendMode === 'gradient') {
              applyGradientBlend(px, py, cs, dir, nColor, bw);
            } else {
              // dither
              applyDitherBlend(px, py, cs, dir, nColor, bw);
            }
          }
        }
      }
    }

    // Grid lines
    if (settings.showGrid && cs >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 0.5;
      for (let tx = 0; tx <= mw; tx++) {
        ctx.beginPath();
        ctx.moveTo(tx * cs, 0);
        ctx.lineTo(tx * cs, mh * cs);
        ctx.stroke();
      }
      for (let ty = 0; ty <= mh; ty++) {
        ctx.beginPath();
        ctx.moveTo(0, ty * cs);
        ctx.lineTo(mw * cs, ty * cs);
        ctx.stroke();
      }
    }

    const nameA = TERRAIN_NAMES[terrainA] ?? String(terrainA);
    const nameB = TERRAIN_NAMES[terrainB] ?? String(terrainB);
    statsEl.textContent =
      `${mw}×${mh} tiles · Mode: ${settings.blendMode} · ` +
      `Blend width: ${settings.blendWidth}px · A: ${nameA} · B: ${terrainB === terrainA ? '(same)' : nameB}`;
  }

  // Reload on sheet image load/error
  for (const entry of sheets.values()) {
    entry.img.addEventListener('load', () => render());
    entry.img.addEventListener('error', () => render());
  }

  // ── lil-gui controls ──────────────────────────────────────────────────────

  const terrainOptions = Object.fromEntries(
    Object.entries(TERRAIN_NAMES).map(([k, v]) => [v, Number(k)]),
  );

  const terrainFolder = gui.addFolder('Terrain');
  terrainFolder
    .add(settings, 'terrainA', terrainOptions)
    .name('Left (A)')
    .onChange(() => render());
  terrainFolder
    .add(settings, 'terrainB', terrainOptions)
    .name('Right (B)')
    .onChange(() => render());

  const blendFolder = gui.addFolder('Blend');
  blendFolder
    .add(settings, 'blendMode', ['hard', 'gradient', 'dither'])
    .name('Mode')
    .onChange(() => render());
  blendFolder
    .add(settings, 'blendWidth', 1, 32, 1)
    .name('Width (px)')
    .onChange(() => render());

  const displayFolder = gui.addFolder('Display');
  displayFolder
    .add(settings, 'cellSize', 4, 32, 2)
    .name('Cell Size (px)')
    .onChange(() => render());
  displayFolder
    .add(settings, 'showGrid')
    .name('Show Grid')
    .onChange(() => render());
  displayFolder
    .add(settings, 'mapWidth', 10, 60, 2)
    .name('Map Width')
    .onChange(() => render());
  displayFolder
    .add(settings, 'mapHeight', 8, 40, 2)
    .name('Map Height')
    .onChange(() => render());

  // Explicitly extract sheet frame preview: offscreen for blend illustration
  const previewFolder = gui.addFolder('Sheet Frame Preview');
  let previewCanvas: HTMLCanvasElement | null = null;
  const previewCtrl = { showFramePreview: false };
  previewFolder
    .add(previewCtrl, 'showFramePreview')
    .name('Show Sprite Frame')
    .onChange(() => {
      if (!previewCtrl.showFramePreview) {
        previewCanvas?.remove();
        previewCanvas = null;
        return;
      }
      const terrainA = settings.terrainA as TerrainType;
      const visual = TILE_SPRITES[terrainA];
      if (!visual) return;
      const sheet = sheets.get(visual.sheetKey);
      if (!sheet?.loaded) return;
      const c = document.createElement('canvas');
      const scale = 8;
      c.width = sheet.frameWidth * scale;
      c.height = sheet.frameHeight * scale;
      c.style.imageRendering = 'pixelated';
      c.style.marginTop = '8px';
      c.style.display = 'block';
      const octx = c.getContext('2d')!;
      const extracted = extractFrame(sheet, visual.frame);
      octx.imageSmoothingEnabled = false;
      octx.drawImage(extracted, 0, 0, c.width, c.height);
      previewCanvas = c;
      canvasHost.appendChild(c);
    });
  previewFolder.close();

  render();

  return () => {
    canvas.remove();
    statsEl.remove();
    legendEl.remove();
    previewCanvas?.remove();
  };
}

registerLab('tile-blend-lab', {
  category: 'Meta',
  name: 'Tile Blend Lab',
  description:
    'Investigates smooth transitions between terrain tile types. Compares hard-edge, ' +
    'gradient-alpha, and ordered-dither blending at biome seams.',
  create: createTileBlendLab,
});
