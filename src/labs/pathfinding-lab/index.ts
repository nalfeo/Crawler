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
import { findTilePath, PATH_TRAVERSAL } from '../../core/map/pathfinding.js';
import { computeFlowField, flowFieldStep, FLOW_UNREACHABLE } from '../../core/map/flow-field.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { TileMap } from '../../core/map/TileMap.js';
import { enemyAISystem, AI_TYPE, PATH_PERSONA, TRAVERSAL_MODE } from '../../game/index.js';
import { BiomeType, TileFlags, TilePresets, type MapConfig } from '../../shared/map-types.js';
import { registerLab } from '../registry.js';

const LAB_ID = 'pathfinding-lab';
const CELL_SIZE = 24;
const FIXED_DELTA_MS = 16;
const MAX_STEPS_PER_FRAME = 4;

// ---------------------------------------------------------------------------
// Map presets
// ---------------------------------------------------------------------------

interface LabMapPreset {
  readonly id: string;
  readonly name: string;
  readonly mapW: number;
  readonly mapH: number;
  readonly playerStart: { x: number; y: number };
  readonly enemyStart: { x: number; y: number };
  readonly doorTile: { x: number; y: number } | null;
  buildMap(doorOpen: boolean): FloorMap;
}

function makeFloorMap(
  mapW: number,
  mapH: number,
  isWall: (x: number, y: number) => boolean,
  doorTile: { x: number; y: number } | null,
  doorOpen: boolean,
  playerStart: { x: number; y: number },
): FloorMap {
  const tileMap = new TileMap(mapW, mapH);
  const terrain = new Uint8Array(mapW * mapH);
  const config: MapConfig = {
    widthTiles: mapW,
    heightTiles: mapH,
    tileSizeFt: CELL_SIZE,
    biome: BiomeType.DUNGEON,
    seed: 42,
    roomWidthRange: [4, 8],
    roomHeightRange: [4, 8],
    maxRooms: 1,
    floorDensity: 0.5,
  };

  for (let y = 0; y < mapH; y += 1) {
    for (let x = 0; x < mapW; x += 1) {
      const idx = y * mapW + x;
      if (doorTile !== null && x === doorTile.x && y === doorTile.y) {
        tileMap.flags[idx] = doorOpen ? TilePresets.DOOR_OPEN : TilePresets.DOOR_CLOSED;
      } else {
        tileMap.flags[idx] = isWall(x, y) ? TilePresets.WALL : TilePresets.FLOOR;
      }
    }
  }

  return new FloorMap(config, tileMap, new RoomGraph(), terrain, playerStart);
}

