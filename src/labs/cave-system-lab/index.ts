/**
 * Cave System Lab — Floor 2 CaveSystemGenerator visualisation.
 *
 * Seeded generation with role tints (territory palette, settlement gold,
 * resource-heart magenta, boss-den red outline), spawn marker, and a
 * reachability probe overlay. Uses a smaller map than the manifest
 * default (270x156) so iteration stays snappy.
 */

import GUI from 'lil-gui';
import { BiomeType, RoomRole, TerrainType, TileFlags } from '../../shared/map-types.js';
import type { MapConfig, RoomData } from '../../shared/map-types.js';
import { CaveSystemGenerator } from '../../core/map/generators/cave-system.js';
import type { FloorMap } from '../../core/map/FloorMap.js';
import { SeededRandom } from '../../shared/random.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

const LAB_ID = 'cave-system-lab';
const CELL_SIZE = 6;

interface CaveSystemLabSettings {
  seed: number;
  presentCount: number;
  widthTiles: number;
  heightTiles: number;
  showRoles: boolean;
  showReachability: boolean;
  showSpawn: boolean;
}

const TERRAIN_COLORS: Record<number, string> = {
  [TerrainType.VOID]: '#0a0a0f',
  [TerrainType.CAVE_FLOOR]: '#3c3656',
  [TerrainType.CAVE_WALL]: '#20182f',
  [TerrainType.STONE_FLOOR]: '#3d3548',
  [TerrainType.DOOR]: '#ed8936',
  [TerrainType.BOSS_STAIR_FLOOR]: '#7a3a8a',
};

// Territory tints per familyIndex (max 4).
const TERRITORY_COLORS = [
  'rgba(66, 153, 225, 0.30)',
  'rgba(72, 187, 120, 0.30)',
  'rgba(237, 137, 54, 0.30)',
  'rgba(159, 122, 234, 0.30)',
];

const ROLE_TINTS: Partial<Record<RoomRole, string>> = {
  [RoomRole.SETTLEMENT]: 'rgba(246, 224, 94, 0.35)',
  [RoomRole.RESOURCE_HEART]: 'rgba(236, 72, 153, 0.40)',
  [RoomRole.SPAWN]: 'rgba(255, 255, 255, 0.20)',
};

/**
 * Flood from spawn over passable tiles only (matches gameplay reachability).
 * Open doors are PASSABLE so they traverse; DOOR_CLOSED tiles carry the DOOR
 * flag WITHOUT PASSABLE and must block, so sealed regions (e.g. boss dens)
 * are correctly reported unreachable rather than flooded into.
 */
function floodFromSpawn(map: FloorMap): Uint8Array {
  const w = map.width;
  const h = map.height;
  const visited = new Uint8Array(w * h);
  const start = map.playerSpawn.y * w + map.playerSpawn.x;
  visited[start] = 1;
  const stack: number[] = [start];
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const cx = idx % w;
    const cy = (idx - cx) / w;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as ReadonlyArray<[number, number]>) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx]) continue;
      const flags = map.flags[nIdx]!;
      // Only walkable tiles propagate. DOOR_CLOSED sets DOOR without PASSABLE,
      // so checking PASSABLE alone treats closed doors as blocking (open doors
      // include PASSABLE and still traverse).
      if ((flags & TileFlags.PASSABLE) === 0) continue;
      visited[nIdx] = 1;
      stack.push(nIdx);
    }
  }
  return visited;
}

function createCaveSystemLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const saved = loadLabState<CaveSystemLabSettings>(LAB_ID);
  const settings: CaveSystemLabSettings = {
    seed: 1,
    presentCount: 4,
    widthTiles: 120,
    heightTiles: 80,
    showRoles: true,
    showReachability: true,
    showSpawn: true,
    ...saved,
  };

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvas.style.imageRendering = 'pixelated';
  canvasHost.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;

  const statsEl = document.createElement('pre');
  statsEl.style.marginTop = '12px';
  statsEl.style.padding = '12px';
  statsEl.style.background = 'rgba(8, 12, 24, 0.6)';
  statsEl.style.borderRadius = '8px';
  statsEl.style.color = '#c9d4ff';
  statsEl.style.fontSize = '12px';
  statsEl.style.fontFamily = 'monospace';
  statsEl.style.lineHeight = '1.6';
  canvasHost.appendChild(statsEl);

  let currentMap: FloorMap | null = null;
  let currentReachable: Uint8Array | null = null;
  let genTimeMs = 0;
  let genError: string | null = null;

  function buildConfig(): MapConfig {
    return {
      widthTiles: settings.widthTiles,
      heightTiles: settings.heightTiles,
      tileSizeFt: 4,
      biome: BiomeType.CAVE_SYSTEM,
      seed: settings.seed,
      roomWidthRange: [7, 16] as const,
      roomHeightRange: [6, 14] as const,
      maxRooms: 55,
      floorDensity: 0.45,
    };
  }

  function generate(): void {
    genError = null;
    currentMap = null;
    currentReachable = null;
    try {
      const cfg = buildConfig();
      const gen = new CaveSystemGenerator({ presentCount: settings.presentCount });
      const t0 = performance.now();
      currentMap = gen.generate(cfg, new SeededRandom(cfg.seed));
      genTimeMs = performance.now() - t0;
      currentReachable = floodFromSpawn(currentMap);
    } catch (err) {
      genError = (err as Error).message;
    }
    render();
    updateStats();
    saveLabState(LAB_ID, settings);
  }

  function render(): void {
    if (!currentMap) {
      canvas.width = 400;
      canvas.height = 60;
      ctx.fillStyle = '#0a0a0f';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#ff8080';
      ctx.font = '14px monospace';
      ctx.fillText(genError ? `Error: ${genError}` : 'No map yet - click Regenerate.', 12, 32);
      return;
    }
    const map = currentMap;
    const w = map.width;
    const h = map.height;
    canvas.width = w * CELL_SIZE;
    canvas.height = h * CELL_SIZE;

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const t = map.terrain[idx] as number;
        ctx.fillStyle = TERRAIN_COLORS[t] ?? '#0a0a0f';
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }

    if (settings.showReachability && currentReachable) {
      const reach = currentReachable;
      ctx.fillStyle = 'rgba(255, 0, 0, 0.35)';
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          const flags = map.flags[idx]!;
          const isFloor = (flags & TileFlags.PASSABLE) !== 0;
          if (isFloor && !reach[idx]) {
            ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
          }
        }
      }
    }

    if (settings.showRoles) {
      for (const room of map.rooms as readonly RoomData[]) {
        const bx = room.bounds.x * CELL_SIZE;
        const by = room.bounds.y * CELL_SIZE;
        const bw = room.bounds.width * CELL_SIZE;
        const bh = room.bounds.height * CELL_SIZE;

        if (room.role === RoomRole.TERRITORY) {
          const fi = room.familyIndex ?? 0;
          ctx.fillStyle = TERRITORY_COLORS[fi % TERRITORY_COLORS.length]!;
          ctx.fillRect(bx, by, bw, bh);
        } else if (room.role === RoomRole.BOSS_DEN) {
          const fi = room.familyIndex ?? 0;
          ctx.fillStyle = TERRITORY_COLORS[fi % TERRITORY_COLORS.length]!;
          ctx.fillRect(bx, by, bw, bh);
          ctx.strokeStyle = '#f56565';
          ctx.lineWidth = 2;
          ctx.strokeRect(bx + 1, by + 1, bw - 2, bh - 2);
        } else {
          const tint = ROLE_TINTS[room.role];
          if (tint) {
            ctx.fillStyle = tint;
            ctx.fillRect(bx, by, bw, bh);
          }
        }

        if (room.familyIndex !== undefined) {
          ctx.fillStyle = '#ffffff';
          ctx.font = `${Math.max(10, CELL_SIZE * 2)}px monospace`;
          ctx.fillText(`F${room.familyIndex}`, bx + 4, by + 14);
        }
      }
    }

    if (settings.showSpawn) {
      const sx = map.playerSpawn.x * CELL_SIZE + CELL_SIZE / 2;
      const sy = map.playerSpawn.y * CELL_SIZE + CELL_SIZE / 2;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sx, sy, Math.max(4, CELL_SIZE), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function updateStats(): void {
    if (!currentMap) {
      statsEl.textContent = genError ? `Generation failed: ${genError}` : 'No map generated yet.';
      return;
    }
    const rooms = currentMap.rooms;
    const roleCounts: Record<string, number> = {};
    for (const r of rooms) roleCounts[r.role] = (roleCounts[r.role] ?? 0) + 1;
    let passable = 0;
    let reached = 0;
    const total = currentMap.width * currentMap.height;
    for (let i = 0; i < total; i++) {
      if ((currentMap.flags[i]! & TileFlags.PASSABLE) !== 0) {
        passable++;
        if (currentReachable && currentReachable[i]) reached++;
      }
    }
    statsEl.textContent = [
      `Generator: CaveSystemGenerator  seed=${settings.seed}  presentCount=${settings.presentCount}`,
      `Dimensions: ${currentMap.width} x ${currentMap.height}   gen: ${genTimeMs.toFixed(1)}ms`,
      `Rooms: ${rooms.length}   Roles: ${JSON.stringify(roleCounts)}`,
      `Passable tiles: ${passable}/${total}   Reached: ${reached}/${passable}`,
      `Spawn: (${currentMap.playerSpawn.x}, ${currentMap.playerSpawn.y})`,
    ].join('\n');
  }

  const folder = gui.addFolder('Cave System');
  folder
    .add(settings, 'seed', 0, 99999, 1)
    .name('seed')
    .onChange(() => generate());
  folder
    .add(settings, 'presentCount', [3, 4])
    .name('present families')
    .onChange((v: number) => {
      settings.presentCount = Number(v);
      generate();
    });
  folder
    .add(settings, 'widthTiles', 60, 270, 10)
    .name('width')
    .onChange(() => generate());
  folder
    .add(settings, 'heightTiles', 40, 200, 10)
    .name('height')
    .onChange(() => generate());
  folder.add(settings, 'showRoles').name('role tints').onChange(render);
  folder.add(settings, 'showReachability').name('reachability probe').onChange(render);
  folder.add(settings, 'showSpawn').name('spawn marker').onChange(render);
  folder
    .add(
      {
        regenerate: () => {
          generate();
        },
      },
      'regenerate',
    )
    .name('regenerate');

  generate();

  return () => {
    folder.destroy();
    canvasHost.innerHTML = '';
  };
}

registerLab(LAB_ID, {
  name: 'Cave System',
  description:
    'Floor 2 CaveSystemGenerator: family territories, sealed boss dens, settlement, resource heart. Toggle role tints and reachability overlay; scrub seed / presentCount.',
  category: 'Meta',
  create: createCaveSystemLab,
});
