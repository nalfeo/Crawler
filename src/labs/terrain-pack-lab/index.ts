/**
 * Terrain Pack Lab — visual explorer for the 47-mask terrain pack system.
 *
 * Renders the wall-atlas frames, floor/corridor pool variants, and door states
 * for any registered terrain pack. No Phaser required — the lab loads assets
 * directly via the browser Image API and renders to a plain canvas.
 *
 * Controls:
 *   - Pack selector  — switch between registered packs (caeles-fixture, industrial-cave)
 *   - Cell size      — zoom level for the wall-atlas grid preview
 *   - Show grid      — draw frame boundaries on the wall atlas
 *   - Map Preview    — generate a full dungeon floor and render it with the active pack
 */

import GUI from 'lil-gui';
import { getGenerator } from '../../core/map/generators/registry.js';
import { getAllTerrainPackIds, getTerrainPack } from '../../shared/terrain-pack-registry.js';
import { resolvePublicAssetUrl } from '../../engine/generatedAssets/preload.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import { BiomeType, TerrainType, TileFlags, type MapConfig } from '../../shared/map-types.js';
import { SeededRandom } from '../../shared/random.js';
import { computeRawMask8, normalizeBlob47Mask } from '../../shared/terrain-pack-mask.js';
import type { FloorMap } from '../../core/map/FloorMap.js';
import {
  pickPoolCombo,
  pickWallAccentSelection,
  resolveDoorOrientationFromFlanks,
  resolveDoorPoolVariant,
} from '../../shared/terrain-pack-variants.js';
import { TERRAIN_FALLBACK_COLORS, colorToCss } from '../../shared/terrain-colors.js';
import { PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES } from '../../engine/terrain-renderer.js';
import type { TerrainPackId } from '../../shared/terrain-pack-types.js';

const LAB_ID = 'terrain-pack-lab';

const PACK_IDS = getAllTerrainPackIds();

// Columns and rows in the wall atlas (8×6 = 48 cells, last is spare)
const ATLAS_COLS = 8;
const ATLAS_ROWS = 6;

/** Terrain types considered walls for 47-mask connectivity. */
const PACK_WALL_TERRAINS = new Set<number>([TerrainType.STONE_WALL, TerrainType.CAVE_WALL]);

/**
 * Terrain a wall's 47-mask must READ as wall, which is a superset of the tiles
 * that are themselves wall-stamped (a door is a hole in a wall line, so its
 * neighbours must reach it flush). Imported from the renderer rather than
 * re-declared so the lab preview can never disagree with the real game about
 * which frame a wall beside a door selects.
 */
const PACK_WALL_MASK_NEIGHBOR_TERRAINS: ReadonlySet<number> =
  PACK_WALL_MASK_NEIGHBOR_TERRAIN_TYPES as ReadonlySet<number>;

/** Terrain types rendered using the floor pool. */
const PACK_FLOOR_TERRAINS = new Set<number>([TerrainType.STONE_FLOOR, TerrainType.CAVE_FLOOR]);

/** Terrain types rendered using the corridor pool. */
const PACK_CORRIDOR_TERRAINS = new Set<number>([TerrainType.CORRIDOR]);

/** CSS fallback per terrain, derived from the engine fallback colour table. */
const FALLBACK_CSS: Record<number, string> = Object.fromEntries(
  Object.entries(TERRAIN_FALLBACK_COLORS).map(([k, v]) => [k, colorToCss(v)]),
);

interface LabSettings {
  packId: string;
  cellSize: number;
  showGrid: boolean;
  mapBiome: BiomeType;
  mapSeed: number;
  mapCellSize: number;
}

const DEFAULT_SETTINGS: LabSettings = {
  packId: PACK_IDS[0] ?? 'caeles-fixture',
  cellSize: 64,
  showGrid: true,
  mapBiome: BiomeType.DUNGEON,
  mapSeed: 1,
  mapCellSize: 8,
};

type ControlsWithGui = HTMLElement & { __labGui?: GUI };

