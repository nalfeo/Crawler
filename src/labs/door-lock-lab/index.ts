import GUI from 'lil-gui';
import { addComponent, addEntity, set } from 'bitecs';
import { createGameWorld } from '../../core/world.js';
import { DoorState } from '../../core/components.js';
import { spawnPlayer } from '../../core/helpers.js';
import { doorSystem } from '../../core/systems/doorSystem.js';
import { setDoorLockConfig, setGoalFlag } from '../../core/door-lock.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import { TilePresets, BiomeType } from '../../shared/map-types.js';
import { addItem, createInventoryBag } from '../../shared/inventory.js';
import { registerLab } from '../registry.js';
import type { GameWorld } from '../../core/world.js';
import type { DoorLockCondition, DoorConditionOperator } from '../../core/door-lock.js';
import type { MapConfig } from '../../shared/map-types.js';

const GRID_W = 12;
const GRID_H = 8;
const CELL_SIZE = 44;
const DOOR_X = 6;
const DOOR_Y = 4;
const KEY_ITEM_ID = 'floor-key-bronze';
const UNLOCK_GOAL_ID = 'lab.unlock.goal';
const RELOCK_GOAL_ID = 'lab.relock.goal';

type UnlockPreset = 'inventory' | 'goal' | 'timer' | 'mixed-all' | 'mixed-any';
type RelockPreset = 'goal' | 'timer' | 'mixed';

interface LabSettings {
  unlockPreset: UnlockPreset;
  unlockOperator: DoorConditionOperator;
  keyPresent: boolean;
  keyQuantity: number;
  goalComplete: boolean;
  unlockTimerMs: number;
  elapsedMs: number;
  useRelock: boolean;
  relockPreset: RelockPreset;
  relockOperator: DoorConditionOperator;
  relockGoalComplete: boolean;
  relockTimerMs: number;
}

