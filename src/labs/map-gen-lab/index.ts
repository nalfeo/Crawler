/**
 * Map Generation Lab — visualize procedural floor generation across biomes.
 *
 * Renders generated FloorMaps as a 2D tile canvas with color-coded terrain,
 * room overlays, door markers, and player spawn. Supports all registered
 * biome generators with real-time parameter tuning via lil-gui.
 */

import GUI from 'lil-gui';
import { getGenerator, getRegisteredBiomes } from '../../core/map/generators/registry.js';
import { BiomeType, TerrainType, TileFlags } from '../../shared/map-types.js';
import type { MapConfig } from '../../shared/map-types.js';
import type { FloorMap } from '../../core/map/FloorMap.js';
import { SeededRandom } from '../../shared/random.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';

const LAB_ID = 'map-gen-lab';

// Smaller grid for fast iteration in the lab
const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 60;
const CELL_SIZE = 8;

interface MapGenLabSettings {
  biome: string;
  seed: number;
  widthTiles: number;
  heightTiles: number;
  maxRooms: number;
  floorDensity: number;
  roomWidthMin: number;
  roomWidthMax: number;
  roomHeightMin: number;
  roomHeightMax: number;
  showRooms: boolean;
  showDoors: boolean;
  showSpawn: boolean;
}

const TERRAIN_COLORS: Record<number, string> = {
  [TerrainType.VOID]: '#0a0a0f',
  [TerrainType.STONE_FLOOR]: '#2d3748',
  [TerrainType.STONE_WALL]: '#4a5568',
  [TerrainType.DOOR]: '#ed8936',
  [TerrainType.CORRIDOR]: '#1e3a5f',
  [TerrainType.WATER]: '#2b6cb0',
  [TerrainType.LAVA]: '#c53030',
  [TerrainType.GRASS]: '#276749',
  [TerrainType.DIRT]: '#744210',
  [TerrainType.WOOD_FLOOR]: '#5a3e28',
  [TerrainType.WOOD_WALL]: '#3d2914',
  [TerrainType.CAVE_FLOOR]: '#3c3656',
  [TerrainType.CAVE_WALL]: '#553c75',
  [TerrainType.TREE]: '#1c5a2d',
  [TerrainType.RUBBLE]: '#4a3f35',
};

// Distinct colors for room overlays
const ROOM_COLORS = [
  'rgba(66, 153, 225, 0.25)',
  'rgba(72, 187, 120, 0.25)',
  'rgba(237, 137, 54, 0.25)',
  'rgba(159, 122, 234, 0.25)',
  'rgba(237, 100, 166, 0.25)',
  'rgba(56, 178, 172, 0.25)',
  'rgba(246, 224, 94, 0.25)',
  'rgba(245, 101, 101, 0.25)',
];

function createMapGenLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const savedState = loadLabState<MapGenLabSettings>(LAB_ID);
  const settings: MapGenLabSettings = {
    biome: BiomeType.DUNGEON,
    seed: 42,
    widthTiles: DEFAULT_WIDTH,
    heightTiles: DEFAULT_HEIGHT,
    maxRooms: 15,
    floorDensity: 0.45,
    roomWidthMin: 5,
    roomWidthMax: 12,
    roomHeightMin: 5,
    roomHeightMax: 12,
    showRooms: true,
    showDoors: true,
    showSpawn: true,
    ...savedState,
  };

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvas.style.imageRendering = 'pixelated';
  canvasHost.appendChild(canvas);

  const ctx = canvas.getContext('2d')!;

  // Stats display
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
  let genTimeMs = 0;

  function buildConfig(): MapConfig {
    return {
      widthTiles: settings.widthTiles,
      heightTiles: settings.heightTiles,
      tileSizePx: 32,
      biome: settings.biome as BiomeType,
      seed: settings.seed,
      roomWidthRange: [settings.roomWidthMin, settings.roomWidthMax] as const,
      roomHeightRange: [settings.roomHeightMin, settings.roomHeightMax] as const,
      maxRooms: settings.maxRooms,
      floorDensity: settings.floorDensity,
    };
  }

  function generate(): void {
    const config = buildConfig();
    const rng = new SeededRandom(config.seed);
    const generator = getGenerator(config.biome as BiomeType);

    const t0 = performance.now();
    currentMap = generator.generate(config, rng);
    genTimeMs = performance.now() - t0;

    render();
    updateStats();
    saveLabState(LAB_ID, settings);
  }

  function render(): void {
    if (!currentMap) return;

    const w = currentMap.width;
    const h = currentMap.height;
    canvas.width = w * CELL_SIZE;
    canvas.height = h * CELL_SIZE;

    // Draw terrain
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const terrainType = currentMap.terrain[idx] as number;
        ctx.fillStyle = TERRAIN_COLORS[terrainType] ?? '#0a0a0f';
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }

    // Draw room overlays
    if (settings.showRooms) {
      const rooms = currentMap.rooms;
      for (let i = 0; i < rooms.length; i++) {
        const room = rooms[i]!;
        const color = ROOM_COLORS[i % ROOM_COLORS.length]!;
        ctx.fillStyle = color;
        ctx.fillRect(
          room.bounds.x * CELL_SIZE,
          room.bounds.y * CELL_SIZE,
          room.bounds.width * CELL_SIZE,
          room.bounds.height * CELL_SIZE,
        );
        // Room number label
        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.font = `${Math.max(CELL_SIZE, 10)}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(
          `${i}`,
          (room.bounds.x + room.bounds.width / 2) * CELL_SIZE,
          (room.bounds.y + room.bounds.height / 2) * CELL_SIZE,
        );
      }
    }

    // Draw doors
    if (settings.showDoors) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (currentMap.flags[idx]! & TileFlags.DOOR) {
            ctx.fillStyle = '#ed8936';
            const inset = Math.max(1, CELL_SIZE / 4);
            ctx.fillRect(
              x * CELL_SIZE + inset,
              y * CELL_SIZE + inset,
              CELL_SIZE - inset * 2,
              CELL_SIZE - inset * 2,
            );
          }
        }
      }
    }

    // Draw player spawn
    if (settings.showSpawn) {
      const sp = currentMap.playerSpawn;
      ctx.fillStyle = '#48bb78';
      ctx.beginPath();
      ctx.arc(
        sp.x * CELL_SIZE + CELL_SIZE / 2,
        sp.y * CELL_SIZE + CELL_SIZE / 2,
        Math.max(CELL_SIZE / 2, 3),
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  function updateStats(): void {
    if (!currentMap) return;

    const w = currentMap.width;
    const h = currentMap.height;
    const totalTiles = w * h;

    // Count passable tiles
    let passable = 0;
    for (let i = 0; i < totalTiles; i++) {
      if (currentMap.flags[i]! & TileFlags.PASSABLE) passable++;
    }

    const rooms = currentMap.rooms;
    const floorPct = ((passable / totalTiles) * 100).toFixed(1);

    statsEl.textContent = [
      `Generator:    ${settings.biome}`,
      `Seed:         ${settings.seed}`,
      `Size:         ${w}×${h} (${totalTiles.toLocaleString()} tiles)`,
      `Passable:     ${passable.toLocaleString()} (${floorPct}%)`,
      `Rooms:        ${rooms.length}`,
      `Gen time:     ${genTimeMs.toFixed(1)} ms`,
      `Spawn:        (${currentMap.playerSpawn.x}, ${currentMap.playerSpawn.y})`,
    ].join('\n');
  }

  // --- GUI Controls ---

  const biomeOptions = Object.fromEntries(getRegisteredBiomes().map((b) => [b, b]));

  const genFolder = gui.addFolder('Generation');
  genFolder
    .add(settings, 'biome', biomeOptions)
    .name('Biome')
    .onChange(() => generate());
  genFolder
    .add(settings, 'seed', 1, 9999, 1)
    .name('Seed')
    .onChange(() => generate());
  genFolder
    .add(settings, 'widthTiles', 20, 200, 5)
    .name('Width')
    .onChange(() => generate());
  genFolder
    .add(settings, 'heightTiles', 20, 200, 5)
    .name('Height')
    .onChange(() => generate());

  const roomFolder = gui.addFolder('Rooms');
  roomFolder
    .add(settings, 'maxRooms', 3, 50, 1)
    .name('Max Rooms')
    .onChange(() => generate());
  roomFolder
    .add(settings, 'floorDensity', 0.1, 0.8, 0.05)
    .name('Floor Density')
    .onChange(() => generate());
  roomFolder
    .add(settings, 'roomWidthMin', 3, 20, 1)
    .name('Room W Min')
    .onChange(() => generate());
  roomFolder
    .add(settings, 'roomWidthMax', 5, 30, 1)
    .name('Room W Max')
    .onChange(() => generate());
  roomFolder
    .add(settings, 'roomHeightMin', 3, 20, 1)
    .name('Room H Min')
    .onChange(() => generate());
  roomFolder
    .add(settings, 'roomHeightMax', 5, 30, 1)
    .name('Room H Max')
    .onChange(() => generate());

  const displayFolder = gui.addFolder('Display');
  displayFolder
    .add(settings, 'showRooms')
    .name('Show Rooms')
    .onChange(() => render());
  displayFolder
    .add(settings, 'showDoors')
    .name('Show Doors')
    .onChange(() => render());
  displayFolder
    .add(settings, 'showSpawn')
    .name('Show Spawn')
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

  gui
    .add(
      {
        regenerate: () => generate(),
      },
      'regenerate',
    )
    .name('🔄 Regenerate');

  const hint = document.createElement('p');
  hint.textContent =
    'Adjust biome, seed, and room params to explore procedural generation. ' +
    'Room overlays show bounds with indices. Green dot = player spawn.';
  hint.style.marginTop = '16px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';
  controls.appendChild(hint);

  // Initial generation
  generate();

  return () => {
    canvas.remove();
    statsEl.remove();
    hint.remove();
  };
}

registerLab('map-gen-lab', {
  category: 'Movement & Physics',
  name: 'Map Generation Lab',
  description:
    'Procedural floor generation sandbox — visualize dungeon, cave, and arena layouts with tunable parameters.',
  create: createMapGenLab,
});