function loadImage(url: string): { img: HTMLImageElement; loaded: boolean; error: boolean } {
  const entry = { img: new Image(), loaded: false, error: false };
  entry.img.addEventListener('load', () => {
    entry.loaded = true;
  });
  entry.img.addEventListener('error', () => {
    entry.error = true;
  });
  entry.img.src = url;
  return entry;
}

function createTerrainPackLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const saved = loadLabState<Partial<LabSettings>>(LAB_ID);
  const settings: LabSettings = { ...DEFAULT_SETTINGS, ...saved };

  // ── Canvas setup ──────────────────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvasHost.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;

  // ── Map preview canvas ────────────────────────────────────────────────────
  const mapLabel = document.createElement('div');
  mapLabel.textContent = 'Map Preview';
  mapLabel.style.cssText =
    'color:#ccc;font:600 13px/1 monospace;margin:12px 0 4px 0;text-align:center';
  canvasHost.appendChild(mapLabel);

  const mapCanvas = document.createElement('canvas');
  mapCanvas.style.display = 'block';
  mapCanvas.style.margin = '0 auto';
  canvasHost.appendChild(mapCanvas);

  const mapStatsEl = document.createElement('div');
  mapStatsEl.style.cssText =
    'color:#999;font:11px/1.4 monospace;text-align:center;white-space:pre;margin-top:4px';
  canvasHost.appendChild(mapStatsEl);

  const mapCtx = mapCanvas.getContext('2d')!;

  // ── Image cache ───────────────────────────────────────────────────────────
  // Maps textureKey → { img, loaded, error }
  const imageCache = new Map<string, ReturnType<typeof loadImage>>();
  let cachedMapKey = '';
  let cachedMap: FloorMap | null = null;

  function getOrLoad(textureKey: string, imagePath: string): ReturnType<typeof loadImage> {
    let entry = imageCache.get(textureKey);
    if (!entry) {
      const url = resolvePublicAssetUrl(imagePath);
      entry = loadImage(url);
      entry.img.addEventListener('load', () => scheduleRender());
      entry.img.addEventListener('error', () => scheduleRender());
      imageCache.set(textureKey, entry);
    }
    return entry;
  }

  // ── Render ────────────────────────────────────────────────────────────────
  let rafId = 0;

  function scheduleRender(): void {
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
      renderMapPreview();
    });
  }

  function render(): void {
    const pack = getTerrainPack(settings.packId as TerrainPackId);
    const cell = settings.cellSize;
    const PADDING = 12;
    const SECTION_GAP = 24;
    const LABEL_HEIGHT = 18;

    // ── Atlas section ──────────────────────────────────────────────────────
    const atlasW = ATLAS_COLS * cell;
    const atlasH = ATLAS_ROWS * cell;

    // ── Pool section (floor + corridor + role-keyed special-room floors) ──
    const poolEntries = [
      ...pack.floorPool.map((v) => ({ label: 'floor', v })),
      ...pack.corridorPool.map((v) => ({ label: 'corridor', v })),
      ...Object.entries(pack.specialFloorPools ?? {}).flatMap(([key, pool]) =>
        pool.map((v) => ({ label: key, v })),
      ),
    ];
    const poolW = poolEntries.length * (cell + 4);
    const poolRowH = cell;

    // ── Door section ──────────────────────────────────────────────────────
    const doorEntries = Object.entries(pack.doorSet).map(([key, v]) => ({ key, v }));
    const doorW = doorEntries.length * (cell + 4);
    const doorRowH = cell;

    // ── Wall-accents section (2026-07-25) ──────────────────────────────────
    const wallAccents = pack.wallAccents ?? [];
    const accentW = wallAccents.length * (cell + 4);
    const accentRowH = cell;

    const totalW = Math.max(atlasW, poolW, doorW, accentW) + PADDING * 2;
    const totalH =
      PADDING +
      LABEL_HEIGHT +
      atlasH +
      SECTION_GAP +
      LABEL_HEIGHT +
      poolRowH +
      SECTION_GAP +
      LABEL_HEIGHT +
      doorRowH +
      SECTION_GAP +
      LABEL_HEIGHT +
      accentRowH +
      PADDING;

    canvas.width = totalW;
    canvas.height = totalH;

    ctx.clearRect(0, 0, totalW, totalH);
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, totalW, totalH);

    let y = PADDING;

    // ── Draw wall atlas ────────────────────────────────────────────────────
    ctx.fillStyle = '#a0c8ff';
    ctx.font = 'bold 13px monospace';
    ctx.fillText(`Pack: ${pack.id}  •  Wall Atlas (${ATLAS_COLS}×${ATLAS_ROWS})`, PADDING, y + 13);
    y += LABEL_HEIGHT + 4;

    const atlasEntry = getOrLoad(pack.wallAutotile.textureKey, pack.wallAutotile.imagePath);

    for (let row = 0; row < ATLAS_ROWS; row++) {
      for (let col = 0; col < ATLAS_COLS; col++) {
        const frameIdx = row * ATLAS_COLS + col;
        const dx = PADDING + col * cell;
        const dy = y + row * cell;

        // Background placeholder
        ctx.fillStyle = '#2d2d4e';
        ctx.fillRect(dx, dy, cell, cell);

        if (atlasEntry.loaded) {
          // Stamp the individual frame from the atlas spritesheet
          const srcX = col * pack.wallAutotile.cellPx;
          const srcY = row * pack.wallAutotile.cellPx;
          ctx.drawImage(
            atlasEntry.img,
            srcX,
            srcY,
            pack.wallAutotile.cellPx,
            pack.wallAutotile.cellPx,
            dx,
            dy,
            cell,
            cell,
          );
        } else if (atlasEntry.error) {
          ctx.fillStyle = '#c0392b55';
          ctx.fillRect(dx, dy, cell, cell);
          ctx.fillStyle = '#e74c3c';
          ctx.font = '10px monospace';
          ctx.fillText('ERR', dx + 2, dy + 12);
        } else {
          // Loading placeholder
          ctx.fillStyle = '#44446688';
          ctx.fillRect(dx + cell * 0.1, dy + cell * 0.1, cell * 0.8, cell * 0.8);
        }

        if (settings.showGrid) {
          ctx.strokeStyle = '#4a4a8888';
          ctx.lineWidth = 1;
          ctx.strokeRect(dx + 0.5, dy + 0.5, cell - 1, cell - 1);
        }

        // Frame index label
        ctx.fillStyle = '#88aacc99';
        ctx.font = '9px monospace';
        ctx.fillText(String(frameIdx), dx + 2, dy + 10);
      }
    }
    y += atlasH + SECTION_GAP;

    // ── Draw floor / corridor pool ─────────────────────────────────────────
    ctx.fillStyle = '#a0c8ff';
    ctx.font = 'bold 13px monospace';
    ctx.fillText(
      `Floor Pool (${pack.floorPool.length})  +  Corridor Pool (${pack.corridorPool.length})` +
        Object.entries(pack.specialFloorPools ?? {})
          .map(([key, pool]) => `  +  ${key} (${pool.length})`)
          .join(''),
      PADDING,
      y + 13,
    );
    y += LABEL_HEIGHT + 4;

    let poolIdx = 0;
    for (const { label, v } of poolEntries) {
      const dx = PADDING + poolIdx * (cell + 4);
      poolIdx += 1;

      ctx.fillStyle = '#2d2d4e';
      ctx.fillRect(dx, y, cell, cell);

      const poolEntry = getOrLoad(v.textureKey, v.imagePath);
      if (poolEntry.loaded) {
        ctx.drawImage(poolEntry.img, dx, y, cell, cell);
      } else if (poolEntry.error) {
        ctx.fillStyle = '#c0392b55';
        ctx.fillRect(dx, y, cell, cell);
      }

      // Label below
      ctx.fillStyle = label === 'floor' ? '#7ec8e3' : '#e3c87e';
      ctx.font = '9px monospace';
      ctx.fillText(label, dx + 2, y + cell - 3);

      if (settings.showGrid) {
        ctx.strokeStyle = label === 'floor' ? '#7ec8e344' : '#e3c87e44';
        ctx.lineWidth = 1;
        ctx.strokeRect(dx + 0.5, y + 0.5, cell - 1, cell - 1);
      }
    }
    y += poolRowH + SECTION_GAP;

    // ── Draw door states ───────────────────────────────────────────────────
    ctx.fillStyle = '#a0c8ff';
    ctx.font = 'bold 13px monospace';
    ctx.fillText(`Door States (${doorEntries.length})`, PADDING, y + 13);
    y += LABEL_HEIGHT + 4;

    let doorIdx = 0;
    for (const { key, v } of doorEntries) {
      const dx = PADDING + doorIdx * (cell + 4);
      doorIdx += 1;

      ctx.fillStyle = '#2d2d4e';
      ctx.fillRect(dx, y, cell, cell);

      const doorEntry = getOrLoad(v.textureKey, v.imagePath);
      if (doorEntry.loaded) {
        ctx.drawImage(doorEntry.img, dx, y, cell, cell);
      } else if (doorEntry.error) {
        ctx.fillStyle = '#c0392b55';
        ctx.fillRect(dx, y, cell, cell);
      }

      ctx.fillStyle = '#ccaaff';
      ctx.font = '9px monospace';
      ctx.fillText(key, dx + 2, y + cell - 3);

      if (settings.showGrid) {
        ctx.strokeStyle = '#ccaaff44';
        ctx.lineWidth = 1;
        ctx.strokeRect(dx + 0.5, y + 0.5, cell - 1, cell - 1);
      }
    }
    y += doorRowH + SECTION_GAP;

    // ── Draw wall-accent atlases (2026-07-25) ──────────────────────────────
    // Shows the mask-255 (fully-enclosed interior) frame of each accent atlas
    // as a representative swatch — that frame is the least likely to be
    // clipped by the mask-aware silhouette stencil, so the motif is most
    // visible there.
    ctx.fillStyle = '#a0c8ff';
    ctx.font = 'bold 13px monospace';
    ctx.fillText(`Wall Accents (${wallAccents.length})`, PADDING, y + 13);
    y += LABEL_HEIGHT + 4;

    const solidFrameIndex = pack.wallAutotile.masks.find((m) => m.maskId === 255)?.frameIndex ?? 0;
    let accentIdx = 0;
    for (const accent of wallAccents) {
      const dx = PADDING + accentIdx * (cell + 4);
      accentIdx += 1;

      ctx.fillStyle = '#2d2d4e';
      ctx.fillRect(dx, y, cell, cell);

      const accentEntry = getOrLoad(accent.textureKey, accent.imagePath);
      if (accentEntry.loaded) {
        const srcX = (solidFrameIndex % ATLAS_COLS) * pack.wallAutotile.cellPx;
        const srcY = Math.floor(solidFrameIndex / ATLAS_COLS) * pack.wallAutotile.cellPx;
        ctx.drawImage(
          accentEntry.img,
          srcX,
          srcY,
          pack.wallAutotile.cellPx,
          pack.wallAutotile.cellPx,
          dx,
          y,
          cell,
          cell,
        );
      } else if (accentEntry.error) {
        ctx.fillStyle = '#c0392b55';
        ctx.fillRect(dx, y, cell, cell);
      }

      ctx.fillStyle = '#ff9f6b';
      ctx.font = '9px monospace';
      ctx.fillText(accent.id, dx + 2, y + cell - 3);

      if (settings.showGrid) {
        ctx.strokeStyle = '#ff9f6b44';
        ctx.lineWidth = 1;
        ctx.strokeRect(dx + 0.5, y + 0.5, cell - 1, cell - 1);
      }
    }
  }

  // ── Map preview rendering ─────────────────────────────────────────────────
  function renderMapPreview(): void {
    const pack = getTerrainPack(settings.packId as TerrainPackId);
    const cell = settings.mapCellSize;
    const biome = settings.mapBiome;
    const seed = settings.mapSeed;

    const mapConfig: MapConfig = {
      biome,
      seed,
      widthTiles: 80,
      heightTiles: 50,
      tileSizeFt: 4,
      maxRooms: 18,
      floorDensity: 0.45,
      roomWidthRange: [5, 14],
      roomHeightRange: [5, 10],
    };

    const mapKey = `${biome}:${seed}`;
    if (!cachedMap || cachedMapKey !== mapKey) {
      const generator = getGenerator(biome);
      cachedMap = generator.generate(mapConfig, new SeededRandom(seed));
      cachedMapKey = mapKey;
    }
    const map = cachedMap;

    mapCanvas.width = map.width * cell;
    mapCanvas.height = map.height * cell;
    mapCtx.imageSmoothingEnabled = false;
    mapCtx.clearRect(0, 0, mapCanvas.width, mapCanvas.height);

    const atlasEntry = getOrLoad(`${settings.packId}:wall-autotile`, pack.wallAutotile.imagePath);
    const wallAccents = pack.wallAccents ?? [];
    const accentEntries = wallAccents.map((a) => ({
      accent: a,
      entry: getOrLoad(a.textureKey, a.imagePath),
    }));

    const ATLAS_FW = pack.wallAutotile.cellPx;
    const ATLAS_FH = pack.wallAutotile.cellPx;
    const ATLAS_SPACING = 0;
    const ATLAS_COLS_PACK = pack.wallAutotile.gridCols;

    /** Build a direct maskId → frameIndex lookup from the masks array. */
    const maskToFrame = new Map<number, number>(
      pack.wallAutotile.masks.map((e) => [e.maskId, e.frameIndex]),
    );

    // Live diversity instrumentation (2026-07-25 refinement #4) — mirrors
    // `TerrainLayerResult`'s histograms so this lab doubles as a quick visual
    // probe without needing to boot the real Phaser scene.
    let wallCount = 0;
    let wallAccentedCount = 0;
    const wallAccentCounts: Record<string, number> = {};
    const floorSourceCounts: Record<string, number> = {};
    const corridorSourceCounts: Record<string, number> = {};
    const floorCombos = new Set<string>();
    const corridorCombos = new Set<string>();

    /** Draw `img` into a `cell`x`cell` destination cell, applying a pool-combo transform via canvas mirroring. */
    function drawPoolTile(img: HTMLImageElement, dx: number, dy: number, transform: string): void {
      mapCtx.save();
      mapCtx.translate(dx + cell / 2, dy + cell / 2);
      mapCtx.scale(
        transform === 'flipH' || transform === 'flipHV' ? -1 : 1,
        transform === 'flipV' || transform === 'flipHV' ? -1 : 1,
      );
      mapCtx.drawImage(img, -cell / 2, -cell / 2, cell, cell);
      mapCtx.restore();
    }

    for (let ty = 0; ty < map.height; ty++) {
      for (let tx = 0; tx < map.width; tx++) {
        const idx = ty * map.width + tx;
        const terrain = map.terrain[idx] as number;
        const flags = map.flags[idx] ?? 0;
        const dx = tx * cell;
        const dy = ty * cell;

        if (PACK_WALL_TERRAINS.has(terrain)) {
          // Compute 47-mask for this wall tile
          const rawMask = computeRawMask8(tx, ty, map.width, map.height, (nx, ny) => {
            const ni = ny * map.width + nx;
            return PACK_WALL_MASK_NEIGHBOR_TERRAINS.has(map.terrain[ni] as number);
          });
          const maskIndex = normalizeBlob47Mask(rawMask);
          const frameNum = maskToFrame.get(maskIndex) ?? 0;
          const acol = frameNum % ATLAS_COLS_PACK;
          const arow = Math.floor(frameNum / ATLAS_COLS_PACK);
          const srcX = acol * (ATLAS_FW + ATLAS_SPACING);
          const srcY = arow * (ATLAS_FH + ATLAS_SPACING);
          wallCount += 1;

          if (atlasEntry.loaded) {
            mapCtx.drawImage(atlasEntry.img, srcX, srcY, ATLAS_FW, ATLAS_FH, dx, dy, cell, cell);
          } else {
            mapCtx.fillStyle = FALLBACK_CSS[terrain] ?? '#553c75';
            mapCtx.fillRect(dx, dy, cell, cell);
          }

          // Accented walls add a SECOND stamp (same frame, accent texture) —
          // mirrors the renderer's structural performance cap (refinement #6).
          const accent = pickWallAccentSelection(wallAccents, seed, tx, ty);
          if (accent) {
            wallAccentedCount += 1;
            wallAccentCounts[accent.id] = (wallAccentCounts[accent.id] ?? 0) + 1;
            const accentEntry = accentEntries.find((a) => a.accent.id === accent.id)?.entry;
            if (accentEntry?.loaded) {
              mapCtx.drawImage(accentEntry.img, srcX, srcY, ATLAS_FW, ATLAS_FH, dx, dy, cell, cell);
            }
          }
        } else if ((flags & TileFlags.DOOR) !== 0) {
          const leftTerrain = tx > 0 ? (map.terrain[idx - 1] as number) : TerrainType.VOID;
          const rightTerrain =
            tx < map.width - 1 ? (map.terrain[idx + 1] as number) : TerrainType.VOID;
          const isHorizontal =
            PACK_WALL_TERRAINS.has(leftTerrain) && PACK_WALL_TERRAINS.has(rightTerrain);
          const orientation = resolveDoorOrientationFromFlanks(isHorizontal);
          const doorVariant = resolveDoorPoolVariant(pack.doorSet, {
            isOpen: (flags & TileFlags.PASSABLE) !== 0,
            orientation,
          });
          if (doorVariant) {
            const doorEntry = getOrLoad(doorVariant.textureKey, doorVariant.imagePath);
            if (doorEntry.loaded) {
              mapCtx.drawImage(doorEntry.img, dx, dy, cell, cell);
            } else {
              mapCtx.fillStyle = '#8b5cf6';
              mapCtx.fillRect(dx, dy, cell, cell);
            }
          } else {
            mapCtx.fillStyle = '#8b5cf6';
            mapCtx.fillRect(dx, dy, cell, cell);
          }
        } else if (PACK_FLOOR_TERRAINS.has(terrain)) {
          const combo = pickPoolCombo(pack.floorPool, seed, tx, ty);
          if (combo) {
            floorSourceCounts[combo.variant.id] = (floorSourceCounts[combo.variant.id] ?? 0) + 1;
            floorCombos.add(`${combo.variant.id}:${combo.transform}`);
            const entry = getOrLoad(combo.variant.textureKey, combo.variant.imagePath);
            if (entry.loaded) {
              drawPoolTile(entry.img, dx, dy, combo.transform);
            } else {
              mapCtx.fillStyle = FALLBACK_CSS[terrain] ?? '#4a3f35';
              mapCtx.fillRect(dx, dy, cell, cell);
            }
          } else {
            mapCtx.fillStyle = FALLBACK_CSS[terrain] ?? '#4a3f35';
            mapCtx.fillRect(dx, dy, cell, cell);
          }
        } else if (PACK_CORRIDOR_TERRAINS.has(terrain)) {
          const combo = pickPoolCombo(pack.corridorPool, seed, tx, ty);
          if (combo) {
            corridorSourceCounts[combo.variant.id] =
              (corridorSourceCounts[combo.variant.id] ?? 0) + 1;
            corridorCombos.add(`${combo.variant.id}:${combo.transform}`);
            const entry = getOrLoad(combo.variant.textureKey, combo.variant.imagePath);
            if (entry.loaded) {
              drawPoolTile(entry.img, dx, dy, combo.transform);
            } else {
              mapCtx.fillStyle = FALLBACK_CSS[terrain] ?? '#2d2d4e';
              mapCtx.fillRect(dx, dy, cell, cell);
            }
          } else {
            mapCtx.fillStyle = FALLBACK_CSS[terrain] ?? '#2d2d4e';
            mapCtx.fillRect(dx, dy, cell, cell);
          }
        } else {
          mapCtx.fillStyle = FALLBACK_CSS[terrain] ?? '#0a0a0f';
          mapCtx.fillRect(dx, dy, cell, cell);
        }
      }
    }

    const accentDensityPct =
      wallCount > 0 ? ((wallAccentedCount / wallCount) * 100).toFixed(1) : '0';
    const floorSourcesUsed = Object.keys(floorSourceCounts).length;
    const corridorSourcesUsed = Object.keys(corridorSourceCounts).length;
    mapStatsEl.textContent =
      `${map.width}×${map.height}  Rooms: ${map.rooms.length}  Biome: ${biome}  Seed: ${seed}\n` +
      `floor: ${floorSourcesUsed}/${pack.floorPool.length} sources, ${floorCombos.size} combos  |  ` +
      `corridor: ${corridorSourcesUsed}/${pack.corridorPool.length} sources, ${corridorCombos.size} combos\n` +
      `wall accents: ${wallAccentedCount}/${wallCount} (${accentDensityPct}%)  ` +
      `[${Object.entries(wallAccentCounts)
        .map(([id, n]) => `${id}:${n}`)
        .join(' ')}]`;
  }

  // ── GUI controls ──────────────────────────────────────────────────────────
  gui
    .add(settings, 'packId', PACK_IDS as unknown as string[])
    .name('Pack')
    .onChange((v: string) => {
      settings.packId = v;
      // Clear old images so the new pack's assets load fresh
      imageCache.clear();
      saveLabState(LAB_ID, settings);
      scheduleRender();
    });

  gui
    .add(settings, 'cellSize', 16, 128, 8)
    .name('Cell Size')
    .onChange((v: number) => {
      settings.cellSize = v;
      saveLabState(LAB_ID, settings);
      scheduleRender();
    });

  gui
    .add(settings, 'showGrid')
    .name('Show Grid')
    .onChange((v: boolean) => {
      settings.showGrid = v;
      saveLabState(LAB_ID, settings);
      scheduleRender();
    });

  // ── Map Preview GUI folder ─────────────────────────────────────────────────
  const mapFolder = gui.addFolder('Map Preview');
  mapFolder
    .add(settings, 'mapBiome', [BiomeType.DUNGEON, BiomeType.CAVE_SYSTEM] as BiomeType[])
    .name('Biome')
    .onChange((v: BiomeType) => {
      settings.mapBiome = v;
      saveLabState(LAB_ID, settings);
      scheduleRender();
    });
  mapFolder
    .add(settings, 'mapSeed', 1, 2_000_000, 1)
    .name('Seed')
    .onChange((v: number) => {
      settings.mapSeed = v;
      saveLabState(LAB_ID, settings);
      scheduleRender();
    });
  mapFolder
    .add(settings, 'mapCellSize', 4, 24, 2)
    .name('Cell Size')
    .onChange((v: number) => {
      settings.mapCellSize = v;
      saveLabState(LAB_ID, settings);
      scheduleRender();
    });
  mapFolder
    .add(
      {
        nextSeed: () => {
          settings.mapSeed = settings.mapSeed >= 2_000_000 ? 1 : settings.mapSeed + 1;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          saveLabState(LAB_ID, settings);
          scheduleRender();
        },
      },
      'nextSeed',
    )
    .name('➕ Next Seed');

  scheduleRender();

  return () => {
    if (rafId) cancelAnimationFrame(rafId);
    canvas.remove();
    mapCanvas.remove();
    mapLabel.remove();
    mapStatsEl.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta',
  name: 'Terrain Pack Lab',
  description:
    'Visual explorer for the 47-mask terrain pack system. Browse wall-atlas frames, floor/corridor pool variants, and door states for any registered pack.',
  create: createTerrainPackLab,
});