function buildLabMap(): FloorMap {
  const config: MapConfig = {
    widthTiles: GRID_W,
    heightTiles: GRID_H,
    tileSizeFt: CELL_SIZE,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [4, 7],
    roomHeightRange: [4, 7],
    maxRooms: 2,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(GRID_W, GRID_H);
  const terrain = new Uint8Array(GRID_W * GRID_H);

  for (let y = 0; y < GRID_H; y += 1) {
    for (let x = 0; x < GRID_W; x += 1) {
      const idx = y * GRID_W + x;
      if (x === 0 || x === GRID_W - 1 || y === 0 || y === GRID_H - 1) {
        tileMap.flags[idx] = TilePresets.WALL;
      } else if (x === DOOR_X && y !== DOOR_Y) {
        tileMap.flags[idx] = TilePresets.WALL;
      } else {
        tileMap.flags[idx] = TilePresets.FLOOR;
      }
    }
  }

  tileMap.flags[DOOR_Y * GRID_W + DOOR_X] = TilePresets.DOOR_CLOSED;
  return new FloorMap(config, tileMap, new RoomGraph(), terrain, { x: 3, y: 4 });
}

function createDoorLockLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const settings: LabSettings = {
    unlockPreset: 'inventory',
    unlockOperator: 'all',
    keyPresent: false,
    keyQuantity: 1,
    goalComplete: false,
    unlockTimerMs: 1200,
    elapsedMs: 0,
    useRelock: false,
    relockPreset: 'timer',
    relockOperator: 'all',
    relockGoalComplete: false,
    relockTimerMs: 2400,
  };

  const canvas = document.createElement('canvas');
  canvas.width = GRID_W * CELL_SIZE;
  canvas.height = GRID_H * CELL_SIZE;
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvasHost.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas context could not be created.');
  }
  const renderCtx = ctx;

  const status = document.createElement('pre');
  status.style.cssText =
    'margin:12px 0 0;padding:12px;background:rgba(5,10,24,0.6);border-radius:8px;color:#c9d4ff;font-size:12px;line-height:1.5;';
  controls.appendChild(status);

  let world: GameWorld = createGameWorld({ seed: 42 });
  let player = -1;
  let door = -1;

  function buildUnlockConditions(): DoorLockCondition[] {
    const inventoryCondition: DoorLockCondition = {
      type: 'inventory',
      itemId: KEY_ITEM_ID,
      quantity: Math.max(1, Math.floor(settings.keyQuantity)),
      holderEid: player,
    };
    const goalCondition: DoorLockCondition = {
      type: 'goal',
      goalId: UNLOCK_GOAL_ID,
    };
    const timerCondition: DoorLockCondition = {
      type: 'timer',
      elapsedMs: Math.max(0, Math.floor(settings.unlockTimerMs)),
    };

    switch (settings.unlockPreset) {
      case 'inventory':
        return [inventoryCondition];
      case 'goal':
        return [goalCondition];
      case 'timer':
        return [timerCondition];
      case 'mixed-all':
      case 'mixed-any':
        return [inventoryCondition, goalCondition, timerCondition];
      default: {
        const unreachable: never = settings.unlockPreset;
        throw new Error(`Unsupported unlock preset: ${String(unreachable)}`);
      }
    }
  }

  function buildRelockConditions(): DoorLockCondition[] {
    const goalCondition: DoorLockCondition = {
      type: 'goal',
      goalId: RELOCK_GOAL_ID,
    };
    const timerCondition: DoorLockCondition = {
      type: 'timer',
      elapsedMs: Math.max(0, Math.floor(settings.relockTimerMs)),
    };

    switch (settings.relockPreset) {
      case 'goal':
        return [goalCondition];
      case 'timer':
        return [timerCondition];
      case 'mixed':
        return [goalCondition, timerCondition];
      default: {
        const unreachable: never = settings.relockPreset;
        throw new Error(`Unsupported relock preset: ${String(unreachable)}`);
      }
    }
  }

  function syncInventory(): void {
    if (!world.inventories.has(player)) {
      throw new Error('Player inventory was not initialized.');
    }
    const bag = createInventoryBag();
    if (settings.keyPresent) {
      addItem(bag, KEY_ITEM_ID, Math.max(1, Math.floor(settings.keyQuantity)));
    }
    world.inventories.set(player, bag);
  }

  function configureWorld(): void {
    world = createGameWorld({ seed: 42 });
    world.floorMap = buildLabMap();
    const spawn = world.floorMap.tileToWorld(5, DOOR_Y);
    player = spawnPlayer(world, spawn.x, spawn.y);

    door = addEntity(world.ecs);
    addComponent(
      world.ecs,
      door,
      set(DoorState, {
        tileX: DOOR_X,
        tileY: DOOR_Y,
        logicalOpen: 0,
        isLocked: 1,
        wasUnlocked: 0,
      }),
    );
  }

  function applySimulationState(): void {
    syncInventory();
    setGoalFlag(world, UNLOCK_GOAL_ID, settings.goalComplete);
    setGoalFlag(world, RELOCK_GOAL_ID, settings.relockGoalComplete);
    world.elapsedMs = Math.max(0, Math.floor(settings.elapsedMs));

    const unlockOperator: DoorConditionOperator =
      settings.unlockPreset === 'mixed-any' ? 'any' : settings.unlockOperator;
    setDoorLockConfig(world, door, {
      unlock: {
        operator: unlockOperator,
        conditions: buildUnlockConditions(),
      },
      relock: settings.useRelock
        ? {
            operator: settings.relockOperator,
            conditions: buildRelockConditions(),
          }
        : undefined,
    });
  }

  function render(): void {
    const floorMap = world.floorMap;
    if (!floorMap) return;

    renderCtx.clearRect(0, 0, canvas.width, canvas.height);

    for (let y = 0; y < GRID_H; y += 1) {
      for (let x = 0; x < GRID_W; x += 1) {
        const isDoor = floorMap.tileMap.isDoor(x, y);
        const isPassable = floorMap.tileMap.isPassable(x, y);
        const color =
          isDoor && isPassable
            ? '#68d391'
            : isDoor
              ? '#ed8936'
              : !isPassable
                ? '#2d3748'
                : '#1f2937';

        renderCtx.fillStyle = color;
        renderCtx.fillRect(x * CELL_SIZE + 1, y * CELL_SIZE + 1, CELL_SIZE - 2, CELL_SIZE - 2);
      }
    }

    const px = world.stores.position.x[player] ?? 0;
    const py = world.stores.position.y[player] ?? 0;
    renderCtx.fillStyle = '#48bb78';
    renderCtx.beginPath();
    renderCtx.arc(px, py, CELL_SIZE * 0.22, 0, Math.PI * 2);
    renderCtx.fill();

    const isLocked = (world.stores.doorState.isLocked[door] ?? 0) !== 0;
    const logicalOpen = (world.stores.doorState.logicalOpen[door] ?? 0) !== 0;
    const wasUnlocked = (world.stores.doorState.wasUnlocked[door] ?? 0) !== 0;

    status.textContent = [
      `Door lock lab`,
      `elapsedMs: ${world.elapsedMs}`,
      `door.isLocked: ${isLocked}`,
      `door.logicalOpen: ${logicalOpen}`,
      `door.wasUnlocked: ${wasUnlocked}`,
      `tile.passable: ${floorMap.tileMap.isPassable(DOOR_X, DOOR_Y)}`,
      `unlock preset: ${settings.unlockPreset}`,
      `relock enabled: ${settings.useRelock}`,
    ].join('\n');
  }

  function runStep(): void {
    applySimulationState();
    doorSystem(world);
    render();
  }

  gui
    .add(settings, 'unlockPreset', ['inventory', 'goal', 'timer', 'mixed-all', 'mixed-any'])
    .name('Unlock preset')
    .onChange(runStep);
  gui.add(settings, 'unlockOperator', ['all', 'any']).name('Unlock operator').onChange(runStep);
  gui.add(settings, 'keyPresent').name('Key present').onChange(runStep);
  gui.add(settings, 'keyQuantity', 1, 5, 1).name('Key quantity').onChange(runStep);
  gui.add(settings, 'goalComplete').name('Goal complete').onChange(runStep);
  gui.add(settings, 'unlockTimerMs', 0, 5000, 100).name('Unlock timer ms').onChange(runStep);
  gui.add(settings, 'elapsedMs', 0, 6000, 100).name('World elapsed ms').onChange(runStep);
  gui.add(settings, 'useRelock').name('Enable relock').onChange(runStep);
  gui
    .add(settings, 'relockPreset', ['goal', 'timer', 'mixed'])
    .name('Relock preset')
    .onChange(runStep);
  gui.add(settings, 'relockOperator', ['all', 'any']).name('Relock operator').onChange(runStep);
  gui.add(settings, 'relockGoalComplete').name('Relock goal complete').onChange(runStep);
  gui.add(settings, 'relockTimerMs', 0, 6000, 100).name('Relock timer ms').onChange(runStep);

  gui
    .add(
      {
        step100ms: () => {
          settings.elapsedMs += 100;
          runStep();
        },
      },
      'step100ms',
    )
    .name('Advance +100ms');

  gui
    .add(
      {
        resetWorld: () => {
          configureWorld();
          settings.elapsedMs = 0;
          settings.goalComplete = false;
          settings.keyPresent = false;
          settings.relockGoalComplete = false;
          runStep();
        },
      },
      'resetWorld',
    )
    .name('Reset world');

  const hint = document.createElement('p');
  hint.textContent =
    'Pick an unlock preset (inventory/goal/timer/mixed), optionally enable relock, then adjust elapsed ms and flags to watch door state transitions.';
  hint.style.marginTop = '12px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';
  controls.appendChild(hint);

  configureWorld();
  runStep();

  return () => {
    canvas.remove();
    status.remove();
    hint.remove();
  };
}

registerLab('door-lock-lab', {
  category: 'Movement & Physics',
  name: 'Door Lock Lab',
  description:
    'Exercises door lock conditions (inventory, goal, timer, mixed ALL/ANY) and optional relock transitions.',
  create: createDoorLockLab,
});
