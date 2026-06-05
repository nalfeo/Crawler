/**
 * Door Lab — test door open/close mechanics with tile flag updates.
 *
 * Renders a small room with doors. Click doors to toggle open/close.
 * Visualizes passability and transparency changes in real time.
 */

import GUI from 'lil-gui';
import { FOV } from 'rot-js';
import { TileMap } from '../../core/map/TileMap.js';
import { TilePresets } from '../../shared/map-types.js';
import { registerLab } from '../registry.js';

const GRID_W = 20;
const GRID_H = 15;
const CELL_SIZE = 30;

function createDoorLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const canvas = document.createElement('canvas');
  canvas.width = GRID_W * CELL_SIZE;
  canvas.height = GRID_H * CELL_SIZE;
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvas.style.cursor = 'pointer';
  canvasHost.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;
  const tileMap = new TileMap(GRID_W, GRID_H);
  const doorPositions: Array<{ x: number; y: number }> = [];
  let playerX = 5;
  let playerY = 7;

  // Build two rooms with a door between them
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      const idx = y * GRID_W + x;
      if (x === 0 || x === GRID_W - 1 || y === 0 || y === GRID_H - 1) {
        tileMap.flags[idx] = TilePresets.WALL;
      } else if (x === 10 && y !== 7) {
        // Dividing wall with gap for door
        tileMap.flags[idx] = TilePresets.WALL;
      } else if (x === 10 && y === 7) {
        // Door
        tileMap.flags[idx] = TilePresets.DOOR_CLOSED;
        doorPositions.push({ x, y });
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
      }
    }
  }

  // Add a second door at (5, 4)
  tileMap.flags[4 * GRID_W + 5] = TilePresets.WALL;
  tileMap.flags[4 * GRID_W + 6] = TilePresets.WALL;
  tileMap.flags[4 * GRID_W + 7] = TilePresets.WALL;
  // Horizontal wall with door
  for (let x = 3; x <= 8; x++) {
    if (x === 5) {
      tileMap.flags[4 * GRID_W + x] = TilePresets.DOOR_CLOSED;
      doorPositions.push({ x, y: 4 });
    } else {
      tileMap.flags[4 * GRID_W + x] = TilePresets.WALL;
    }
  }

  function computeVisibility(): Uint8Array {
    const vis = new Uint8Array(GRID_W * GRID_H);
    const lightPasses = tileMap.createLightPassesCallback();
    const fov = new FOV.RecursiveShadowcasting(lightPasses);
    fov.compute(playerX, playerY, 15, (x, y, _r, v) => {
      if (v > 0 && x >= 0 && x < GRID_W && y >= 0 && y < GRID_H) {
        vis[y * GRID_W + x] = 1;
      }
    });
    return vis;
  }

  function render(): void {
    const vis = computeVisibility();
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const idx = y * GRID_W + x;
        const isVisible = vis[idx] === 1;
        const isDoor = tileMap.isDoor(x, y);
        const isPassable = tileMap.isPassable(x, y);
        const isWall = !isPassable && !isDoor;

        let color: string;
        if (isDoor && isPassable) {
          color = isVisible ? '#68d391' : '#276749'; // open door - green
        } else if (isDoor) {
          color = isVisible ? '#ed8936' : '#744210'; // closed door - orange
        } else if (isWall) {
          color = isVisible ? '#4a5568' : '#1a202c'; // wall
        } else {
          color = isVisible ? '#2d3748' : '#0d1117'; // floor
        }

        ctx.fillStyle = color;
        ctx.fillRect(x * CELL_SIZE + 1, y * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2);

        // Door icon
        if (isDoor) {
          ctx.fillStyle = isVisible ? '#fff' : '#666';
          ctx.font = `${CELL_SIZE * 0.5}px monospace`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(isPassable ? '▪' : '▫', x * CELL_SIZE + CELL_SIZE / 2, y * CELL_SIZE + CELL_SIZE / 2);
        }
      }
    }

    // Player
    ctx.fillStyle = '#48bb78';
    ctx.beginPath();
    ctx.arc(
      playerX * CELL_SIZE + CELL_SIZE / 2,
      playerY * CELL_SIZE + CELL_SIZE / 2,
      CELL_SIZE / 3,
      0,
      Math.PI * 2,
    );
    ctx.fill();
  }

  // Click handler: toggle doors, move player on floor tiles
  canvas.addEventListener('click', (e) => {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) / CELL_SIZE);
    const y = Math.floor((e.clientY - rect.top) / CELL_SIZE);
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;

    if (tileMap.isDoor(x, y)) {
      if (tileMap.isPassable(x, y)) {
        tileMap.closeDoor(x, y);
      } else {
        tileMap.openDoor(x, y);
      }
    } else if (tileMap.isPassable(x, y)) {
      playerX = x;
      playerY = y;
    }
    render();
  });

  gui.add({ closeAll: () => {
    for (const d of doorPositions) tileMap.closeDoor(d.x, d.y);
    render();
  }}, 'closeAll').name('Close All Doors');

  gui.add({ openAll: () => {
    for (const d of doorPositions) tileMap.openDoor(d.x, d.y);
    render();
  }}, 'openAll').name('Open All Doors');

  const hint = document.createElement('p');
  hint.textContent = 'Click doors (orange) to toggle. Click floor to move player. Watch LOS change through doors.';
  hint.style.marginTop = '16px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';
  controls.appendChild(hint);

  render();

  return () => {
    canvas.remove();
    hint.remove();
  };
}

registerLab('door-lab', {
  category: 'Movement & Physics',
  name: 'Door Lab',
  description: 'Interactive door toggle with real-time FOV/LOS visualization through open and closed doors.',
  create: createDoorLab,
});
