import { addComponent, addEntity, set, setComponent } from 'bitecs';
import GUI from 'lil-gui';
import { DoorState, Position } from '../../core/components.js';
import {
  createGameWorld,
  doorSystem,
  movementSystem,
  spawnBehaviorEnemy,
  spawnPlayer,
} from '../../core/index.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import { enemyAISystem, AI_TYPE, PATH_PERSONA, TRAVERSAL_MODE } from '../../game/index.js';
import { BiomeType, TileFlags, TilePresets, type MapConfig } from '../../shared/map-types.js';
import { registerLab } from '../registry.js';

const LAB_ID = 'pathfinding-lab';
const CELL_SIZE = 24;
const MAP_W = 24;
const MAP_H = 16;
const FIXED_DELTA_MS = 16;
const MAX_STEPS_PER_FRAME = 4;
const PLAYER_START = { x: 19, y: 8 };
const ENEMY_START = { x: 4, y: 8 };
const DOOR_TILE = { x: 11, y: 8 };

function createLabMap(doorOpen: boolean): FloorMap {
  const tileMap = new TileMap(MAP_W, MAP_H);
  const terrain = new Uint8Array(MAP_W * MAP_H);
  const config: MapConfig = {
    widthTiles: MAP_W,
    heightTiles: MAP_H,
    tileSizePx: CELL_SIZE,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  for (let y = 0; y < MAP_H; y += 1) {
    for (let x = 0; x < MAP_W; x += 1) {
      const idx = y * MAP_W + x;
      const isBorder = x === 0 || y === 0 || x === MAP_W - 1 || y === MAP_H - 1;
      const centerWall = x === 11 && y >= 1 && y <= MAP_H - 2 && y !== DOOR_TILE.y;
      const leftPillar = x === 7 && y >= 5 && y <= 10;
      const rightPillar = x === 15 && y >= 4 && y <= 11;
      tileMap.flags[idx] =
        isBorder || centerWall || leftPillar || rightPillar ? TilePresets.WALL : TilePresets.FLOOR;
    }
  }

  tileMap.flags[DOOR_TILE.y * MAP_W + DOOR_TILE.x] = doorOpen
    ? TilePresets.DOOR_OPEN
    : TilePresets.DOOR_CLOSED;
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, {
    x: PLAYER_START.x,
    y: PLAYER_START.y,
  });
}

function tileCenter(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * CELL_SIZE + CELL_SIZE / 2, y: tileY * CELL_SIZE + CELL_SIZE / 2 };
}

function createPathfindingLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const root = document.createElement('div');
  root.style.display = 'grid';
  root.style.gap = '12px';
  const canvas = document.createElement('canvas');
  canvas.width = MAP_W * CELL_SIZE;
  canvas.height = MAP_H * CELL_SIZE;
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvas.style.cursor = 'crosshair';
  canvas.style.border = '1px solid rgba(255,255,255,0.15)';

  const info = document.createElement('pre');
  info.style.margin = '0';
  info.style.padding = '12px';
  info.style.background = 'rgba(5, 10, 24, 0.65)';
  info.style.borderRadius = '8px';
  info.style.color = '#d6e4ff';
  info.style.fontSize = '12px';
  info.style.lineHeight = '1.5';

  root.append(canvas, info);
  canvasHost.append(root);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context could not be created.');
  }
  const renderCtx = ctx;

  let world = createGameWorld({ seed: 1337 });
  let playerEid = -1;
  let doorEid = -1;
  let doorOpen = true;
  let accumulator = 0;
  let rafId = 0;
  let lastTimestamp = 0;
  let mobEids: number[] = [];

  function resetWorld(): void {
    world = createGameWorld({ seed: 1337 });
    world.floorMap = createLabMap(doorOpen);

    const playerPos = tileCenter(PLAYER_START.x, PLAYER_START.y);
    playerEid = spawnPlayer(world, playerPos.x, playerPos.y);

    doorEid = addEntity(world.ecs);
    addComponent(
      world.ecs,
      doorEid,
      set(DoorState, { tileX: DOOR_TILE.x, tileY: DOOR_TILE.y, isOpen: doorOpen ? 1 : 0 }),
    );

    const start = tileCenter(ENEMY_START.x, ENEMY_START.y);
    mobEids = [
      spawnBehaviorEnemy(world, start.x, start.y - 18, 20, AI_TYPE.CHASE, 1.8, 999, 0, {
        persona: PATH_PERSONA.STUPID,
      }),
      spawnBehaviorEnemy(world, start.x, start.y + 18, 20, AI_TYPE.CHASE, 1.8, 999, 0, {
        persona: PATH_PERSONA.NAVIGATOR,
      }),
      spawnBehaviorEnemy(world, start.x - 10, start.y, 20, AI_TYPE.CHASE, 1.8, 999, 0, {
        persona: PATH_PERSONA.FLANKER,
        flankDistance: 120,
      }),
      spawnBehaviorEnemy(world, start.x - 20, start.y - 28, 20, AI_TYPE.CHASE, 1.8, 999, 0, {
        persona: PATH_PERSONA.NAVIGATOR,
        traversalMode: TRAVERSAL_MODE.FLYING,
        isFlying: true,
      }),
    ];
  }

  function setDoorState(open: boolean): void {
    doorOpen = open;
    setComponent(world.ecs, doorEid, DoorState, {
      tileX: DOOR_TILE.x,
      tileY: DOOR_TILE.y,
      isOpen: doorOpen ? 1 : 0,
    });
  }

  function draw(): void {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return;
    }

    renderCtx.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < MAP_H; y += 1) {
      for (let x = 0; x < MAP_W; x += 1) {
        const idx = y * MAP_W + x;
        const flags = floorMap.flags[idx] ?? 0;
        const isDoor = (flags & TileFlags.DOOR) !== 0;
        const isPassable = (flags & TileFlags.PASSABLE) !== 0;

        if (isDoor && isPassable) {
          renderCtx.fillStyle = '#38a169';
        } else if (isDoor) {
          renderCtx.fillStyle = '#dd6b20';
        } else if (!isPassable) {
          renderCtx.fillStyle = '#2d3748';
        } else {
          renderCtx.fillStyle = '#0f172a';
        }

        renderCtx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        renderCtx.strokeStyle = 'rgba(255,255,255,0.05)';
        renderCtx.strokeRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }

    const playerX = world.stores.position.x[playerEid] ?? 0;
    const playerY = world.stores.position.y[playerEid] ?? 0;
    renderCtx.fillStyle = '#f6e05e';
    renderCtx.beginPath();
    renderCtx.arc(playerX, playerY, 7, 0, Math.PI * 2);
    renderCtx.fill();

    const mobLabels = ['Stupid', 'Navigator', 'Flanker', 'Flying'];
    const mobColors = ['#e53e3e', '#4299e1', '#9f7aea', '#22d3ee'];
    for (let i = 0; i < mobEids.length; i += 1) {
      const eid = mobEids[i]!;
      const x = world.stores.position.x[eid] ?? 0;
      const y = world.stores.position.y[eid] ?? 0;
      renderCtx.fillStyle = mobColors[i] ?? '#ffffff';
      renderCtx.beginPath();
      renderCtx.arc(x, y, 6, 0, Math.PI * 2);
      renderCtx.fill();
      renderCtx.fillStyle = '#e2e8f0';
      renderCtx.font = '10px monospace';
      renderCtx.textAlign = 'center';
      renderCtx.fillText(mobLabels[i] ?? '', x, y - 10);
    }

    info.textContent = [
      'Click a passable tile to move the player target.',
      `Door: ${doorOpen ? 'open' : 'closed'}`,
      'Red = stupid direct steering (gets stuck)',
      'Blue = navigator pathfinding',
      'Purple = flanker pathfinding',
      'Cyan = flying navigator (crosses blocked structures)',
    ].join('\n');
  }

  function stepSimulation(frameDelta: number): void {
    accumulator += frameDelta;
    let steps = 0;
    while (accumulator >= FIXED_DELTA_MS && steps < MAX_STEPS_PER_FRAME) {
      world.frameCount += 1;
      world.elapsedMs += FIXED_DELTA_MS;
      doorSystem(world);
      enemyAISystem(world);
      movementSystem(world);
      accumulator -= FIXED_DELTA_MS;
      steps += 1;
    }

    if (accumulator > FIXED_DELTA_MS * MAX_STEPS_PER_FRAME) {
      accumulator = 0;
    }
  }

  function loop(timestamp: number): void {
    const frameDelta =
      lastTimestamp === 0 ? FIXED_DELTA_MS : Math.min(100, timestamp - lastTimestamp);
    lastTimestamp = timestamp;
    stepSimulation(frameDelta);
    draw();
    rafId = requestAnimationFrame(loop);
  }

  const controlsApi = {
    reset: () => resetWorld(),
    toggleDoor: () => setDoorState(!doorOpen),
    openDoor: () => setDoorState(true),
    closeDoor: () => setDoorState(false),
  };

  gui.add(controlsApi, 'toggleDoor').name('Toggle Door');
  gui.add(controlsApi, 'openDoor').name('Open Door');
  gui.add(controlsApi, 'closeDoor').name('Close Door');
  gui.add(controlsApi, 'reset').name('Reset Scenario');

  canvas.addEventListener('click', (event) => {
    if (!world.floorMap) {
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((event.clientX - rect.left) / CELL_SIZE);
    const y = Math.floor((event.clientY - rect.top) / CELL_SIZE);
    if (!world.floorMap.tileMap.isPassable(x, y)) {
      return;
    }
    const center = tileCenter(x, y);
    setComponent(world.ecs, playerEid, Position, { x: center.x, y: center.y });
  });

  resetWorld();
  draw();
  rafId = requestAnimationFrame(loop);

  return () => {
    cancelAnimationFrame(rafId);
    root.remove();
  };
}

registerLab(LAB_ID, {
  category: 'Movement & Physics',
  name: 'Pathfinding Lab',
  description:
    'Compares stupid, navigator, flanker, and flying mob pathing through doors and around pillars.',
  create: createPathfindingLab,
});
