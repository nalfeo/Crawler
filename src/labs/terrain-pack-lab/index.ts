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
 */

import GUI from 'lil-gui';
import { getAllTerrainPackIds, getTerrainPack } from '../../shared/terrain-pack-registry.js';
import { resolvePublicAssetUrl } from '../../engine/generatedAssets/preload.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import type { TerrainPackId } from '../../shared/terrain-pack-types.js';

const LAB_ID = 'terrain-pack-lab';

const PACK_IDS = getAllTerrainPackIds();

// Columns and rows in the wall atlas (8×6 = 48 cells, last is spare)
const ATLAS_COLS = 8;
const ATLAS_ROWS = 6;

interface LabSettings {
  packId: string;
  cellSize: number;
  showGrid: boolean;
}

const DEFAULT_SETTINGS: LabSettings = {
  packId: PACK_IDS[0] ?? 'caeles-fixture',
  cellSize: 64,
  showGrid: true,
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

  // ── Image cache ───────────────────────────────────────────────────────────
  // Maps textureKey → { img, loaded, error }
  const imageCache = new Map<string, ReturnType<typeof loadImage>>();

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

    // ── Pool section (floor + corridor) ───────────────────────────────────
    const poolEntries = [
      ...pack.floorPool.map((v) => ({ label: 'floor', v })),
      ...pack.corridorPool.map((v) => ({ label: 'corridor', v })),
    ];
    const poolW = poolEntries.length * (cell + 4);
    const poolRowH = cell;

    // ── Door section ──────────────────────────────────────────────────────
    const doorEntries = Object.entries(pack.doorSet).map(([key, v]) => ({ key, v }));
    const doorW = doorEntries.length * (cell + 4);
    const doorRowH = cell;

    const totalW = Math.max(atlasW, poolW, doorW) + PADDING * 2;
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

    const atlasEntry = getOrLoad(
      pack.wallAutotile.textureKey,
      pack.wallAutotile.imagePath,
    );

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
      `Floor Pool (${pack.floorPool.length})  +  Corridor Pool (${pack.corridorPool.length})`,
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

  scheduleRender();

  return () => {
    if (rafId) cancelAnimationFrame(rafId);
    canvas.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Meta',
  name: 'Terrain Pack Lab',
  description:
    'Visual explorer for the 47-mask terrain pack system. Browse wall-atlas frames, floor/corridor pool variants, and door states for any registered pack.',
  create: createTerrainPackLab,
});