const LAB_MAP_PRESETS: readonly LabMapPreset[] = [
  {
    id: 'two-pillars',
    name: 'Two Pillars',
    mapW: 24,
    mapH: 16,
    playerStart: { x: 19, y: 8 },
    enemyStart: { x: 4, y: 8 },
    doorTile: { x: 11, y: 8 },
    buildMap(doorOpen) {
      const { mapW, mapH, doorTile } = this;
      return makeFloorMap(
        mapW,
        mapH,
        (x, y) => {
          const isBorder = x === 0 || y === 0 || x === mapW - 1 || y === mapH - 1;
          const centerWall =
            x === 11 && y >= 1 && y <= mapH - 2 && !(doorTile !== null && y === doorTile.y);
          const leftPillar = x === 7 && y >= 5 && y <= 10;
          const rightPillar = x === 15 && y >= 4 && y <= 11;
          return isBorder || centerWall || leftPillar || rightPillar;
        },
        doorTile,
        doorOpen,
        this.playerStart,
      );
    },
  },
  {
    id: 'open-field',
    name: 'Open Field',
    mapW: 24,
    mapH: 16,
    playerStart: { x: 19, y: 8 },
    enemyStart: { x: 4, y: 8 },
    doorTile: null,
    buildMap(doorOpen) {
      const { mapW, mapH } = this;
      return makeFloorMap(
        mapW,
        mapH,
        (x, y) => x === 0 || y === 0 || x === mapW - 1 || y === mapH - 1,
        null,
        doorOpen,
        this.playerStart,
      );
    },
  },
  {
    id: 'snake-walls',
    name: 'Snake Walls',
    mapW: 26,
    mapH: 18,
    playerStart: { x: 20, y: 9 },
    enemyStart: { x: 4, y: 9 },
    doorTile: null,
    buildMap(doorOpen) {
      const { mapW, mapH } = this;
      return makeFloorMap(
        mapW,
        mapH,
        (x, y) => {
          const isBorder = x === 0 || y === 0 || x === mapW - 1 || y === mapH - 1;
          // Upper snake wall: blocks passage across top half, gap at right end
          const upperWall = y === 6 && x >= 2 && x <= mapW - 5;
          // Lower snake wall: blocks passage across bottom half, gap at left end
          const lowerWall = y === 12 && x >= 5 && x <= mapW - 3;
          return isBorder || upperWall || lowerWall;
        },
        null,
        doorOpen,
        this.playerStart,
      );
    },
  },
  {
    id: 'box-maze',
    name: 'Box Maze',
    mapW: 24,
    mapH: 18,
    playerStart: { x: 19, y: 9 },
    enemyStart: { x: 3, y: 9 },
    doorTile: { x: 11, y: 9 },
    buildMap(doorOpen) {
      const { mapW, mapH, doorTile } = this;
      return makeFloorMap(
        mapW,
        mapH,
        (x, y) => {
          const isBorder = x === 0 || y === 0 || x === mapW - 1 || y === mapH - 1;
          const centerWall =
            x === 11 && y >= 1 && y <= mapH - 2 && !(doorTile !== null && y === doorTile.y);
          // Left room box
          const boxL = (x === 4 || x === 8) && y >= 4 && y <= 8;
          const boxLTop = y === 4 && x >= 4 && x <= 8;
          const boxLBot = y === 8 && x >= 4 && x <= 7;
          // Right room box
          const boxR = (x === 14 || x === 19) && y >= 9 && y <= 14;
          const boxRTop = y === 9 && x >= 14 && x <= 19;
          const boxRBot = y === 14 && x >= 15 && x <= 19;
          return isBorder || centerWall || boxL || boxLTop || boxLBot || boxR || boxRTop || boxRBot;
        },
        doorTile,
        doorOpen,
        this.playerStart,
      );
    },
  },
];

function getPreset(id: string): LabMapPreset {
  return LAB_MAP_PRESETS.find((p) => p.id === id) ?? LAB_MAP_PRESETS[0]!;
}

// ---------------------------------------------------------------------------
// Mob specs
// ---------------------------------------------------------------------------

interface MobSpec {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly persona: number;
  readonly traversalMode: number;
  readonly isFlying: boolean;
  readonly flankDistance?: number;
}

const MOB_SPECS: readonly MobSpec[] = [
  {
    key: 'stupid',
    label: 'Stupid',
    color: '#e53e3e',
    persona: PATH_PERSONA.STUPID,
    traversalMode: TRAVERSAL_MODE.GROUND,
    isFlying: false,
  },
  {
    key: 'navigator',
    label: 'Navigator',
    color: '#4299e1',
    persona: PATH_PERSONA.NAVIGATOR,
    traversalMode: TRAVERSAL_MODE.GROUND,
    isFlying: false,
  },
  {
    key: 'flanker',
    label: 'Flanker',
    color: '#9f7aea',
    persona: PATH_PERSONA.FLANKER,
    traversalMode: TRAVERSAL_MODE.GROUND,
    isFlying: false,
    flankDistance: 120,
  },
  {
    key: 'flying',
    label: 'Flying',
    color: '#22d3ee',
    persona: PATH_PERSONA.NAVIGATOR,
    traversalMode: TRAVERSAL_MODE.FLYING,
    isFlying: true,
  },
];

const SPAWN_OFFSETS: ReadonlyArray<{ x: number; y: number }> = [
  { x: 0, y: -20 },
  { x: 0, y: 20 },
  { x: -22, y: 0 },
  { x: -22, y: -20 },
  { x: -22, y: 20 },
];

interface MobInstance {
  eid: number;
  label: string;
  color: string;
  isFlying: boolean;
}

// ---------------------------------------------------------------------------
// Lab
// ---------------------------------------------------------------------------

function tileCenter(tileX: number, tileY: number): { x: number; y: number } {
  return { x: tileX * CELL_SIZE + CELL_SIZE / 2, y: tileY * CELL_SIZE + CELL_SIZE / 2 };
}

