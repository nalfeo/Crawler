/**
 * FOV Lab — visualize field-of-view with interactive controls.
 *
 * Renders a small tile grid, places walls, and computes FOV from
 * a movable player position. Useful for tuning FOV radius and
 * verifying LOS behavior around walls and doors.
 */

import GUI from 'lil-gui';
import { FOV } from 'rot-js';
import { TileMap } from '../../core/map/TileMap.js';
import { TilePresets } from '../../shared/map-types.js';
import { SeededRandom } from '../../shared/random.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

const LAB_ID = 'fov-lab';
const GRID_W = 40;
const GRID_H = 30;
const CELL_SIZE = 20;

interface FovLabSettings {
  fovRadius: number;
  playerX: number;
  playerY: number;
  wallDensity: number;
}

function createFovLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const settings: FovLabSettings = {
    fovRadius: 12,
    playerX: Math.floor(GRID_W / 2),
    playerY: Math.floor(GRID_H / 2),
    wallDensity: 0.2,
    ...(loadLabState<FovLabSettings>(LAB_ID) ?? {}),
  };

  const canvas = document.createElement('canvas');
  canvas.width = GRID_W * CELL_SIZE;
  canvas.height = GRID_H * CELL_SIZE;
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvas.style.cursor = 'crosshair';
  canvasHost.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;
  let tileMap = buildMap(settings.wallDensity);
  const visible = new Uint8Array(GRID_W * GRID_H);

  function buildMap(density: number): TileMap {
    const rng = new SeededRandom(42);
    const tm = new TileMap(GRID_W, GRID_H);
    // Border walls + random interior walls
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
    // Ensure player position is floor
    const pidx = settings.playerY * GRID_W + settings.playerX;
    tm.flags[pidx] = TilePresets.FLOOR;
    return tm;
  }

  function computeFov(): void {
    visible.fill(0);
    const lightPasses = tileMap.createLightPassesCallback();
    const fov = new FOV.RecursiveShadowcasting(lightPasses);
    fov.compute(settings.playerX, settings.playerY, settings.fovRadius, (x, y, _r, v) => {
      if (v > 0 && x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) {
        visible[y * GRID_W + x] = 1;
      }
    });
  }

  function render(): void {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const idx = y * GRID_W + x;
        const isWall = !tileMap.isPassable(x, y);
        const isVisible = visible[idx] === 1;

        if (isWall) {
          ctx.fillStyle = isVisible ? '#4a5568' : '#1a202c';
        } else {
          ctx.fillStyle = isVisible ? '#2d3748' : '#0d1117';
        }
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE - 1, CELL_SIZE - 1);
      }
    }

    // Draw player
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

  function refresh(): void {
    computeFov();
    render();
  }

  // Click to move player
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / CELL_SIZE);
    const y = Math.floor((e.clientY - rect.top) / CELL_SIZE);
    if (x >= 0 && x < GRID_W && y >= 0 && y < GRID_H && tileMap.isPassable(x, y)) {
      settings.playerX = x;
      settings.playerY = y;
      saveLabState(LAB_ID, settings);
      refresh();
    }
  });

  gui
    .add(settings, 'fovRadius', 3, 30, 1)
    .name('FOV Radius')
    .onChange(() => {
      saveLabState(LAB_ID, settings);
      refresh();
    });
  gui
    .add(settings, 'wallDensity', 0, 0.5, 0.01)
    .name('Wall Density')
    .onChange(() => {
      tileMap = buildMap(settings.wallDensity);
      saveLabState(LAB_ID, settings);
      refresh();
    });
  gui
    .add(
      {
        regenerate: () => {
          tileMap = buildMap(settings.wallDensity);
          refresh();
        },
      },
      'regenerate',
    )
    .name('Regenerate Map');

  const hint = document.createElement('p');
  hint.textContent =
    'Click to move player. Tune FOV radius and wall density. Green = player, lit tiles = visible.';
  hint.style.marginTop = '16px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';
  controls.appendChild(hint);

  refresh();

  return () => {
    canvas.remove();
    hint.remove();
  };
}

registerLab('fov-lab', {
  category: 'Movement & Physics',
  name: 'FOV Lab',
  description:
    'Visualize recursive shadowcasting FOV with interactive wall placement and radius tuning.',
  create: createFovLab,
});
