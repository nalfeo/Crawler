import type GUI from 'lil-gui';
import { query } from 'bitecs';
import { Enemy } from '../../core/components.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import { spawnPlayer } from '../../core/spawners/combatants.js';
import { createGameWorld } from '../../core/world.js';
import { attackWaveSystem } from '../../game/attack-wave-system.js';
import { BiomeType, RoomRole, TilePresets, type MapConfig } from '../../shared/map-types.js';
import tuning from '../../shared/data/tuning.json';
import { registerLab, type LabCategory } from '../registry.js';

type ControlsWithGui = HTMLElement & { __labGui?: GUI };
type TuningSchema = typeof tuning & { attackWaves: { intervalMs: number } };
const TUNING = tuning as TuningSchema;

function makeLabMap(): FloorMap {
  const widthTiles = 120;
  const heightTiles = 120;
  const config: MapConfig = {
    widthTiles,
    heightTiles,
    tileSizeFt: 4,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [6, 10],
    roomHeightRange: [6, 10],
    maxRooms: 6,
    floorDensity: 1,
  };
  const tileMap = new TileMap(widthTiles, heightTiles);
  tileMap.fill(TilePresets.FLOOR);
  const graph = new RoomGraph();
  graph.add({ x: 16, y: 16, width: 6, height: 6 }, [], [], RoomRole.SAFE);
  return new FloorMap(config, tileMap, graph, new Uint8Array(widthTiles * heightTiles), {
    x: 20,
    y: 20,
  });
}

function createAttackWaveLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as ControlsWithGui).__labGui;
  if (!gui) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.placeItems = 'center';
  root.style.height = '100%';
  root.style.padding = '24px';
  root.style.background = 'radial-gradient(circle at top, #3b1f1f 0%, #221212 60%, #140909 100%)';

  const card = document.createElement('div');
  card.style.maxWidth = '720px';
  card.style.padding = '20px';
  card.style.border = '1px solid rgba(255, 255, 255, 0.12)';
  card.style.borderRadius = '14px';
  card.style.background = 'rgba(24, 10, 10, 0.86)';
  card.style.color = '#fee2e2';
  card.style.lineHeight = '1.6';

  const world = createGameWorld({ seed: 42 });
  world.floorId = 'floor1';
  world.floorMap = makeLabMap();
  world.attackWaveFlags.attackWaves = true;
  const player = spawnPlayer(world, 20 * 4 + 2, 20 * 4 + 2);
  world.elapsedMs = TUNING.attackWaves.intervalMs;

  const update = (label: string): void => {
    const enemies = query(world.ecs, [Enemy]).length;
    const nextWaveAtMs = world.attackWaveState?.nextWaveAtMs ?? -1;
    card.textContent =
      `Attack Wave Lab\n\n${label}\n` +
      `elapsedMs=${world.elapsedMs}\nnextWaveAtMs=${nextWaveAtMs}\n` +
      `enemyCount=${enemies}\nplayerInSafeRoom=${world.playerInSafeRoom}`;
  };

  const api = {
    spawnWaveUnsafe: () => {
      world.playerInSafeRoom = false;
      world.stores.position.x[player] = 80 * 4 + 2;
      world.stores.position.y[player] = 80 * 4 + 2;
      world.elapsedMs = Math.max(world.elapsedMs, world.attackWaveState?.nextWaveAtMs ?? 0);
      attackWaveSystem(world);
      update('Wave attempted with player away from safe room.');
    },
    suppressInSafeRoom: () => {
      world.playerInSafeRoom = true;
      world.elapsedMs = Math.max(world.elapsedMs, world.attackWaveState?.nextWaveAtMs ?? 0);
      attackWaveSystem(world);
      update('Wave attempted while playerInSafeRoom=true (should suppress).');
    },
    reset: () => {
      world.attackWaveState = undefined;
      world.playerInSafeRoom = false;
      world.elapsedMs = TUNING.attackWaves.intervalMs;
      update('Reset world state.');
    },
  };

  gui.add(api, 'spawnWaveUnsafe').name('Spawn wave (unsafe)');
  gui.add(api, 'suppressInSafeRoom').name('Attempt while safe');
  gui.add(api, 'reset').name('Reset');

  update('Ready.');
  root.append(card);
  canvasHost.append(root);

  return () => {
    root.remove();
  };
}

registerLab('attack-wave-lab', {
  category: 'Combat' as LabCategory,
  name: 'Attack Wave Lab',
  description: 'Feature-flagged rat wave sandbox with safe-room suppression toggles.',
  create: createAttackWaveLab,
});