/**
 * Heat colour for a flow-field cell: hot (red) at the goal, cooling through
 * orange/green to blue as tile distance grows. `t` is the normalised distance in
 * [0, 1]. Kept translucent so the underlying tiles still read through.
 */
function flowHeatColor(t: number): string {
  const hue = 250 * Math.max(0, Math.min(1, t));
  return `hsla(${String(hue)}, 85%, 55%, 0.22)`;
}

/**
 * Draw a centred flow arrow (shaft + two barbs) pointing along the unit vector
 * `(dirX, dirY)`. Because the direction comes straight from {@link flowFieldStep}
 * it can be diagonal, so the rendered arrows fan out at 45° angles rather than
 * snapping to the cardinal axes.
 */
function drawFlowArrow(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  dirX: number,
  dirY: number,
  half: number,
  color: string,
): void {
  const tipX = cx + dirX * half;
  const tipY = cy + dirY * half;
  const tailX = cx - dirX * half;
  const tailY = cy - dirY * half;
  // Barbs: reverse the heading, then rotate it ±45° (cos = sin = SQRT1_2).
  const s = Math.SQRT1_2;
  const bx = -dirX;
  const by = -dirY;
  const barb = half * 0.8;
  const b1x = (bx * s - by * s) * barb;
  const b1y = (bx * s + by * s) * barb;
  const b2x = (bx * s + by * s) * barb;
  const b2y = (-bx * s + by * s) * barb;

  ctx.strokeStyle = color;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(tipX, tipY);
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX + b1x, tipY + b1y);
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX + b2x, tipY + b2y);
  ctx.stroke();
}

function createPathfindingLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) {
    throw new Error('Lab runner did not initialize lil-gui.');
  }

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.margin = '0 auto';
  canvas.style.cursor = 'crosshair';
  canvas.style.border = '1px solid rgba(255,255,255,0.15)';

  const info = document.createElement('pre');
  info.style.cssText =
    'margin:0;padding:12px;background:rgba(5,10,24,0.65);border-radius:8px;color:#d6e4ff;font-size:12px;line-height:1.5;';

  const root = document.createElement('div');
  root.style.cssText = 'display:grid;gap:12px;';
  root.append(canvas, info);
  canvasHost.append(root);

  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas context could not be created.');
  const renderCtx = ctx;

  // --- Settings ---
  const labSettings = {
    mapPresetId: LAB_MAP_PRESETS[0]!.id,
    showPaths: false,
    showFlowField: false,
  };

  const mobEnabled: Record<string, boolean> = {};
  const mobCount: Record<string, number> = {};
  for (const spec of MOB_SPECS) {
    mobEnabled[spec.key] = true;
    mobCount[spec.key] = 1;
  }

  // --- ECS state ---
  let world = createGameWorld({ seed: 1337 });
  let playerEid = -1;
  let doorEid = -1;
  let doorOpen = true;
  let accumulator = 0;
  let rafId = 0;
  let lastTimestamp = 0;
  let mobs: MobInstance[] = [];
  let currentPreset: LabMapPreset = getPreset(labSettings.mapPresetId);

  function syncCanvasSize(): void {
    canvas.width = currentPreset.mapW * CELL_SIZE;
    canvas.height = currentPreset.mapH * CELL_SIZE;
  }

  function resetWorld(): void {
    world = createGameWorld({ seed: 1337 });
    currentPreset = getPreset(labSettings.mapPresetId);
    syncCanvasSize();

    world.floorMap = currentPreset.buildMap(doorOpen);

    const playerPos = tileCenter(currentPreset.playerStart.x, currentPreset.playerStart.y);
    playerEid = spawnPlayer(world, playerPos.x, playerPos.y);

    doorEid = -1;
    if (currentPreset.doorTile !== null) {
      const dt = currentPreset.doorTile;
      doorEid = addEntity(world.ecs);
      addComponent(
        world.ecs,
        doorEid,
        set(DoorState, { tileX: dt.x, tileY: dt.y, logicalOpen: doorOpen ? 1 : 0 }),
      );
    }

    mobs = [];
    let offsetIdx = 0;
    for (const spec of MOB_SPECS) {
      if (!mobEnabled[spec.key]) continue;
      const count = Math.max(0, Math.min(5, mobCount[spec.key] ?? 1));
      for (let i = 0; i < count; i += 1) {
        const offset = SPAWN_OFFSETS[offsetIdx % SPAWN_OFFSETS.length] ?? { x: 0, y: 0 };
        const base = tileCenter(currentPreset.enemyStart.x, currentPreset.enemyStart.y);
        const eid = spawnBehaviorEnemy(
          world,
          base.x + offset.x,
          base.y + offset.y,
          20,
          AI_TYPE.CHASE,
          1.8,
          999,
          0,
          {
            persona: spec.persona,
            traversalMode: spec.traversalMode,
            isFlying: spec.isFlying,
            ...(spec.flankDistance !== undefined ? { flankDistance: spec.flankDistance } : {}),
          },
        );
        mobs.push({
          eid,
          label: count > 1 ? `${spec.label} ${i + 1}` : spec.label,
          color: spec.color,
          isFlying: spec.isFlying,
        });
        offsetIdx += 1;
      }
    }
  }

  function setDoorState(open: boolean): void {
    doorOpen = open;
    if (doorEid >= 0 && currentPreset.doorTile !== null) {
      const dt = currentPreset.doorTile;
      setComponent(world.ecs, doorEid, DoorState, {
        tileX: dt.x,
        tileY: dt.y,
        logicalOpen: doorOpen ? 1 : 0,
      });
    }
  }

  function draw(): void {
    const floorMap = world.floorMap;
    if (!floorMap) return;

    const { mapW, mapH } = currentPreset;

    renderCtx.clearRect(0, 0, canvas.width, canvas.height);

    // Tiles
    for (let y = 0; y < mapH; y += 1) {
      for (let x = 0; x < mapW; x += 1) {
        const idx = y * mapW + x;
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
    const playerTile = floorMap.worldToTile(playerX, playerY);

    // Flow-field overlay: the shared single-source field that ground chasers now
    // descend instead of running a per-mob A*. Heat = tile distance to the
    // player; arrows are the per-tile step from flowFieldStep, which can be
    // diagonal — so they fan out at 45° angles rather than snapping to the
    // cardinal axes, mirroring how mobs travel in diagonal lines.
    if (labSettings.showFlowField) {
      const field = computeFlowField(floorMap, playerTile, {
        traversalMode: PATH_TRAVERSAL.GROUND,
      });
      let maxDistance = 1;
      for (let i = 0; i < field.distance.length; i += 1) {
        const d = field.distance[i] ?? FLOW_UNREACHABLE;
        if (d > maxDistance) maxDistance = d;
      }
      for (let ty = 0; ty < currentPreset.mapH; ty += 1) {
        for (let tx = 0; tx < currentPreset.mapW; tx += 1) {
          const d = field.distance[ty * field.width + tx] ?? FLOW_UNREACHABLE;
          if (d === FLOW_UNREACHABLE) continue;
          renderCtx.fillStyle = flowHeatColor(d / maxDistance);
          renderCtx.fillRect(tx * CELL_SIZE, ty * CELL_SIZE, CELL_SIZE, CELL_SIZE);
          const step = flowFieldStep(field, tx, ty);
          if (!step) continue;
          const len = Math.hypot(step.x, step.y) || 1;
          const center = tileCenter(tx, ty);
          drawFlowArrow(
            renderCtx,
            center.x,
            center.y,
            step.x / len,
            step.y / len,
            CELL_SIZE * 0.3,
            'rgba(214,228,255,0.75)',
          );
        }
      }
      const goal = tileCenter(field.goalX, field.goalY);
      renderCtx.strokeStyle = '#f6e05e';
      renderCtx.lineWidth = 2;
      renderCtx.beginPath();
      renderCtx.arc(goal.x, goal.y, CELL_SIZE * 0.4, 0, Math.PI * 2);
      renderCtx.stroke();
    }

    // A* path overlays — the per-mob search still used by flankers, flying mobs,
    // and ranged standoff targets. Ground chasers follow the flow field above.
    if (labSettings.showPaths) {
      for (const mob of mobs) {
        const mx = world.stores.position.x[mob.eid] ?? 0;
        const my = world.stores.position.y[mob.eid] ?? 0;
        const mobTile = floorMap.worldToTile(mx, my);

        const path = findTilePath(floorMap, mobTile, playerTile, {
          traversalMode: mob.isFlying ? PATH_TRAVERSAL.FLYING : PATH_TRAVERSAL.GROUND,
          maxPathLength: 512,
        });

        if (path.length < 2) continue;

        renderCtx.save();
        renderCtx.strokeStyle = mob.color;
        renderCtx.globalAlpha = 0.55;
        renderCtx.lineWidth = 2;
        renderCtx.setLineDash([3, 5]);
        renderCtx.beginPath();
        for (let j = 0; j < path.length; j += 1) {
          const wp = path[j]!;
          const px = wp.x * CELL_SIZE + CELL_SIZE / 2;
          const py = wp.y * CELL_SIZE + CELL_SIZE / 2;
          if (j === 0) renderCtx.moveTo(px, py);
          else renderCtx.lineTo(px, py);
        }
        renderCtx.stroke();
        renderCtx.restore();
      }
    }

    // Player
    renderCtx.fillStyle = '#f6e05e';
    renderCtx.beginPath();
    renderCtx.arc(playerX, playerY, 7, 0, Math.PI * 2);
    renderCtx.fill();

    // Mobs
    for (const mob of mobs) {
      const x = world.stores.position.x[mob.eid] ?? 0;
      const y = world.stores.position.y[mob.eid] ?? 0;
      renderCtx.fillStyle = mob.color;
      renderCtx.beginPath();
      renderCtx.arc(x, y, 6, 0, Math.PI * 2);
      renderCtx.fill();

      renderCtx.fillStyle = '#e2e8f0';
      renderCtx.font = '10px monospace';
      renderCtx.textAlign = 'center';
      renderCtx.fillText(mob.label, x, y - 10);
    }

    const lines: string[] = [
      'Click a passable tile to move the player.',
      `Room: ${currentPreset.name}  |  Door: ${currentPreset.doorTile !== null ? (doorOpen ? 'open' : 'closed') : 'none'}`,
      `Mobs: ${mobs.length}  |  A* paths: ${labSettings.showPaths ? 'on' : 'off'}  |  Flow field: ${labSettings.showFlowField ? 'on' : 'off'}`,
    ];
    if (labSettings.showFlowField) {
      lines.push('Flow field: heat = distance to player, arrows = diagonal step.');
    }
    for (const spec of MOB_SPECS) {
      if (mobEnabled[spec.key] && (mobCount[spec.key] ?? 0) > 0) {
        lines.push(`${spec.color.slice(0, 7)}  ${spec.label}`);
      }
    }
    info.textContent = lines.join('\n');
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

  // --- GUI ---
  const mapOptions = Object.fromEntries(LAB_MAP_PRESETS.map((p) => [p.name, p.id]));
  gui
    .add(labSettings, 'mapPresetId', mapOptions)
    .name('Room Layout')
    .onChange(() => resetWorld());

  gui.add(labSettings, 'showPaths').name('Show A* Paths');
  gui.add(labSettings, 'showFlowField').name('Show Flow Field');

  const doorApi = {
    toggleDoor: () => setDoorState(!doorOpen),
    openDoor: () => setDoorState(true),
    closeDoor: () => setDoorState(false),
    reset: () => resetWorld(),
  };
  gui.add(doorApi, 'toggleDoor').name('Toggle Door');
  gui.add(doorApi, 'openDoor').name('Open Door');
  gui.add(doorApi, 'closeDoor').name('Close Door');
  gui.add(doorApi, 'reset').name('Reset Scenario');

  const mobFolder = gui.addFolder('Mob Spawn');
  mobFolder.close();
  for (const spec of MOB_SPECS) {
    const typeFolder = mobFolder.addFolder(spec.label);
    typeFolder
      .add(mobEnabled, spec.key)
      .name('Enabled')
      .onChange(() => resetWorld());
    typeFolder
      .add(mobCount, spec.key, 0, 5, 1)
      .name('Count')
      .onChange(() => resetWorld());
  }

  canvas.addEventListener('click', (event) => {
    if (!world.floorMap) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = Math.floor(((event.clientX - rect.left) * scaleX) / CELL_SIZE);
    const y = Math.floor(((event.clientY - rect.top) * scaleY) / CELL_SIZE);
    if (!world.floorMap.tileMap.isPassable(x, y)) return;
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
    'Compare stupid, navigator, flanker, and flying mob pathing across 4 room layouts. Visualise the shared flow field (heat + diagonal arrows) ground chasers descend, or the per-mob A* paths used by flankers and flying mobs.',
  create: createPathfindingLab,
});
