/**
 * FOV + Lighting Lab — visualize FOV and configurable sub-tile lighting.
 */

import GUI from 'lil-gui';
import { FOV } from 'rot-js';
import { TileMap } from '../../core/map/TileMap.js';
import { TilePresets } from '../../shared/map-types.js';
import { SeededRandom } from '../../shared/random.js';
import {
  blurLightField,
  clampLightingStepPx,
  computeLightField,
  createLightField,
} from '../../engine/lighting/light-field.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

const LAB_ID = 'fov-lab';
const GRID_W = 40;
const GRID_H = 30;
const CELL_SIZE = 20;
const WORLD_W_PX = GRID_W * CELL_SIZE;
const WORLD_H_PX = GRID_H * CELL_SIZE;

interface FovLabSettings {
  fovRadius: number;
  playerX: number;
  playerY: number;
  wallDensity: number;
  stepPx: number;
  ambient: number;
  sourceRadiusPx: number;
  sourceIntensity: number;
  falloffExponent: number;
  softness: boolean;
}

function createFovLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const settings: FovLabSettings = {
    fovRadius: 12,
    playerX: Math.floor(GRID_W / 2),
    playerY: Math.floor(GRID_H / 2),
    wallDensity: 0.2,
    stepPx: 5,
    ambient: 0.08,
    sourceRadiusPx: 220,
    sourceIntensity: 0.95,
    falloffExponent: 1.6,
    softness: false,
    ...(loadLabState<FovLabSettings>(LAB_ID) ?? {}),
  };
  settings.stepPx = clampLightingStepPx(settings.stepPx, CELL_SIZE);

  const canvas = document.createElement('canvas');
  canvas.width = WORLD_W_PX;
  canvas.height = WORLD_H_PX;
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvas.style.cursor = 'crosshair';
  canvasHost.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;
  const lightField = createLightField(WORLD_W_PX, WORLD_H_PX, settings.stepPx);
  let tileMap = buildMap(settings.wallDensity);
  const visible = new Uint8Array(GRID_W * GRID_H);
  const frameStats = { fps: 0, frameMs: 0, computeMs: 0 };
  let rafId = 0;
  let lastFrameAt = performance.now();
  let statsDirty = true;

  function rebuildLightFieldIfNeeded(): void {
    const nextStep = clampLightingStepPx(settings.stepPx, CELL_SIZE);
    settings.stepPx = nextStep;
    if (lightField.stepPx === nextStep) return;
    const rebuilt = createLightField(WORLD_W_PX, WORLD_H_PX, nextStep);
    lightField.stepPx = rebuilt.stepPx;
    lightField.widthCells = rebuilt.widthCells;
    lightField.heightCells = rebuilt.heightCells;
    lightField.values = rebuilt.values;
  }

  function buildMap(density: number): TileMap {
    const rng = new SeededRandom(42);
    const tm = new TileMap(GRID_W, GRID_H);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const idx = y * GRID_W + x;
        if (x === 0 || x === GRID_W - 1 || y === 0 || y === GRID_H - 1) {
          tm.flags[idx] = TilePresets.WALL;
        } else if (rng.next() < density) {
          tm.flags[idx] = TilePresets.WALL;
        } else {
          tm.flags[idx] = TilePresets.FLOOR;
        }
      }
    }
    const pidx = settings.playerY * GRID_W + settings.playerX;
    tm.flags[pidx] = TilePresets.FLOOR;
    return tm;
  }

  function computeFov(): void {
    visible.fill(0);
    const fov = new FOV.RecursiveShadowcasting(tileMap.createLightPassesCallback());
    fov.compute(settings.playerX, settings.playerY, settings.fovRadius, (x, y, _r, v) => {
      if (v > 0 && x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) {
        visible[y * GRID_W + x] = 1;
      }
    });
  }

  function computeLighting(): void {
    const playerPx = settings.playerX * CELL_SIZE + CELL_SIZE * 0.5;
    const playerPy = settings.playerY * CELL_SIZE + CELL_SIZE * 0.5;
    const t0 = performance.now();
    computeLightField({
      map: {
        pixelToTile: (px, py) => ({ x: Math.floor(px / CELL_SIZE), y: Math.floor(py / CELL_SIZE) }),
        isVisible: (tx, ty) => {
          if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return false;
          return visible[ty * GRID_W + tx] === 1;
        },
        hasLineOfSight: (px0, py0, px1, py1) => {
          const from = { x: Math.floor(px0 / CELL_SIZE), y: Math.floor(py0 / CELL_SIZE) };
          const to = { x: Math.floor(px1 / CELL_SIZE), y: Math.floor(py1 / CELL_SIZE) };
          return tileMap.lineOfSight(from.x, from.y, to.x, to.y);
        },
      },
      field: lightField,
      source: {
        x: playerPx,
        y: playerPy,
        radiusPx: settings.sourceRadiusPx,
        intensity: settings.sourceIntensity,
      },
      ambient: settings.ambient,
      falloffExponent: settings.falloffExponent,
    });
    if (settings.softness) {
      blurLightField(lightField);
    }
    frameStats.computeMs = performance.now() - t0;
  }

  function render(): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const idx = y * GRID_W + x;
        const isWall = !tileMap.isPassable(x, y);
        const base = isWall ? (visible[idx] === 1 ? '#49566b' : '#1a202c') : '#2e3642';
        ctx.fillStyle = base;
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }

    for (let cy = 0; cy < lightField.heightCells; cy++) {
      for (let cx = 0; cx < lightField.widthCells; cx++) {
        const idx = cy * lightField.widthCells + cx;
        const darkness = 1 - Math.max(0, Math.min(1, lightField.values[idx] ?? 0));
        if (darkness <= 0.01) continue;
        ctx.fillStyle = `rgba(0,0,0,${darkness.toFixed(3)})`;
        ctx.fillRect(
          cx * lightField.stepPx,
          cy * lightField.stepPx,
          lightField.stepPx,
          lightField.stepPx,
        );
      }
    }

    ctx.fillStyle = '#48bb78';
    ctx.beginPath();
    ctx.arc(
      settings.playerX * CELL_SIZE + CELL_SIZE / 2,
      settings.playerY * CELL_SIZE + CELL_SIZE / 2,
      CELL_SIZE / 3,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  function updatePerfStats(now: number): void {
    const dt = now - lastFrameAt;
    lastFrameAt = now;
    const fps = dt > 0 ? 1000 / dt : 0;
    frameStats.fps = frameStats.fps * 0.9 + fps * 0.1;
    frameStats.frameMs = frameStats.frameMs * 0.9 + dt * 0.1;
    if (statsDirty) {
      stats.textContent = `FPS ${frameStats.fps.toFixed(1)} · Frame ${frameStats.frameMs.toFixed(
        2,
      )}ms · Lighting ${frameStats.computeMs.toFixed(2)}ms · stepPx ${settings.stepPx}`;
      statsDirty = false;
    }
  }

  function tick(now: number): void {
    rebuildLightFieldIfNeeded();
    computeFov();
    computeLighting();
    render();
    statsDirty = true;
    updatePerfStats(now);
    rafId = requestAnimationFrame(tick);
  }

  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / CELL_SIZE);
    const y = Math.floor((e.clientY - rect.top) / CELL_SIZE);
    if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H && tileMap.isPassable(x, y)) {
      settings.playerX = x;
      settings.playerY = y;
      saveLabState(LAB_ID, settings);
      statsDirty = true;
    }
  });

  gui
    .add(settings, 'fovRadius', 3, 30, 1)
    .name('FOV Radius')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      statsDirty = true;
    });
  gui
    .add(settings, 'wallDensity', 0, 0.5, 0.01)
    .name('Wall Density')
    .onChange(() => {
      tileMap = buildMap(settings.wallDensity);
      saveLabState(LAB_ID, settings);
      statsDirty = true;
    });
  gui
    .add(settings, 'stepPx', {
      tile: CELL_SIZE,
      half: Math.floor(CELL_SIZE / 2),
      quarter: 5,
      pixel: 1,
    })
    .name('Lighting Step')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      statsDirty = true;
    });
  gui
    .add(settings, 'ambient', 0, 0.5, 0.01)
    .name('Ambient')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      statsDirty = true;
    });
  gui
    .add(settings, 'sourceRadiusPx', 40, 420, 5)
    .name('Source Radius')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      statsDirty = true;
    });
  gui
    .add(settings, 'sourceIntensity', 0, 2, 0.05)
    .name('Source Intensity')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      statsDirty = true;
    });
  gui
    .add(settings, 'falloffExponent', 0.3, 4, 0.1)
    .name('Falloff Curve')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      statsDirty = true;
    });
  gui
    .add(settings, 'softness')
    .name('Blur / Softness')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      statsDirty = true;
    });
  gui
    .add(
      {
        regenerate: () => {
          tileMap = buildMap(settings.wallDensity);
          saveLabState(LAB_ID, settings);
          statsDirty = true;
        },
      },
      'regenerate',
    )
    .name('Regenerate Map');

  const hint = document.createElement('p');
  hint.textContent =
    'Click to move player. Tune lighting step from tile-size to 1px and compare visual/perf telemetry.';
  hint.style.marginTop = '12px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';
  controls.appendChild(hint);

  const stats = document.createElement('p');
  stats.style.marginTop = '8px';
  stats.style.color = '#fcd34d';
  stats.style.fontFamily = 'monospace';
  stats.style.fontSize = '12px';
  controls.appendChild(stats);

  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    canvas.remove();
    hint.remove();
    stats.remove();
  };
}

registerLab('fov-lab', {
  category: 'Movement & Physics',
  name: 'FOV + Lighting Lab',
  description:
    'Visualize recursive shadowcasting and configurable lighting granularity (tile-size to 1px).',
  create: createFovLab,
});
