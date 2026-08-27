/**
 * Safe Room Lab — demonstrates the safe room system.
 *
 * Renders a minimap with two rooms: a SAFE room (blue) and a NORMAL room
 * (grey). A movable "player" dot shows safe-room detection in real time.
 * The lil-gui panel displays `world.playerInSafeRoom` and whether
 * customization systems are accessible via `isInSafeContext`.
 *
 * Use WASD or arrow keys to move the player.
 * Observe that the status changes on entry/exit.
 */

import GUI from 'lil-gui';
import { spawnPlayer, createGameWorld } from '../../core/index.js';
import { safeRoomSystem, isInSafeContext } from '../../core/safe-space.js';
import { equip } from '../../core/systems/equipmentSystem.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { TileMap } from '../../core/map/TileMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { BiomeType, RoomRole, TilePresets } from '../../shared/map-types.js';
import { MERCHANTS_CHARM_DEF } from '../../shared/equipmentDefs.js';
import { registerLab } from '../registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TILE_SIZE = 24;
const MAP_W = 30;
const MAP_H = 20;
const PLAYER_SPEED = 4; // tiles per key press

// Safe room bounds (tiles)
const SAFE_ROOM = { x: 2, y: 2, w: 6, h: 6 };
// Normal room bounds (tiles)
const NORMAL_ROOM = { x: 18, y: 8, w: 6, h: 6 };

// ---------------------------------------------------------------------------
// Map setup
// ---------------------------------------------------------------------------

function buildMap(): FloorMap {
  const cfg = {
    widthTiles: MAP_W,
    heightTiles: MAP_H,
    tileSizeFt: TILE_SIZE,
    biome: BiomeType.DUNGEON as BiomeType,
    seed: 42,
    roomWidthRange: [4, 8] as [number, number],
    roomHeightRange: [4, 8] as [number, number],
    maxRooms: 4,
    floorDensity: 0.5,
  };

  const tileMap = new TileMap(MAP_W, MAP_H);
  for (let i = 0; i < MAP_W * MAP_H; i++) {
    tileMap.flags[i] = TilePresets.FLOOR;
  }

  const graph = new RoomGraph();
  graph.add(
    { x: SAFE_ROOM.x, y: SAFE_ROOM.y, width: SAFE_ROOM.w, height: SAFE_ROOM.h },
    [],
    [],
    RoomRole.SAFE,
  );
  graph.add(
    { x: NORMAL_ROOM.x, y: NORMAL_ROOM.y, width: NORMAL_ROOM.w, height: NORMAL_ROOM.h },
    [],
    [],
    RoomRole.NORMAL,
  );

  return new FloorMap(cfg, tileMap, graph, new Uint8Array(MAP_W * MAP_H), {
    x: SAFE_ROOM.x + 1,
    y: SAFE_ROOM.y + 1,
  });
}

// ---------------------------------------------------------------------------
// Lab
// ---------------------------------------------------------------------------

function createSafeRoomLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  // --- Canvas ---
  const canvas = document.createElement('canvas');
  canvas.width = MAP_W * TILE_SIZE;
  canvas.height = MAP_H * TILE_SIZE;
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvas.style.outline = 'none';
  canvas.tabIndex = 0;
  canvasHost.appendChild(canvas);
  canvas.focus();

  const ctx = canvas.getContext('2d')!;

  // --- World & map ---
  const world = createGameWorld({ seed: 42 });
  world.floorMap = buildMap();
  world.state = 'playing';
  world.featureUnlocks.equipment = true;
  world.featureUnlocks.equipmentPanel = true;

  // Spawn player at centre of safe room
  const startFt = {
    x: (SAFE_ROOM.x + Math.floor(SAFE_ROOM.w / 2)) * TILE_SIZE + TILE_SIZE / 2,
    y: (SAFE_ROOM.y + Math.floor(SAFE_ROOM.h / 2)) * TILE_SIZE + TILE_SIZE / 2,
  };
  const playerEid = spawnPlayer(world, startFt.x, startFt.y);

  // --- GUI state ---
  const state = {
    playerTileX: SAFE_ROOM.x + Math.floor(SAFE_ROOM.w / 2),
    playerTileY: SAFE_ROOM.y + Math.floor(SAFE_ROOM.h / 2),
    playerInSafeRoom: false,
    safeContext: false,
    equipResult: '—',
    status: 'Initialising…',
  };

  const folder = gui.addFolder('Safe Room System');
  const ctrlInSafe = folder.add(state, 'playerInSafeRoom').name('playerInSafeRoom').disable();
  const ctrlSafeCtx = folder.add(state, 'safeContext').name('isInSafeContext').disable();
  const ctrlEquip = folder.add(state, 'equipResult').name('Last equip result').disable();
  folder.add(state, 'status').name('Status').disable();
  folder.open();

  gui
    .add(
      {
        tryEquip() {
          const result = equip(world, playerEid, MERCHANTS_CHARM_DEF);
          state.equipResult = result.ok
            ? '✅ Equipped!'
            : `❌ ${result.reasons.map((r) => ('message' in r ? r.message : r.type)).join(', ')}`;
          ctrlEquip.updateDisplay();
        },
      },
      'tryEquip',
    )
    .name('Try Equip (Charm)');

  gui
    .add(
      {
        forceEquip() {
          const result = equip(world, playerEid, MERCHANTS_CHARM_DEF, { force: true });
          state.equipResult = result.ok ? '✅ Force-equipped!' : '❌ failed';
          ctrlEquip.updateDisplay();
        },
      },
      'forceEquip',
    )
    .name('Force Equip (bypasses gate)');

  // --- Keyboard ---
  const keys = new Set<string>();

  function onKeyDown(e: KeyboardEvent) {
    keys.add(e.key);
  }
  function onKeyUp(e: KeyboardEvent) {
    keys.delete(e.key);
  }
  canvas.addEventListener('keydown', onKeyDown);
  canvas.addEventListener('keyup', onKeyUp);

  // --- Render ---
  function render() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Background
    ctx.fillStyle = '#1a1a2e';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Safe room (blue)
    ctx.fillStyle = '#1a4a7a';
    ctx.fillRect(
      SAFE_ROOM.x * TILE_SIZE,
      SAFE_ROOM.y * TILE_SIZE,
      SAFE_ROOM.w * TILE_SIZE,
      SAFE_ROOM.h * TILE_SIZE,
    );
    ctx.strokeStyle = '#4fc3f7';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      SAFE_ROOM.x * TILE_SIZE,
      SAFE_ROOM.y * TILE_SIZE,
      SAFE_ROOM.w * TILE_SIZE,
      SAFE_ROOM.h * TILE_SIZE,
    );
    ctx.fillStyle = '#4fc3f7';
    ctx.font = '11px monospace';
    ctx.fillText('SAFE ROOM', SAFE_ROOM.x * TILE_SIZE + 4, SAFE_ROOM.y * TILE_SIZE + 14);

    // Normal room (grey)
    ctx.fillStyle = '#2a2a3e';
    ctx.fillRect(
      NORMAL_ROOM.x * TILE_SIZE,
      NORMAL_ROOM.y * TILE_SIZE,
      NORMAL_ROOM.w * TILE_SIZE,
      NORMAL_ROOM.h * TILE_SIZE,
    );
    ctx.strokeStyle = '#888';
    ctx.lineWidth = 2;
    ctx.strokeRect(
      NORMAL_ROOM.x * TILE_SIZE,
      NORMAL_ROOM.y * TILE_SIZE,
      NORMAL_ROOM.w * TILE_SIZE,
      NORMAL_ROOM.h * TILE_SIZE,
    );
    ctx.fillStyle = '#aaa';
    ctx.font = '11px monospace';
    ctx.fillText('NORMAL ROOM', NORMAL_ROOM.x * TILE_SIZE + 4, NORMAL_ROOM.y * TILE_SIZE + 14);

    // Player dot
    const px = world.stores.position.x[playerEid] ?? 0;
    const py = world.stores.position.y[playerEid] ?? 0;
    const color = world.playerInSafeRoom ? '#00e676' : '#ff5252';
    ctx.beginPath();
    ctx.arc(px, py, TILE_SIZE / 2 - 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    // Status overlay
    const label = world.playerInSafeRoom ? '🛡 In safe room' : '⚔ Outside safe room';
    ctx.fillStyle = world.playerInSafeRoom ? '#00e676' : '#ff5252';
    ctx.font = 'bold 13px monospace';
    ctx.fillText(label, 8, canvas.height - 10);
  }

  // --- Simulation tick ---
  let rafId: number;
  const KEY_SETS = {
    up: ['ArrowUp', 'w', 'W'],
    down: ['ArrowDown', 's', 'S'],
    left: ['ArrowLeft', 'a', 'A'],
    right: ['ArrowRight', 'd', 'D'],
  };

  function tick() {
    // Move player
    let dx = 0;
    let dy = 0;
    if (KEY_SETS.up.some((k) => keys.has(k))) dy -= PLAYER_SPEED;
    if (KEY_SETS.down.some((k) => keys.has(k))) dy += PLAYER_SPEED;
    if (KEY_SETS.left.some((k) => keys.has(k))) dx -= PLAYER_SPEED;
    if (KEY_SETS.right.some((k) => keys.has(k))) dx += PLAYER_SPEED;

    if (dx !== 0 || dy !== 0) {
      const curX = world.stores.position.x[playerEid] ?? 0;
      const curY = world.stores.position.y[playerEid] ?? 0;
      const newX = Math.max(0, Math.min(MAP_W * TILE_SIZE - 1, curX + dx));
      const newY = Math.max(0, Math.min(MAP_H * TILE_SIZE - 1, curY + dy));
      world.stores.position.x[playerEid] = newX;
      world.stores.position.y[playerEid] = newY;
    }

    // Update safe room flag
    safeRoomSystem(world);

    // Update GUI
    state.playerInSafeRoom = world.playerInSafeRoom;
    state.safeContext = isInSafeContext(world);
    state.status = world.playerInSafeRoom
      ? 'Customization ENABLED (in safe room)'
      : 'Customization DISABLED (outside safe room)';
    ctrlInSafe.updateDisplay();
    ctrlSafeCtx.updateDisplay();
    folder.controllers.find((c) => c.property === 'status')?.updateDisplay();

    render();
    rafId = requestAnimationFrame(tick);
  }

  rafId = requestAnimationFrame(tick);

  return () => {
    cancelAnimationFrame(rafId);
    canvas.removeEventListener('keydown', onKeyDown);
    canvas.removeEventListener('keyup', onKeyUp);
    canvas.remove();
    folder.destroy();
  };
}

registerLab('safe-room-lab', {
  name: 'Safe Room System',
  description:
    'Demonstrates player safe-room detection, isInSafeContext gating, and equipment access control.',
  category: 'Meta',
  create: createSafeRoomLab,
});
