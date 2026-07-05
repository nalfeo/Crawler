import GUI from 'lil-gui';
import { createGameWorld } from '../../core/world.js';
import { spawnPlayer } from '../../core/helpers.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import { TilePresets, BiomeType } from '../../shared/map-types.js';
import {
  attachBarriersToFloorMap,
  createRingBarrier,
  createRoomBarrier,
  createPolyBarrier,
  dropBarrier,
} from '../../core/barriers/index.js';
import { registerLab } from '../registry.js';
import type { GameWorld } from '../../core/world.js';
import type { MapConfig } from '../../shared/map-types.js';
import type { BarrierHandle, BarrierKind } from '../../core/barriers/index.js';

/**
 * Barrier lab — interactive playground for the dynamic barrier primitive.
 *
 * Renders the tile grid, the player, and every active barrier tile so you
 * can see exactly which cells are impenetrable at any moment. Uses the
 * canonical primitives (createRingBarrier / createRoomBarrier /
 * createPolyBarrier / dropBarrier) and reads state exclusively from
 * `world.barriers`, so a bug in the primitive is visible here.
 */

const GRID_W = 20;
const GRID_H = 14;
const CELL_SIZE = 28;

interface LabSettings {
  ringCx: number;
  ringCy: number;
  ringRadius: number;
  ringKind: BarrierKind;
  polyDrawing: boolean;
}

const KIND_COLOR: Record<BarrierKind, string> = {
  fence: '#38bdf8',
  forcefield: '#a855f7',
  wall: '#f97316',
};

function buildLabMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: GRID_W,
    heightTiles: GRID_H,
    tileSizeFt: CELL_SIZE,
    biome: BiomeType.DUNGEON,
    seed: 7,
    roomWidthRange: [5, 8],
    roomHeightRange: [5, 8],
    maxRooms: 2,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(GRID_W, GRID_H);
  const terrain = new Uint8Array(GRID_W * GRID_H);
  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      const idx = y * GRID_W + x;
      const isBorder = x === 0 || x === GRID_W - 1 || y === 0 || y === GRID_H - 1;
      tileMap.flags[idx] = isBorder ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 4, y: 4 });
}

function createBarrierLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: LabSettings = {
    ringCx: 10,
    ringCy: 7,
    ringRadius: 3,
    ringKind: 'fence',
    polyDrawing: false,
  };

  const canvas = document.createElement('canvas');
  canvas.width = GRID_W * CELL_SIZE;
  canvas.height = GRID_H * CELL_SIZE;
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvasHost.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context could not be created.');
  const g = ctx;

  const status = document.createElement('pre');
  status.style.cssText =
    'margin:12px 0 0;padding:12px;background:rgba(5,10,24,0.6);border-radius:8px;color:#c9d4ff;font-size:12px;line-height:1.5;';
  controls.appendChild(status);

  const world: GameWorld = createGameWorld({ seed: 7 });
  world.floorMap = buildLabMap();
  attachBarriersToFloorMap(world);
  const spawn = world.floorMap.tileToWorld(3, 3);
  const player = spawnPlayer(world, spawn.x, spawn.y);
  const handles: BarrierHandle[] = [];
  const polyTiles: number[] = [];

  function tileCenterFt(tx: number, ty: number): { x: number; y: number } {
    return {
      x: (tx + 0.5) * CELL_SIZE,
      y: (ty + 0.5) * CELL_SIZE,
    };
  }

  function render(): void {
    const floorMap = world.floorMap!;
    g.clearRect(0, 0, canvas.width, canvas.height);
    for (let y = 0; y < GRID_H; y += 1) {
      for (let x = 0; x < GRID_W; x += 1) {
        const passable = floorMap.tileMap.isPassable(x, y);
        g.fillStyle = passable ? '#1f2937' : '#0f172a';
        g.fillRect(x * CELL_SIZE + 1, y * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      }
    }
    for (const idx of world.barriers.blockedTiles) {
      const tx = idx % floorMap.tileMap.width;
      const ty = Math.floor(idx / floorMap.tileMap.width);
      let kind: BarrierKind = 'fence';
      for (const h of world.barriers.barriers.values()) {
        if (h.tiles.includes(idx)) {
          kind = h.kind;
          break;
        }
      }
      g.fillStyle = KIND_COLOR[kind];
      g.globalAlpha = 0.55;
      g.fillRect(tx * CELL_SIZE + 2, ty * CELL_SIZE + 2, CELL_SIZE - 4, CELL_SIZE - 4);
      g.globalAlpha = 1;
    }
    if (settings.polyDrawing) {
      for (const idx of polyTiles) {
        const tx = idx % floorMap.tileMap.width;
        const ty = Math.floor(idx / floorMap.tileMap.width);
        g.strokeStyle = '#facc15';
        g.lineWidth = 2;
        g.strokeRect(tx * CELL_SIZE + 3, ty * CELL_SIZE + 3, CELL_SIZE - 6, CELL_SIZE - 6);
      }
    }
    const px = world.stores.position.x[player] ?? 0;
    const py = world.stores.position.y[player] ?? 0;
    g.fillStyle = '#22c55e';
    g.beginPath();
    g.arc(px, py, CELL_SIZE * 0.28, 0, Math.PI * 2);
    g.fill();

    status.textContent = [
      `Barrier lab`,
      `active barriers: ${world.barriers.barriers.size}`,
      `blocked tiles:   ${world.barriers.blockedTiles.size}`,
      `registry.version: ${world.barriers.version}`,
      `poly draft: ${settings.polyDrawing ? polyTiles.length : 'off'}`,
    ].join('\n');
  }

  canvas.addEventListener('click', (ev) => {
    if (!settings.polyDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const tx = Math.floor(((ev.clientX - rect.left) * (canvas.width / rect.width)) / CELL_SIZE);
    const ty = Math.floor(((ev.clientY - rect.top) * (canvas.height / rect.height)) / CELL_SIZE);
    if (tx < 0 || tx >= GRID_W || ty < 0 || ty >= GRID_H) return;
    const idx = ty * GRID_W + tx;
    const existing = polyTiles.indexOf(idx);
    if (existing >= 0) {
      polyTiles.splice(existing, 1);
    } else {
      polyTiles.push(idx);
    }
    render();
  });

  gui.add(settings, 'ringCx', 1, GRID_W - 2, 1).name('Ring center X');
  gui.add(settings, 'ringCy', 1, GRID_H - 2, 1).name('Ring center Y');
  gui.add(settings, 'ringRadius', 1, 6, 1).name('Ring radius (tiles)');
  gui.add(settings, 'ringKind', ['fence', 'forcefield', 'wall']).name('Ring kind');

  gui
    .add(
      {
        createRing: () => {
          const c = tileCenterFt(settings.ringCx, settings.ringCy);
          const handle = createRingBarrier(
            world,
            c.x,
            c.y,
            settings.ringRadius * CELL_SIZE,
            settings.ringKind,
          );
          handles.push(handle);
          render();
        },
      },
      'createRing',
    )
    .name('Create ring barrier');

  gui
    .add(
      {
        createDoorwayRoom: () => {
          const roomId = world.floorMap!.roomGraph.getRoomAt(settings.ringCx, settings.ringCy);
          if (roomId < 0) {
            status.textContent = 'No room at ring center — nothing to barrier.';
            return;
          }
          const handle = createRoomBarrier(world, roomId, 'fence', { doorwaysOnly: true });
          handles.push(handle);
          render();
        },
      },
      'createDoorwayRoom',
    )
    .name('Create doorway barrier');

  gui.add(settings, 'polyDrawing').name('Poly draft mode');

  gui
    .add(
      {
        commitPoly: () => {
          if (polyTiles.length === 0) return;
          const handle = createPolyBarrier(world, polyTiles.slice(), settings.ringKind);
          handles.push(handle);
          polyTiles.length = 0;
          settings.polyDrawing = false;
          gui.controllersRecursive().forEach((c) => c.updateDisplay());
          render();
        },
      },
      'commitPoly',
    )
    .name('Commit poly barrier');

  gui
    .add(
      {
        dropAll: () => {
          for (const h of handles) dropBarrier(world, h);
          handles.length = 0;
          polyTiles.length = 0;
          render();
        },
      },
      'dropAll',
    )
    .name('Drop all barriers');

  const hint = document.createElement('p');
  hint.innerHTML =
    'Ring barriers cage a disc regardless of underlying passability. Doorway barriers plug every doorway in a room (belt-and-suspenders alongside door locks). Poly barriers accept any tile set (turn on <em>Poly draft mode</em> and click tiles).';
  hint.style.marginTop = '12px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';
  controls.appendChild(hint);

  render();

  return () => {
    for (const h of handles) dropBarrier(world, h);
    canvas.remove();
    status.remove();
    hint.remove();
  };
}

registerLab('barrier-lab', {
  category: 'Movement & Physics',
  name: 'Barrier Lab',
  description:
    'Interactive playground for the dynamic barrier primitive (ring / doorway / poly barriers).',
  create: createBarrierLab,
});
