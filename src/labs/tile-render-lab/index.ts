/**
 * Tile Render Lab — visual tuning sandbox for the terrain tile mapping.
 *
 * Renders a procedurally generated FloorMap using actual Kenney spritesheet
 * frames (loaded via <img>) alongside the color-fallback path. Lets developers
 * visually verify and tune the TerrainType → frame mapping defined in
 * src/engine/sprites/tile-visuals.ts before it reaches the live engine.
 *
 * Controls:
 *   - Biome selector    — switch between generator algorithms
 *   - Seed              — deterministic generation
 *   - Cell size         — zoom level for the canvas preview
 *   - Coverage overlay  — highlight tiles with vs without sprite coverage
 *   - Show grid         — draw tile boundaries
 *   - Randomize seed    — quick re-roll button
 */

import GUI from 'lil-gui';
import {
  getGenerator,
  getRegisteredBiomes,
  hasGenerator,
} from '../../core/map/generators/registry.js';
import { BiomeType, TerrainType } from '../../shared/map-types.js';
import type { MapConfig } from '../../shared/map-types.js';
import type { FloorMap } from '../../core/map/FloorMap.js';
import { SeededRandom } from '../../shared/random.js';
import { SHEETS } from '../../engine/sprites/index.js';
import { TILE_SPRITES, resolveFrame } from '../../engine/sprites/tile-visuals.js';
import { TERRAIN_FALLBACK_COLORS, colorToCss } from '../../shared/terrain-colors.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

const LAB_ID = 'tile-render-lab';

// Smaller grid for fast iteration in the lab
const DEFAULT_WIDTH = 60;
const DEFAULT_HEIGHT = 45;

interface TileRenderLabSettings {
  biome: string;
  seed: number;
  widthTiles: number;
  heightTiles: number;
  cellSize: number;
  showCoverageOverlay: boolean;
  showGrid: boolean;
}

/** CSS hex strings derived from the engine's fallback colour table. */
const TERRAIN_FALLBACK_CSS: Record<number, string> = Object.fromEntries(
  Object.entries(TERRAIN_FALLBACK_COLORS).map(([k, v]) => [k, colorToCss(v)]),
);

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

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

function createTileRenderLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) throw new Error('Lab runner did not initialize lil-gui.');

  const biomes = getRegisteredBiomes();
  const defaultBiome = biomes.includes(BiomeType.DUNGEON)
    ? BiomeType.DUNGEON
    : (biomes[0] ?? 'dungeon');

  const settings: TileRenderLabSettings = {
    biome: defaultBiome,
    seed: 42,
    widthTiles: DEFAULT_WIDTH,
    heightTiles: DEFAULT_HEIGHT,
    cellSize: 8,
    showCoverageOverlay: false,
    showGrid: false,
    ...(loadLabState<Partial<TileRenderLabSettings>>(LAB_ID) ?? {}),
  };

  // ── Canvas setup ───────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.imageRendering = 'pixelated';
  canvasHost.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;

  // ── Stats bar ──────────────────────────────────────────────────────────────
  const statsEl = document.createElement('div');
  statsEl.style.cssText =
    'font-size:11px;font-family:monospace;color:#94a3b8;margin-top:8px;padding:4px 8px;' +
    'background:#0f172a;border-radius:4px;';
  canvasHost.appendChild(statsEl);

  // ── Load spritesheet images ────────────────────────────────────────────────
  const sheets = loadSheetImages();

  // ── Generation & render ────────────────────────────────────────────────────
  let currentFloor: FloorMap | null = null;

  function generate(): void {
    const biome = settings.biome as BiomeType;
    if (!hasGenerator(biome)) {
      statsEl.textContent = `No generator for biome: ${biome}`;
      return;
    }
    const gen = getGenerator(biome);

    const config: MapConfig = {
      widthTiles: settings.widthTiles,
      heightTiles: settings.heightTiles,
      tileSizePx: 16,
      biome,
      seed: settings.seed,
      roomWidthRange: [5, 12],
      roomHeightRange: [4, 10],
      maxRooms: 20,
      floorDensity: 0.45,
    };

    const rng = new SeededRandom(config.seed);
    currentFloor = gen.generate(config, rng);
    render();
  }

  function drawFrame(
    sheet: SheetImage,
    frame: number,
    destX: number,
    destY: number,
    destW: number,
    destH: number,
  ): void {
    if (!sheet.loaded) return;
    const col = frame % sheet.cols;
    const row = Math.floor(frame / sheet.cols);
    const srcX = col * (sheet.frameWidth + sheet.spacing);
    const srcY = row * (sheet.frameHeight + sheet.spacing);
    ctx.drawImage(
      sheet.img,
      srcX,
      srcY,
      sheet.frameWidth,
      sheet.frameHeight,
      destX,
      destY,
      destW,
      destH,
    );
  }

  function render(): void {
    const floor = currentFloor;
    if (!floor) return;

    saveLabState(LAB_ID, settings);

    const cs = settings.cellSize;
    const pw = floor.width * cs;
    const ph = floor.height * cs;

    canvas.width = pw;
    canvas.height = ph;

    // Disable image smoothing for pixel-art tiles
    ctx.imageSmoothingEnabled = false;

    let spriteCount = 0;
    let colorCount = 0;

    for (let ty = 0; ty < floor.height; ty++) {
      for (let tx = 0; tx < floor.width; tx++) {
        const idx = ty * floor.width + tx;
        const terrain: TerrainType = floor.terrain[idx] ?? TerrainType.VOID;
        const visual = TILE_SPRITES[terrain];
        const destX = tx * cs;
        const destY = ty * cs;

        if (visual) {
          const sheet = sheets.get(visual.sheetKey);
          const frame = resolveFrame(
            visual,
            floor.terrain,
            floor.width,
            floor.height,
            tx,
            ty,
            terrain,
          );
          if (!sheet || sheet.error) {
            // Sheet missing or failed to load — use terrain color fallback
            ctx.fillStyle = TERRAIN_FALLBACK_CSS[terrain] ?? '#05060f';
            ctx.fillRect(destX, destY, cs, cs);
            colorCount++;
          } else if (sheet.loaded) {
            drawFrame(sheet, frame, destX, destY, cs, cs);
            spriteCount++;
          } else {
            // Sheet still loading — draw a dim placeholder
            ctx.fillStyle = '#1e3a5f';
            ctx.fillRect(destX, destY, cs, cs);
            colorCount++;
          }
        } else {
          ctx.fillStyle = TERRAIN_FALLBACK_CSS[terrain] ?? '#05060f';
          ctx.fillRect(destX, destY, cs, cs);
          colorCount++;
        }

        // Coverage overlay
        if (settings.showCoverageOverlay) {
          if (visual) {
            ctx.fillStyle = 'rgba(0,255,128,0.25)';
          } else if (terrain !== TerrainType.VOID) {
            ctx.fillStyle = 'rgba(255,80,80,0.25)';
          } else {
            ctx.fillStyle = 'transparent';
          }
          ctx.fillRect(destX, destY, cs, cs);
        }
      }
    }

    // Grid lines
    if (settings.showGrid && cs >= 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)';
      ctx.lineWidth = 0.5;
      for (let tx = 0; tx <= floor.width; tx++) {
        ctx.beginPath();
        ctx.moveTo(tx * cs, 0);
        ctx.lineTo(tx * cs, ph);
        ctx.stroke();
      }
      for (let ty = 0; ty <= floor.height; ty++) {
        ctx.beginPath();
        ctx.moveTo(0, ty * cs);
        ctx.lineTo(pw, ty * cs);
        ctx.stroke();
      }
    }

    const total = floor.width * floor.height;
    const pct = total > 0 ? Math.round((spriteCount / total) * 100) : 0;
    statsEl.textContent =
      `${floor.width}×${floor.height} tiles · ` +
      `🟩 sprite: ${spriteCount} (${pct}%) · ` +
      `🟥 color-fallback: ${colorCount} · ` +
      `Biome: ${settings.biome} · Seed: ${settings.seed}`;
  }

  // ── Sheet image callbacks trigger a re-render ─────────────────────────────
  for (const entry of sheets.values()) {
    entry.img.addEventListener('load', () => render());
    entry.img.addEventListener('error', () => render());
  }

  // ── lil-gui controls ──────────────────────────────────────────────────────
  const genFolder = gui.addFolder('Map');
  genFolder
    .add(settings, 'biome', biomes)
    .name('Biome')
    .onChange(() => generate());
  genFolder
    .add(settings, 'seed', 1, 9999, 1)
    .name('Seed')
    .onChange(() => generate());
  genFolder
    .add(settings, 'widthTiles', 20, 120, 5)
    .name('Width')
    .onChange(() => generate());
  genFolder
    .add(settings, 'heightTiles', 20, 80, 5)
    .name('Height')
    .onChange(() => generate());

  const displayFolder = gui.addFolder('Display');
  displayFolder
    .add(settings, 'cellSize', 2, 24, 1)
    .name('Cell Size (px)')
    .onChange(() => render());
  displayFolder
    .add(settings, 'showCoverageOverlay')
    .name('Coverage Overlay')
    .onChange(() => render());
  displayFolder
    .add(settings, 'showGrid')
    .name('Show Grid')
    .onChange(() => render());

  gui
    .add(
      {
        randomSeed: () => {
          const buf = new Uint16Array(1);
          crypto.getRandomValues(buf);
          settings.seed = (buf[0]! % 9999) + 1;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          generate();
        },
      },
      'randomSeed',
    )
    .name('🎲 Random Seed');

  gui.add({ regenerate: () => generate() }, 'regenerate').name('🔄 Regenerate');

  // ── Legend ────────────────────────────────────────────────────────────────
  const legend = document.createElement('div');
  legend.style.cssText =
    'margin-top:12px;font-size:11px;font-family:monospace;color:#94a3b8;line-height:1.8;';
  legend.innerHTML =
    '<b style="color:#e2e8f0">Coverage overlay:</b><br>' +
    '<span style="color:#00ff80">■</span> Sprite tile (frame mapped in TILE_SPRITES)<br>' +
    '<span style="color:#ff5050">■</span> Color fallback (no TILE_SPRITES entry)<br>' +
    '<br><b style="color:#e2e8f0">To tune:</b> edit <code>src/engine/sprites/tile-visuals.ts</code><br>' +
    'Use <a href="?lab=tile-explorer" style="color:#60a5fa">tile-explorer</a> to find frame indices.';
  controls.appendChild(legend);

  generate();

  return () => {
    canvas.remove();
    statsEl.remove();
    legend.remove();
  };
}

registerLab('tile-render-lab', {
  category: 'Meta',
  name: 'Tile Render Lab',
  description:
    'Visual tuning sandbox for terrain tile sprites. Preview which TerrainTypes have sprite coverage vs. color fallback, and tune frame mappings before they ship.',
  create: createTileRenderLab,
});
