/**
 * Unified Map Generation Lab — biome mapgen + cave-system overlays in one lab.
 */

import { query } from 'bitecs';
import GUI from 'lil-gui';
import { DoorState, Spawner } from '../../core/components.js';
import { getGenerator, getRegisteredBiomes } from '../../core/map/generators/registry.js';
import type { DoorLockCondition, DoorConditionGroup } from '../../core/door-lock.js';
import type { GameWorld } from '../../core/world.js';
import { registerLab } from '../registry.js';
import { loadLabState, saveLabState } from '../lab-persistence.js';
import { getAvailableFloorIds } from '../../shared/floor-registry.js';
import { loadFamilies } from '../../shared/data/families.js';
import { getNpcDef } from '../../shared/npc-types.js';
import { SeededRandom } from '../../shared/random.js';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  TileFlags,
  type MapConfig,
  type RoomData,
} from '../../shared/map-types.js';
import type { FloorMap } from '../../core/map/FloorMap.js';
import { getSpawnerArchetypeByIndex } from '../../game/spawners/registry.js';
import {
  buildConstrainedFloorPreview,
  getFloorConstraintDefaults,
  type PreviewFloorId,
} from './runtime-preview.js';

const LAB_ID = 'map-gen-lab';
const CELL_SIZE = 8;
const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 60;
type FloorConstraintId = 'none' | 'floor1' | 'floor2';

interface HoverTarget {
  readonly kind: 'rect' | 'point';
  readonly x: number;
  readonly y: number;
  readonly width?: number;
  readonly height?: number;
  readonly radius?: number;
  readonly title: string;
  readonly lines: readonly string[];
}

interface Marker {
  readonly tx: number;
  readonly ty: number;
  readonly color: string;
  readonly title: string;
  readonly shape: 'dot' | 'square' | 'diamond';
  readonly lines: readonly string[];
}

interface MapGenLabSettings {
  floorConstraint: FloorConstraintId;
  applyFloorConstraints: boolean;
  biome: BiomeType;
  seed: number;
  widthTiles: number;
  heightTiles: number;
  maxRooms: number;
  floorDensity: number;
  roomWidthMin: number;
  roomWidthMax: number;
  roomHeightMin: number;
  roomHeightMax: number;
  cavePresentCount: number;
  caveInitialFill: number;
  caveSmoothingPasses: number;
  caveBossDenSize: number;
  caveRegionSeparationTiles: number;
  caveMaxRetries: number;
  caveCavernWidenPasses: number;
  caveStraightHallwayMinRun: number;
  showRooms: boolean;
  showDoors: boolean;
  showSpawn: boolean;
  showReachability: boolean;
  showTrashSpawnAreas: boolean;
  showFamilyTerritories: boolean;
  showNpcPositions: boolean;
  showQuestItems: boolean;
  showSpecialMobs: boolean;
  showSpecialRooms: boolean;
  showLegend: boolean;
}

const TERRAIN_COLORS: Record<number, string> = {
  [TerrainType.VOID]: '#0a0a0f',
  [TerrainType.STONE_FLOOR]: '#2d3748',
  [TerrainType.STONE_WALL]: '#4a5568',
  [TerrainType.DOOR]: '#6b3d10', // muted — door overlay paints bright orange when showDoors is ON
  [TerrainType.CORRIDOR]: '#1e3a5f',
  [TerrainType.WATER]: '#2b6cb0',
  [TerrainType.LAVA]: '#c53030',
  [TerrainType.GRASS]: '#276749',
  [TerrainType.DIRT]: '#744210',
  [TerrainType.WOOD_FLOOR]: '#5a3e28',
  [TerrainType.WOOD_WALL]: '#3d2914',
  [TerrainType.CAVE_FLOOR]: '#3c3656',
  [TerrainType.CAVE_WALL]: '#553c75',
  [TerrainType.BOSS_STAIR_FLOOR]: '#7a3a8a',
  [TerrainType.SAFE_ROOM_FLOOR]: '#0f766e',
  [TerrainType.TREE]: '#1c5a2d',
  [TerrainType.RUBBLE]: '#4a3f35',
};

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

const TERRITORY_COLORS = [
  'rgba(66, 153, 225, 0.30)',
  'rgba(72, 187, 120, 0.30)',
  'rgba(237, 137, 54, 0.30)',
  'rgba(159, 122, 234, 0.30)',
];

const SPECIAL_ROOM_STROKES: Partial<Record<RoomRole, string>> = {
  [RoomRole.SPAWN]: '#f6e05e',
  [RoomRole.SAFE]: '#38b2ac',
  [RoomRole.BOSS_STAIR]: '#f56565',
  [RoomRole.SETTLEMENT]: '#f6ad55',
  [RoomRole.RESOURCE_HEART]: '#ed64a6',
  [RoomRole.BOSS_DEN]: '#fc8181',
};

const FLOOR_OPTIONS: Record<FloorConstraintId, string> = {
  none: '(none)',
  floor1: 'floor1',
  floor2: 'floor2',
};

const FAMILY_NAME_BY_ID = new Map(
  loadFamilies().map((family) => [family.id, family.name] as const),
);

function floodFromSpawn(map: FloorMap): Uint8Array {
  const w = map.width;
  const h = map.height;
  const visited = new Uint8Array(w * h);
  const start = map.playerSpawn.y * w + map.playerSpawn.x;
  visited[start] = 1;
  const stack = [start];
  while (stack.length > 0) {
    const idx = stack.pop()!;
    const cx = idx % w;
    const cy = (idx - cx) / w;
    for (const [nx, ny] of [
      [cx + 1, cy],
      [cx - 1, cy],
      [cx, cy + 1],
      [cx, cy - 1],
    ] as const) {
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const nIdx = ny * w + nx;
      if (visited[nIdx]) continue;
      const flags = map.flags[nIdx]!;
      if ((flags & TileFlags.PASSABLE) === 0 && (flags & TileFlags.DOOR) === 0) continue;
      visited[nIdx] = 1;
      stack.push(nIdx);
    }
  }
  return visited;
}

function findSealedRooms(map: FloorMap, reachable: Uint8Array): number[] {
  const w = map.width;
  const sealed: number[] = [];
  const rooms = map.rooms;
  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i]!;
    const b = room.bounds;
    let hasInterior = false;
    let connected = false;
    for (let ty = b.y + 1; ty < b.y + b.height - 1 && !connected; ty++) {
      for (let tx = b.x + 1; tx < b.x + b.width - 1; tx++) {
        const idx = ty * w + tx;
        if ((map.flags[idx]! & TileFlags.PASSABLE) === 0) continue;
        hasInterior = true;
        if (reachable[idx]) {
          connected = true;
          break;
        }
      }
    }
    if (hasInterior && !connected) sealed.push(i);
  }
  return sealed;
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

function roomCenter(room: RoomData): { tx: number; ty: number } {
  if (room.interiorCells && room.interiorCells.length > 0) {
    const mid = room.interiorCells[Math.floor(room.interiorCells.length / 2)]!;
    return { tx: mid.x, ty: mid.y };
  }
  return {
    tx: room.bounds.x + Math.floor(room.bounds.width / 2),
    ty: room.bounds.y + Math.floor(room.bounds.height / 2),
  };
}

function roomDisplayName(room: RoomData, floor: FloorConstraintId): string {
  if (room.role === RoomRole.SPAWN && floor === 'floor1') return 'Tutorial room';
  if (room.role === RoomRole.SAFE && floor === 'floor1') return 'Safe room / bar';
  if (room.role === RoomRole.BOSS_STAIR && floor === 'floor1') return 'Boss room';
  if (room.role === RoomRole.SETTLEMENT) return 'Settlement / bar';
  if (room.role === RoomRole.RESOURCE_HEART) return 'Resource heart';
  if (room.role === RoomRole.BOSS_DEN) return 'Boss den';
  if (room.role === RoomRole.TERRITORY) return 'Family territory';
  if (room.role === RoomRole.SAFE) return 'Safe room';
  if (room.role === RoomRole.SPAWN) return 'Spawn room';
  if (room.role === RoomRole.BOSS_STAIR) return 'Boss stair room';
  return 'Combat room';
}

function doorCriteriaForRoom(room: RoomData, floor: FloorConstraintId): string[] {
  if (floor === 'floor1' && room.role === RoomRole.BOSS_STAIR) {
    return [
      'Unlock criteria:',
      '- goal floor1-goon-quest-complete',
      '- goal floor1-shop-quest-complete',
      '- goal floor1-boss-battle-complete',
    ];
  }
  if (floor === 'floor2' && room.role === RoomRole.BOSS_DEN) {
    const familyToken = room.familyIndex !== undefined ? String(room.familyIndex) : '?';
    return [`Unlock criteria: goal floor2-den-family-${familyToken}-unlocked`];
  }
  return ['Unlock criteria: none (ambient passage door)'];
}

function formatDoorCondition(condition: DoorLockCondition): string {
  switch (condition.type) {
    case 'goal':
      return `goal ${condition.goalId}`;
    case 'inventory':
      return `inventory ${condition.itemId} x${condition.quantity}`;
    case 'timer':
      return `timer ${condition.elapsedMs}ms`;
  }
}

function formatDoorConditionGroup(label: string, group: DoorConditionGroup): string[] {
  return [
    `${label} (${group.operator})`,
    ...group.conditions.map((condition) => `- ${formatDoorCondition(condition)}`),
  ];
}

function createMapGenLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const initialFloor = (
    getAvailableFloorIds().includes('floor1') ? 'floor1' : 'none'
  ) as FloorConstraintId;
  const savedState = loadLabState<MapGenLabSettings>(LAB_ID);
  const settings: MapGenLabSettings = {
    floorConstraint: initialFloor,
    applyFloorConstraints: true,
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
    cavePresentCount: 4,
    caveInitialFill: 0.45,
    caveSmoothingPasses: 5,
    caveBossDenSize: 5,
    caveRegionSeparationTiles: 0,
    caveMaxRetries: 8,
    caveCavernWidenPasses: 2,
    caveStraightHallwayMinRun: 10,
    showRooms: true,
    showDoors: true,
    showSpawn: true,
    showReachability: true,
    showTrashSpawnAreas: false,
    showFamilyTerritories: true,
    showNpcPositions: true,
    showQuestItems: true,
    showSpecialMobs: true,
    showSpecialRooms: true,
    showLegend: true,
    ...savedState,
  };

  const VIEWPORT_HEIGHT = 620;

  function makeZoomBtn(label: string): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText =
      'padding:4px 10px;border-radius:5px;border:1px solid rgba(148,163,184,0.35);' +
      'background:rgba(15,23,42,0.85);color:#e2e8f0;cursor:pointer;font-size:13px;user-select:none;';
    return btn;
  }
  const zoomBar = document.createElement('div');
  zoomBar.style.cssText =
    'display:flex;gap:6px;align-items:center;margin-bottom:6px;flex-wrap:wrap;';
  const btnZoomIn = makeZoomBtn('🔍 +');
  const btnZoomOut = makeZoomBtn('🔍 −');
  const btnFit = makeZoomBtn('⊡ Fit to Frame');
  const zoomLabel = document.createElement('span');
  zoomLabel.style.cssText = 'color:#94a3b8;font-size:12px;font-family:monospace;min-width:46px;';
  zoomLabel.textContent = '100%';
  const regenStatusLabel = document.createElement('span');
  regenStatusLabel.style.cssText =
    'margin-left:8px;padding:3px 8px;border-radius:9999px;font-size:11px;font-weight:700;letter-spacing:.02em;';
  regenStatusLabel.textContent = 'READY';
  zoomBar.append(btnZoomIn, btnZoomOut, btnFit, zoomLabel, regenStatusLabel);
  canvasHost.appendChild(zoomBar);

  const canvas = document.createElement('canvas');
  canvas.style.display = 'block';
  canvas.style.width = '100%';
  canvas.style.height = `${VIEWPORT_HEIGHT}px`;
  canvas.style.imageRendering = 'pixelated';
  canvas.style.cursor = 'grab';
  canvas.style.borderRadius = '4px';
  canvasHost.appendChild(canvas);

  const applyButton = document.createElement('button');
  applyButton.textContent = '✅ Apply Map Settings';
  applyButton.title = 'Regenerate map now using all pending map-generation changes.';
  applyButton.style.cssText =
    'margin-top:8px;padding:8px 12px;border-radius:8px;border:1px solid rgba(52,211,153,0.5);' +
    'background:rgba(16,185,129,0.15);color:#6ee7b7;cursor:pointer;font-weight:600;';
  canvasHost.appendChild(applyButton);

  const rawCtx = canvas.getContext('2d');
  if (rawCtx === null) throw new Error('Could not acquire 2D context for map-gen lab canvas.');
  const ctx: CanvasRenderingContext2D = rawCtx;

  function resizeCanvas(): void {
    const w = Math.max(400, canvasHost.clientWidth);
    if (canvas.width !== w || canvas.height !== VIEWPORT_HEIGHT) {
      canvas.width = w;
      canvas.height = VIEWPORT_HEIGHT;
    }
  }
  resizeCanvas();

  canvasHost.style.position = 'relative';
  const tooltipEl = document.createElement('div');
  tooltipEl.style.position = 'absolute';
  tooltipEl.style.pointerEvents = 'none';
  tooltipEl.style.padding = '8px 10px';
  tooltipEl.style.borderRadius = '6px';
  tooltipEl.style.background = 'rgba(8, 12, 24, 0.94)';
  tooltipEl.style.border = '1px solid rgba(148, 163, 184, 0.6)';
  tooltipEl.style.color = '#e2e8f0';
  tooltipEl.style.fontSize = '12px';
  tooltipEl.style.lineHeight = '1.4';
  tooltipEl.style.whiteSpace = 'pre-wrap';
  tooltipEl.style.maxWidth = '340px';
  tooltipEl.style.zIndex = '10';
  tooltipEl.style.display = 'none';
  canvasHost.appendChild(tooltipEl);

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

  const sweepEl = document.createElement('pre');
  sweepEl.style.marginTop = '8px';
  sweepEl.style.padding = '12px';
  sweepEl.style.background = 'rgba(8, 12, 24, 0.6)';
  sweepEl.style.borderRadius = '8px';
  sweepEl.style.color = '#c9d4ff';
  sweepEl.style.fontSize = '12px';
  sweepEl.style.fontFamily = 'monospace';
  sweepEl.style.lineHeight = '1.6';
  sweepEl.style.whiteSpace = 'pre-wrap';
  sweepEl.textContent = 'Seed sweep: not run yet.';
  canvasHost.appendChild(sweepEl);

  const legendEl = document.createElement('pre');
  legendEl.style.marginTop = '8px';
  legendEl.style.padding = '12px';
  legendEl.style.background = 'rgba(8, 12, 24, 0.6)';
  legendEl.style.borderRadius = '8px';
  legendEl.style.color = '#d1defd';
  legendEl.style.fontSize = '12px';
  legendEl.style.fontFamily = 'monospace';
  legendEl.style.lineHeight = '1.55';
  legendEl.style.whiteSpace = 'pre-wrap';
  canvasHost.appendChild(legendEl);

  let currentMap: FloorMap | null = null;
  let currentPreviewWorld: GameWorld | null = null;
  let currentReachable: Uint8Array | null = null;
  let currentSealed: number[] = [];
  let hoverTargets: HoverTarget[] = [];
  let generationMs = 0;
  let isGenerating = false;
  let pendingRegeneration = false;
  let generationQueued = false;

  // zoom/pan state
  let zoom = 1.0;
  let fitZoom = 1.0; // minimum zoom = fit-to-frame; prevent zooming out further
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;

  const availableFloors = getAvailableFloorIds().filter(
    (id): id is Exclude<FloorConstraintId, 'none'> => id === 'floor1' || id === 'floor2',
  );
  if (!availableFloors.includes(settings.floorConstraint as Exclude<FloorConstraintId, 'none'>)) {
    settings.floorConstraint = 'none';
  }

  function applyFloorDefaultsIfEnabled(): void {
    if (!settings.applyFloorConstraints || settings.floorConstraint === 'none') {
      return;
    }
    const defaults = getFloorConstraintDefaults(settings.floorConstraint as PreviewFloorId);
    settings.widthTiles = defaults.widthTiles;
    settings.heightTiles = defaults.heightTiles;
    settings.biome = defaults.biome;
    settings.maxRooms = defaults.maxRooms;
    settings.floorDensity = defaults.floorDensity;
    settings.roomWidthMin = defaults.roomWidthMin;
    settings.roomWidthMax = defaults.roomWidthMax;
    settings.roomHeightMin = defaults.roomHeightMin;
    settings.roomHeightMax = defaults.roomHeightMax;
    settings.cavePresentCount = clampInt(defaults.cavePresentCount, 3, 4);
    settings.caveInitialFill = defaults.caveInitialFill;
    settings.caveSmoothingPasses = defaults.caveSmoothingPasses;
    settings.caveBossDenSize = defaults.caveBossDenSize;
    settings.caveRegionSeparationTiles = defaults.caveRegionSeparationTiles;
    settings.caveMaxRetries = defaults.caveMaxRetries;
    settings.caveCavernWidenPasses = defaults.caveCavernWidenPasses;
    settings.caveStraightHallwayMinRun = defaults.caveStraightHallwayMinRun;
  }

  function buildConfig(): MapConfig {
    const widthTiles = clampInt(settings.widthTiles, 20, 400);
    const heightTiles = clampInt(settings.heightTiles, 20, 300);
    const roomWidthMin = clampInt(Math.min(settings.roomWidthMin, settings.roomWidthMax), 3, 40);
    const roomWidthMax = clampInt(Math.max(settings.roomWidthMin, settings.roomWidthMax), 3, 50);
    const roomHeightMin = clampInt(Math.min(settings.roomHeightMin, settings.roomHeightMax), 3, 40);
    const roomHeightMax = clampInt(Math.max(settings.roomHeightMin, settings.roomHeightMax), 3, 50);
    const caveSystemConfig =
      settings.biome === BiomeType.CAVE_SYSTEM
        ? {
            caveSystem: {
              presentCount: clampInt(settings.cavePresentCount, 3, 4),
              initialFill: Math.max(0.05, Math.min(0.95, settings.caveInitialFill)),
              smoothingPasses: clampInt(settings.caveSmoothingPasses, 1, 12),
              bossDenSize: clampInt(settings.caveBossDenSize, 3, 13),
              regionSeparationTiles: clampInt(settings.caveRegionSeparationTiles, 0, 80),
              maxRetries: clampInt(settings.caveMaxRetries, 1, 24),
              cavernWidenPasses: clampInt(settings.caveCavernWidenPasses, 0, 8),
              straightHallwayMinRun: clampInt(settings.caveStraightHallwayMinRun, 0, 40),
            },
          }
        : {};
    const mapConfig: MapConfig = {
      widthTiles,
      heightTiles,
      tileSizeFt: 4,
      biome: settings.biome,
      seed: clampInt(settings.seed, 1, 2_000_000),
      roomWidthRange: [roomWidthMin, roomWidthMax],
      roomHeightRange: [roomHeightMin, roomHeightMax],
      maxRooms: clampInt(settings.maxRooms, 3, 100),
      floorDensity: Math.max(0.1, Math.min(0.8, settings.floorDensity)),
      ...caveSystemConfig,
    };
    return mapConfig;
  }

  function findRoomByDoor(map: FloorMap, x: number, y: number): RoomData | undefined {
    return map.rooms.find((room) => room.doors.some((door) => door.x === x && door.y === y));
  }

  function familyNameForRoom(room: RoomData): string {
    if (room.familyIndex === undefined) return '';
    const familyId =
      currentPreviewWorld?.floorExtendedState?.familyState?.presentFamilies[room.familyIndex];
    return (familyId && FAMILY_NAME_BY_ID.get(familyId)) ?? `Family ${room.familyIndex}`;
  }

  function formatRoleLabel(room: RoomData): string {
    if (room.familyIndex === undefined) return room.role;
    return `${room.role} • ${familyNameForRoom(room)}`;
  }

  function resolveDoorTooltipLines(
    room: RoomData | undefined,
    tileX: number,
    tileY: number,
  ): string[] {
    if (currentPreviewWorld) {
      for (const doorEid of query(currentPreviewWorld.ecs, [DoorState])) {
        if (
          currentPreviewWorld.stores.doorState.tileX[doorEid] !== tileX ||
          currentPreviewWorld.stores.doorState.tileY[doorEid] !== tileY
        ) {
          continue;
        }
        const config = currentPreviewWorld.doorLockConfigs.get(doorEid);
        if (!config) {
          return ['Unlock criteria: none (runtime ambient door)'];
        }
        const lines = [...formatDoorConditionGroup('Unlock', config.unlock)];
        if (config.relock) {
          lines.push(...formatDoorConditionGroup('Relock', config.relock));
        }
        return lines;
      }
    }
    return room
      ? doorCriteriaForRoom(room, settings.floorConstraint)
      : ['Unlock criteria: unknown'];
  }

  function buildRoomAnnotations(map: FloorMap): Map<number, HoverTarget> {
    const annotations = new Map<number, HoverTarget>();
    const upsert = (roomId: number, title: string, lines: readonly string[]): void => {
      const existing = annotations.get(roomId);
      if (!existing) {
        annotations.set(roomId, { kind: 'rect', x: 0, y: 0, title, lines: [...lines] });
        return;
      }
      const mergedLines = [...existing.lines];
      if (existing.title !== title) mergedLines.push(`also: ${title}`);
      for (const line of lines) {
        if (!mergedLines.includes(line)) mergedLines.push(line);
      }
      annotations.set(roomId, { ...existing, lines: mergedLines });
    };
    const addWorldPos = (
      title: string,
      worldX: number,
      worldY: number,
      ...lines: string[]
    ): void => {
      const tile = map.worldToTile(worldX, worldY);
      const roomId = map.roomGraph.getRoomAt(tile.x, tile.y);
      if (roomId >= 0) upsert(roomId, title, lines);
    };

    if (settings.floorConstraint === 'floor1' && currentPreviewWorld?.floorScenario) {
      const objective = currentPreviewWorld.floorScenario.objective;
      const slimeRatBoss = objective.bossBattles.get('slime-rat');
      const staircaseBoss = objective.bossBattles.get('staircase');
      const slimeRatLabel = slimeRatBoss ? `${slimeRatBoss.displayName} Room` : 'Slime Rat room';
      const staircaseLabel = staircaseBoss
        ? `Boss Room: ${staircaseBoss.displayName}`
        : 'Boss room / Staircase';
      addWorldPos(
        'Tutorial room / Welcome Office',
        objective.welcomeOfficePos.x,
        objective.welcomeOfficePos.y,
      );
      addWorldPos('Safe room', objective.safeRoomPos.x, objective.safeRoomPos.y);
      addWorldPos('Shop room', objective.shopRoomPos.x, objective.shopRoomPos.y);
      addWorldPos(
        'Spell Broker room',
        objective.spellQuestGiverPos.x,
        objective.spellQuestGiverPos.y,
      );
      addWorldPos(
        slimeRatLabel,
        objective.slimeRatRoomPos.x,
        objective.slimeRatRoomPos.y,
        slimeRatBoss ? `Boss: ${slimeRatBoss.displayName}` : '',
      );
      addWorldPos(
        staircaseLabel,
        objective.staircasePos.x,
        objective.staircasePos.y,
        staircaseBoss ? `Boss: ${staircaseBoss.displayName}` : '',
      );
    }

    if (settings.floorConstraint === 'floor2') {
      const settlementRoomId =
        currentPreviewWorld?.floorExtendedState?.settlement?.settlementRoomId;
      if (settlementRoomId !== undefined) {
        upsert(settlementRoomId, 'Settlement / Bar', ['Broker + shopkeepers spawn here']);
      }
    }

    return annotations;
  }

  function resolveNpcMarkers(map: FloorMap): Marker[] {
    if (!currentPreviewWorld) {
      return [];
    }
    const markers: Marker[] = [];
    for (const [eid, instance] of currentPreviewWorld.npcs.entries()) {
      const x = currentPreviewWorld.stores.position.x[eid] ?? Number.NaN;
      const y = currentPreviewWorld.stores.position.y[eid] ?? Number.NaN;
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const tile = map.worldToTile(x, y);
      const npcDef = getNpcDef(instance.defId);
      markers.push({
        tx: clampInt(tile.x, 0, map.width - 1),
        ty: clampInt(tile.y, 0, map.height - 1),
        color: '#60a5fa',
        shape: 'diamond',
        title: `NPC: ${npcDef?.name ?? instance.defId}`,
        lines: [
          `id=${instance.defId}`,
          `quests=${instance.quests.map((quest) => `${quest.questId}:${quest.status}`).join(', ') || 'none'}`,
        ],
      });
    }
    return markers;
  }

  function resolveSpecialMobMarkers(map: FloorMap): Marker[] {
    const markers: Marker[] = [];
    if (currentPreviewWorld) {
      for (const eid of query(currentPreviewWorld.ecs, [Spawner])) {
        const x = currentPreviewWorld.stores.position.x[eid] ?? Number.NaN;
        const y = currentPreviewWorld.stores.position.y[eid] ?? Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const tile = map.worldToTile(x, y);
        const archetype = getSpawnerArchetypeByIndex(
          currentPreviewWorld.stores.spawner.defIndex[eid] ?? -1,
        );
        markers.push({
          tx: clampInt(tile.x, 0, map.width - 1),
          ty: clampInt(tile.y, 0, map.height - 1),
          color: '#ef4444',
          shape: 'square',
          title: `Spawner: ${archetype?.id ?? 'unknown'}`,
          lines: ['Hardcoded runtime special mob'],
        });
      }
      if (settings.floorConstraint === 'floor1' && currentPreviewWorld.floorScenario) {
        const objective = currentPreviewWorld.floorScenario.objective;
        for (const [title, pos] of [
          ['Slime Rat boss', objective.slimeRatRoomPos],
          ['Staircase boss', objective.staircasePos],
        ] as const) {
          const tile = map.worldToTile(pos.x, pos.y);
          markers.push({
            tx: clampInt(tile.x, 0, map.width - 1),
            ty: clampInt(tile.y, 0, map.height - 1),
            color: '#f97316',
            shape: 'dot',
            title,
            lines: ['Runtime objective room'],
          });
        }
      }
    }
    for (const room of map.rooms) {
      if (room.role === RoomRole.BOSS_DEN) {
        const center = roomCenter(room);
        markers.push({
          tx: center.tx,
          ty: center.ty,
          color: '#fb7185',
          shape: 'dot',
          title: 'Family boss spawn',
          lines: [
            `family=${room.familyIndex !== undefined ? familyNameForRoom(room) : '?'}`,
            `goal=floor2-family-${room.familyIndex ?? '?'}-boss-defeated`,
          ],
        });
      } else if (room.role === RoomRole.BOSS_STAIR) {
        const center = roomCenter(room);
        markers.push({
          tx: center.tx,
          ty: center.ty,
          color: '#f97316',
          shape: 'dot',
          title: 'Boss spawn',
          lines: ['Floor boss room'],
        });
      }
    }
    return markers;
  }

  function resolveQuestItemMarkers(map: FloorMap): Marker[] {
    if (!currentPreviewWorld?.floorScenario) return [];
    const objective = currentPreviewWorld.floorScenario.objective;
    const tile = map.worldToTile(objective.questItemPos.x, objective.questItemPos.y);
    if (tile.x < 0 || tile.x >= map.width || tile.y < 0 || tile.y >= map.height) return [];
    return [
      {
        tx: tile.x,
        ty: tile.y,
        color: '#fbbf24',
        shape: 'diamond',
        title: '⭐ Glistening Rat Tail',
        lines: [
          'Shopkeeper fetch quest item',
          `tile=(${tile.x}, ${tile.y})`,
          'Collect and return to the Shop room',
        ],
      },
    ];
  }

  function drawMarker(marker: Marker): void {
    const px = marker.tx * CELL_SIZE + CELL_SIZE / 2;
    const py = marker.ty * CELL_SIZE + CELL_SIZE / 2;
    ctx.save();
    ctx.fillStyle = marker.color;
    ctx.strokeStyle = '#020617';
    ctx.lineWidth = 1.5;
    if (marker.shape === 'dot') {
      ctx.beginPath();
      ctx.arc(px, py, Math.max(3, CELL_SIZE * 0.4), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    } else if (marker.shape === 'square') {
      const size = Math.max(4, CELL_SIZE - 2);
      ctx.fillRect(px - size / 2, py - size / 2, size, size);
      ctx.strokeRect(px - size / 2, py - size / 2, size, size);
    } else {
      const size = Math.max(4, CELL_SIZE);
      ctx.translate(px, py);
      ctx.rotate(Math.PI / 4);
      ctx.fillRect(-size / 2, -size / 2, size, size);
      ctx.strokeRect(-size / 2, -size / 2, size, size);
    }
    ctx.restore();
    hoverTargets.push({
      kind: 'point',
      x: px,
      y: py,
      radius: Math.max(6, CELL_SIZE),
      title: marker.title,
      lines: marker.lines,
    });
  }

  function render(): void {
    if (!currentMap) return;
    hoverTargets = [];
    const map = currentMap;
    const roomAnnotations = buildRoomAnnotations(map);
    const w = map.width;
    const h = map.height;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        const terrainType = map.terrain[idx] as number;
        ctx.fillStyle = TERRAIN_COLORS[terrainType] ?? '#0a0a0f';
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
      }
    }

    if (settings.showTrashSpawnAreas) {
      for (const room of map.rooms) {
        if (room.role !== RoomRole.NORMAL && room.role !== RoomRole.TERRITORY) continue;
        const x = room.bounds.x * CELL_SIZE;
        const y = room.bounds.y * CELL_SIZE;
        const width = room.bounds.width * CELL_SIZE;
        const height = room.bounds.height * CELL_SIZE;
        ctx.fillStyle = 'rgba(120, 53, 15, 0.26)';
        ctx.fillRect(x, y, width, height);
        hoverTargets.push({
          kind: 'rect',
          x,
          y,
          width,
          height,
          title: 'Trash mob spawn area',
          lines: [`room=${room.id}`, `role=${room.role}`],
        });
      }
    }

    if (settings.showRooms) {
      for (let i = 0; i < map.rooms.length; i++) {
        const room = map.rooms[i]!;
        ctx.fillStyle = ROOM_COLORS[i % ROOM_COLORS.length]!;
        ctx.fillRect(
          room.bounds.x * CELL_SIZE,
          room.bounds.y * CELL_SIZE,
          room.bounds.width * CELL_SIZE,
          room.bounds.height * CELL_SIZE,
        );
      }
    }

    if (settings.showFamilyTerritories) {
      for (const room of map.rooms) {
        if (room.role !== RoomRole.TERRITORY && room.role !== RoomRole.BOSS_DEN) continue;
        const familyIndex = room.familyIndex ?? 0;
        const familyName = familyNameForRoom(room);
        const x = room.bounds.x * CELL_SIZE;
        const y = room.bounds.y * CELL_SIZE;
        const width = room.bounds.width * CELL_SIZE;
        const height = room.bounds.height * CELL_SIZE;
        ctx.fillStyle = TERRITORY_COLORS[familyIndex % TERRITORY_COLORS.length]!;
        ctx.fillRect(x, y, width, height);
        ctx.fillStyle = '#f8fafc';
        ctx.font = `${Math.max(10, CELL_SIZE + 1)}px monospace`;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`F${familyIndex}: ${familyName}`, x + 3, y + 3);
        hoverTargets.push({
          kind: 'rect',
          x,
          y,
          width,
          height,
          title: room.role === RoomRole.BOSS_DEN ? 'Family boss den' : 'Family territory',
          lines: [`family=${familyName}`, `room=${room.id}`],
        });
      }
    }

    if (settings.showSpecialRooms) {
      ctx.lineWidth = 2;
      for (const room of map.rooms) {
        const stroke = SPECIAL_ROOM_STROKES[room.role];
        if (!stroke) continue;
        const x = room.bounds.x * CELL_SIZE;
        const y = room.bounds.y * CELL_SIZE;
        const width = room.bounds.width * CELL_SIZE;
        const height = room.bounds.height * CELL_SIZE;
        const annotation = roomAnnotations.get(room.id);
        ctx.strokeStyle = stroke;
        ctx.strokeRect(x + 1, y + 1, width - 2, height - 2);
        hoverTargets.push({
          kind: 'rect',
          x,
          y,
          width,
          height,
          title: annotation?.title ?? roomDisplayName(room, settings.floorConstraint),
          lines: [...(annotation?.lines ?? []), formatRoleLabel(room), `room=${room.id}`],
        });
      }
    }

    if (settings.showDoors) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if ((map.flags[idx]! & TileFlags.DOOR) === 0) continue;
          // Bright orange fill to override the muted base terrain color
          ctx.fillStyle = '#ed8936';
          ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
          // Small lock-dot indicator if the door has a real lock condition
          const room = findRoomByDoor(map, x, y);
          const hasLock = currentPreviewWorld
            ? (() => {
                for (const doorEid of query(currentPreviewWorld.ecs, [DoorState])) {
                  if (
                    currentPreviewWorld.stores.doorState.tileX[doorEid] === x &&
                    currentPreviewWorld.stores.doorState.tileY[doorEid] === y
                  ) {
                    return currentPreviewWorld.doorLockConfigs.has(doorEid);
                  }
                }
                return false;
              })()
            : false;
          if (hasLock) {
            // Red dot = locked door
            ctx.fillStyle = '#e53e3e';
            const r = Math.max(1.5, CELL_SIZE * 0.22);
            const cx = x * CELL_SIZE + CELL_SIZE / 2;
            const cy = y * CELL_SIZE + CELL_SIZE / 2;
            ctx.beginPath();
            ctx.arc(cx, cy, r, 0, Math.PI * 2);
            ctx.fill();
          }
          hoverTargets.push({
            kind: 'rect',
            x: x * CELL_SIZE,
            y: y * CELL_SIZE,
            width: CELL_SIZE,
            height: CELL_SIZE,
            title: `Door (${x}, ${y})${hasLock ? ' 🔒' : ''}`,
            lines: resolveDoorTooltipLines(room, x, y),
          });
        }
      }
    } else {
      // Overlay off: still register hover targets so tooltips work on door tiles
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if ((map.flags[idx]! & TileFlags.DOOR) === 0) continue;
          const room = findRoomByDoor(map, x, y);
          hoverTargets.push({
            kind: 'rect',
            x: x * CELL_SIZE,
            y: y * CELL_SIZE,
            width: CELL_SIZE,
            height: CELL_SIZE,
            title: `Door (${x}, ${y})`,
            lines: resolveDoorTooltipLines(room, x, y),
          });
        }
      }
    }

    if (settings.showReachability && currentReachable) {
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if ((map.flags[idx]! & TileFlags.PASSABLE) === 0) continue;
          if (currentReachable[idx]) continue;
          ctx.fillStyle = 'rgba(245, 101, 101, 0.55)';
          ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        }
      }
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#f56565';
      for (const i of currentSealed) {
        const b = map.rooms[i]!.bounds;
        ctx.strokeRect(
          b.x * CELL_SIZE + 1,
          b.y * CELL_SIZE + 1,
          b.width * CELL_SIZE - 2,
          b.height * CELL_SIZE - 2,
        );
      }
    }

    if (settings.showNpcPositions) {
      const markers = resolveNpcMarkers(map);
      for (const marker of markers) drawMarker(marker);
    }

    if (settings.showQuestItems && settings.floorConstraint === 'floor1') {
      const questMarkers = resolveQuestItemMarkers(map);
      for (const marker of questMarkers) drawMarker(marker);
    }

    if (settings.showSpecialMobs) {
      const markers = resolveSpecialMobMarkers(map);
      for (const marker of markers) drawMarker(marker);
    }

    if (settings.showSpawn) {
      const spawnX = map.playerSpawn.x * CELL_SIZE + CELL_SIZE / 2;
      const spawnY = map.playerSpawn.y * CELL_SIZE + CELL_SIZE / 2;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(spawnX, spawnY, Math.max(4, CELL_SIZE), 0, Math.PI * 2);
      ctx.stroke();
      hoverTargets.push({
        kind: 'point',
        x: spawnX,
        y: spawnY,
        radius: Math.max(6, CELL_SIZE),
        title: 'Player spawn',
        lines: [`tile=(${map.playerSpawn.x}, ${map.playerSpawn.y})`],
      });
    }

    ctx.restore();

    // Screen-space room labels (drawn after restore so they're viewport-fixed size)
    if (settings.showSpecialRooms) {
      ctx.save();
      ctx.font = 'bold 11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const room of map.rooms) {
        const annotation = roomAnnotations.get(room.id);
        if (!annotation?.title) continue;
        const center = roomCenter(room);
        const vpX = center.tx * CELL_SIZE * zoom + panX;
        const vpY = center.ty * CELL_SIZE * zoom + panY;
        // Skip labels panned off-screen
        if (vpX < -40 || vpX > canvas.width + 40 || vpY < -20 || vpY > canvas.height + 20) continue;
        ctx.fillStyle = 'rgba(0,0,0,0.72)';
        ctx.fillText(annotation.title, vpX + 1, vpY + 1);
        ctx.fillStyle = '#f0f4ff';
        ctx.fillText(annotation.title, vpX, vpY);
      }
      ctx.restore();
    }
  }

  function updateStats(): void {
    if (!currentMap) return;
    const map = currentMap;
    let passable = 0;
    for (let i = 0; i < map.width * map.height; i++) {
      if ((map.flags[i]! & TileFlags.PASSABLE) !== 0) passable += 1;
    }
    const byRole = new Map<string, number>();
    for (const room of map.rooms) {
      byRole.set(room.role, (byRole.get(room.role) ?? 0) + 1);
    }
    const roleSummary = [...byRole.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([role, count]) => `${role}:${count}`)
      .join(', ');
    statsEl.textContent = [
      `Floor constraints: ${settings.applyFloorConstraints ? 'ON' : 'OFF'} (${settings.floorConstraint})`,
      `Biome: ${map.config.biome}  Seed: ${settings.seed}`,
      `Size: ${map.width}x${map.height}  Rooms: ${map.rooms.length}  Gen: ${generationMs.toFixed(1)}ms`,
      `Passable: ${passable}/${map.width * map.height} (${((passable / (map.width * map.height)) * 100).toFixed(1)}%)`,
      `Roles: ${roleSummary || 'none'}`,
      `Sealed rooms: ${currentSealed.length === 0 ? 'none ✅' : currentSealed.join(', ')}`,
      `Spawn: (${map.playerSpawn.x}, ${map.playerSpawn.y})`,
    ].join('\n');
  }

  function updateLegend(): void {
    if (!settings.showLegend) {
      legendEl.style.display = 'none';
      return;
    }
    legendEl.style.display = 'block';
    const lines = ['Legend', '======', 'White ring: player spawn', 'Orange square: door tile'];
    if (settings.showDoors) lines.push('Orange tiles: door (dark = closed, 🔒 = locked)');
    if (settings.showRooms) lines.push('Blue/green/etc fill: room bounds');
    if (settings.showReachability) lines.push('Red fill/outline: unreachable or sealed room');
    if (settings.showTrashSpawnAreas) lines.push('Brown tint: trash mob spawn area');
    if (settings.showFamilyTerritories) lines.push('Family tint + label: territory / boss den');
    if (settings.showNpcPositions) lines.push('Blue diamonds: NPC positions');
    if (settings.showQuestItems) lines.push('Gold diamonds: quest items / objective locations');
    if (settings.showSpecialMobs) lines.push('Red squares/dots: special mobs / spawners');
    if (settings.showSpecialRooms) lines.push('Colored room outlines: special rooms');
    lines.push('Hover map markers/areas to inspect details.');
    legendEl.textContent = lines.join('\n');
  }

  function fitToFrame(): void {
    if (!currentMap) return;
    const mapPxW = currentMap.width * CELL_SIZE;
    const mapPxH = currentMap.height * CELL_SIZE;
    const vw = canvas.width;
    const vh = canvas.height;
    fitZoom = Math.min(vw / mapPxW, vh / mapPxH) * 0.96;
    zoom = fitZoom;
    panX = (vw - mapPxW * fitZoom) / 2;
    panY = (vh - mapPxH * fitZoom) / 2;
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setRegenerationStatus(state: 'ready' | 'pending' | 'working'): void {
    if (state === 'working') {
      regenStatusLabel.textContent = 'REGENERATING…';
      regenStatusLabel.style.background = 'rgba(251, 191, 36, 0.2)';
      regenStatusLabel.style.color = '#fbbf24';
      regenStatusLabel.style.border = '1px solid rgba(251, 191, 36, 0.5)';
      applyButton.disabled = true;
      applyButton.textContent = '⏳ Regenerating…';
      return;
    }
    if (state === 'pending') {
      regenStatusLabel.textContent = 'PENDING APPLY';
      regenStatusLabel.style.background = 'rgba(248, 113, 113, 0.2)';
      regenStatusLabel.style.color = '#fca5a5';
      regenStatusLabel.style.border = '1px solid rgba(248, 113, 113, 0.5)';
      applyButton.disabled = false;
      applyButton.textContent = '✅ Apply Map Settings';
      return;
    }
    regenStatusLabel.textContent = 'READY';
    regenStatusLabel.style.background = 'rgba(52, 211, 153, 0.18)';
    regenStatusLabel.style.color = '#6ee7b7';
    regenStatusLabel.style.border = '1px solid rgba(52, 211, 153, 0.45)';
    applyButton.disabled = false;
    applyButton.textContent = '✅ Apply Map Settings';
  }

  function markMapSettingsDirty(): void {
    pendingRegeneration = true;
    setRegenerationStatus('pending');
    saveLabState(LAB_ID, settings);
  }

  function shouldUseRuntimeConstrainedPreview(): boolean {
    if (!settings.applyFloorConstraints || settings.floorConstraint === 'none') return false;
    const defaults = getFloorConstraintDefaults(settings.floorConstraint as PreviewFloorId);
    const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;
    return (
      settings.biome === defaults.biome &&
      settings.widthTiles === defaults.widthTiles &&
      settings.heightTiles === defaults.heightTiles &&
      settings.maxRooms === defaults.maxRooms &&
      eq(settings.floorDensity, defaults.floorDensity) &&
      settings.roomWidthMin === defaults.roomWidthMin &&
      settings.roomWidthMax === defaults.roomWidthMax &&
      settings.roomHeightMin === defaults.roomHeightMin &&
      settings.roomHeightMax === defaults.roomHeightMax &&
      settings.cavePresentCount === defaults.cavePresentCount &&
      eq(settings.caveInitialFill, defaults.caveInitialFill) &&
      settings.caveSmoothingPasses === defaults.caveSmoothingPasses &&
      settings.caveBossDenSize === defaults.caveBossDenSize &&
      settings.caveRegionSeparationTiles === defaults.caveRegionSeparationTiles &&
      settings.caveMaxRetries === defaults.caveMaxRetries &&
      settings.caveCavernWidenPasses === defaults.caveCavernWidenPasses &&
      settings.caveStraightHallwayMinRun === defaults.caveStraightHallwayMinRun
    );
  }

  function generateNow(): void {
    const start = performance.now();
    if (shouldUseRuntimeConstrainedPreview()) {
      currentPreviewWorld = buildConstrainedFloorPreview(
        settings.floorConstraint as PreviewFloorId,
        clampInt(settings.seed, 1, 2_000_000),
        undefined,
      );
      currentMap = currentPreviewWorld.floorMap;
    } else {
      currentPreviewWorld = null;
      const config = buildConfig();
      const generator = getGenerator(config.biome);
      currentMap = generator.generate(config, new SeededRandom(config.seed));
    }
    generationMs = performance.now() - start;
    if (!currentMap) {
      throw new Error('Map generation lab expected a floor map.');
    }
    currentReachable = floodFromSpawn(currentMap);
    currentSealed = findSealedRooms(currentMap, currentReachable);
    fitToFrame();
    render();
    updateStats();
    updateLegend();
    saveLabState(LAB_ID, settings);
  }

  function queueGenerate(force = false): void {
    if (!force && !pendingRegeneration && currentMap) {
      return;
    }
    if (isGenerating) {
      generationQueued = true;
      return;
    }
    isGenerating = true;
    pendingRegeneration = false;
    setRegenerationStatus('working');
    window.setTimeout(() => {
      try {
        generateNow();
      } finally {
        isGenerating = false;
        if (generationQueued) {
          generationQueued = false;
          queueGenerate(true);
        } else {
          setRegenerationStatus(pendingRegeneration ? 'pending' : 'ready');
        }
      }
    }, 0);
  }

  function hideTooltip(): void {
    tooltipEl.style.display = 'none';
  }

  function hitTestHoverTarget(x: number, y: number): HoverTarget | undefined {
    for (let i = hoverTargets.length - 1; i >= 0; i--) {
      const target = hoverTargets[i]!;
      if (target.kind === 'rect') {
        const width = target.width ?? 0;
        const height = target.height ?? 0;
        if (x >= target.x && x <= target.x + width && y >= target.y && y <= target.y + height) {
          return target;
        }
      } else {
        const radius = target.radius ?? 0;
        const dx = x - target.x;
        const dy = y - target.y;
        if (dx * dx + dy * dy <= radius * radius) return target;
      }
    }
    return undefined;
  }

  function showTooltip(target: HoverTarget, screenX: number, screenY: number): void {
    tooltipEl.style.display = 'block';
    tooltipEl.textContent = [target.title, ...target.lines].join('\n');
    const parentRect = canvasHost.getBoundingClientRect();
    tooltipEl.style.left = `${screenX - parentRect.left + 12}px`;
    tooltipEl.style.top = `${screenY - parentRect.top + 12}px`;
  }

  function onCanvasMove(evt: MouseEvent): void {
    if (!currentMap || isDragging) {
      if (!isDragging) hideTooltip();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      hideTooltip();
      return;
    }
    // pixel-ratio-aware coords then inverse transform into map space
    const pixelRatio = canvas.width / rect.width;
    const localX = (evt.clientX - rect.left) * pixelRatio;
    const localY = (evt.clientY - rect.top) * pixelRatio;
    const mapX = (localX - panX) / zoom;
    const mapY = (localY - panY) / zoom;
    const target = hitTestHoverTarget(mapX, mapY);
    if (!target) {
      hideTooltip();
      return;
    }
    showTooltip(target, evt.clientX, evt.clientY);
  }

  function onMouseDown(evt: MouseEvent): void {
    if (evt.button === 0) {
      isDragging = true;
      dragStartX = evt.clientX;
      dragStartY = evt.clientY;
      dragStartPanX = panX;
      dragStartPanY = panY;
      canvas.style.cursor = 'grabbing';
      hideTooltip();
    }
  }

  function onMouseUp(): void {
    if (isDragging) {
      isDragging = false;
      canvas.style.cursor = 'grab';
    }
  }

  function onMouseDrag(evt: MouseEvent): void {
    if (isDragging) {
      panX = dragStartPanX + (evt.clientX - dragStartX);
      panY = dragStartPanY + (evt.clientY - dragStartY);
      render();
      return;
    }
    onCanvasMove(evt);
  }

  canvas.addEventListener('mousedown', onMouseDown);
  canvas.addEventListener('mousemove', onMouseDrag);
  canvas.addEventListener('mouseup', onMouseUp);
  canvas.addEventListener('mouseleave', () => {
    onMouseUp();
    hideTooltip();
  });

  canvas.addEventListener(
    'wheel',
    (evt: WheelEvent) => {
      evt.preventDefault();
      const factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12;
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = canvas.width / rect.width;
      const mx = (evt.clientX - rect.left) * pixelRatio;
      const my = (evt.clientY - rect.top) * pixelRatio;
      const newZoom = Math.max(fitZoom, Math.min(20, zoom * factor));
      panX = mx - (mx - panX) * (newZoom / zoom);
      panY = my - (my - panY) * (newZoom / zoom);
      zoom = newZoom;
      zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
      render();
    },
    { passive: false },
  );

  btnZoomIn.addEventListener('click', () => {
    zoom = Math.min(20, zoom * 1.3);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    render();
  });
  btnZoomOut.addEventListener('click', () => {
    zoom = Math.max(fitZoom, zoom / 1.3);
    zoomLabel.textContent = `${Math.round(zoom * 100)}%`;
    render();
  });
  btnFit.addEventListener('click', () => {
    fitToFrame();
    render();
  });
  applyButton.addEventListener('click', () => {
    commitActiveGuiInput();
    queueGenerate(true);
  });

  function setControllerTooltip(controller: { domElement: HTMLElement }, text: string): void {
    controller.domElement.title = text;
    const tooltipNodes = controller.domElement.querySelectorAll<HTMLElement>(
      '.name, input, select, button',
    );
    for (const node of tooltipNodes) node.title = text;
  }

  function commitActiveGuiInput(): void {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLSelectElement) {
      active.dispatchEvent(new Event('input', { bubbles: true }));
      active.dispatchEvent(new Event('change', { bubbles: true }));
      active.blur();
    }
  }

  const floorFolder = gui.addFolder('Floor Constraints');
  const applyConstraintsCtl = floorFolder
    .add(settings, 'applyFloorConstraints')
    .name('Apply floor constraints')
    .onChange(() => {
      applyFloorDefaultsIfEnabled();
      updateCaveControlsVisibility();
      gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
      markMapSettingsDirty();
    });
  setControllerTooltip(
    applyConstraintsCtl,
    'When ON, selected floor restores canonical floor defaults for all map-generation knobs. Changes wait until Apply.',
  );
  const floorCtl = floorFolder
    .add(settings, 'floorConstraint', FLOOR_OPTIONS)
    .name('Floor')
    .onChange(() => {
      applyFloorDefaultsIfEnabled();
      updateCaveControlsVisibility();
      gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
      markMapSettingsDirty();
    });
  setControllerTooltip(
    floorCtl,
    'Select floor preset for constrained generation. Changes wait until Apply.',
  );

  const biomeOptions = Object.fromEntries(getRegisteredBiomes().map((biome) => [biome, biome]));

  const generationFolder = gui.addFolder('Generation');
  const biomeCtl = generationFolder
    .add(settings, 'biome', biomeOptions)
    .name('Biome')
    .onChange(() => {
      updateCaveControlsVisibility();
      markMapSettingsDirty();
    });
  setControllerTooltip(
    biomeCtl,
    'Biome generator to use when floor constraints are OFF. Apply to regenerate.',
  );
  const seedCtl = generationFolder
    .add(settings, 'seed', 1, 2_000_000, 1)
    .name('Seed')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(seedCtl, 'Deterministic generation seed. Apply to rebuild map.');
  const widthCtl = generationFolder
    .add(settings, 'widthTiles', 20, 400, 2)
    .name('Width')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(widthCtl, 'Map width in tiles. Apply to rebuild map.');
  const heightCtl = generationFolder
    .add(settings, 'heightTiles', 20, 300, 2)
    .name('Height')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(heightCtl, 'Map height in tiles. Apply to rebuild map.');

  const roomFolder = gui.addFolder('Room Layout');
  const maxRoomsCtl = roomFolder
    .add(settings, 'maxRooms', 3, 100, 1)
    .name('Max Rooms')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(maxRoomsCtl, 'Upper bound of generated rooms. Apply to rebuild map.');
  const densityCtl = roomFolder
    .add(settings, 'floorDensity', 0.1, 0.8, 0.01)
    .name('Floor Density')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    densityCtl,
    'Target passable-tile density for room placement. Apply to rebuild map.',
  );
  const roomWMinCtl = roomFolder
    .add(settings, 'roomWidthMin', 3, 30, 1)
    .name('Room W Min')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(roomWMinCtl, 'Minimum room width in tiles. Apply to rebuild map.');
  const roomWMaxCtl = roomFolder
    .add(settings, 'roomWidthMax', 4, 50, 1)
    .name('Room W Max')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(roomWMaxCtl, 'Maximum room width in tiles. Apply to rebuild map.');
  const roomHMinCtl = roomFolder
    .add(settings, 'roomHeightMin', 3, 30, 1)
    .name('Room H Min')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(roomHMinCtl, 'Minimum room height in tiles. Apply to rebuild map.');
  const roomHMaxCtl = roomFolder
    .add(settings, 'roomHeightMax', 4, 50, 1)
    .name('Room H Max')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(roomHMaxCtl, 'Maximum room height in tiles. Apply to rebuild map.');

  const caveFolder = gui.addFolder('Cave System Tweaks');
  const presentFamiliesCtl = caveFolder
    .add(settings, 'cavePresentCount', [3, 4])
    .name('Present families')
    .onChange((value: number | string) => {
      settings.cavePresentCount = Number(value);
      markMapSettingsDirty();
    });
  setControllerTooltip(
    presentFamiliesCtl,
    'Families present in cave-system floors. Apply to rebuild map.',
  );
  const initialFillCtl = caveFolder
    .add(settings, 'caveInitialFill', 0.1, 0.9, 0.01)
    .name('Initial fill')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    initialFillCtl,
    'Initial random wall percentage before cave smoothing. Apply to rebuild map.',
  );
  const smoothingCtl = caveFolder
    .add(settings, 'caveSmoothingPasses', 1, 12, 1)
    .name('Smoothing passes')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    smoothingCtl,
    'Cellular automata smoothing iterations. Apply to rebuild map.',
  );
  const bossDenCtl = caveFolder
    .add(settings, 'caveBossDenSize', 3, 13, 1)
    .name('Boss den size')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(bossDenCtl, 'Boss-den carved radius/diameter scalar. Apply to rebuild map.');
  const separationCtl = caveFolder
    .add(settings, 'caveRegionSeparationTiles', 0, 80, 1)
    .name('Region separation')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    separationCtl,
    'Minimum tile separation between key regions. Apply to rebuild map.',
  );
  const retriesCtl = caveFolder
    .add(settings, 'caveMaxRetries', 1, 24, 1)
    .name('Max retries')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(retriesCtl, 'Generation retry cap before giving up. Apply to rebuild map.');
  const widenPassesCtl = caveFolder
    .add(settings, 'caveCavernWidenPasses', 0, 8, 1)
    .name('Cavern widen passes')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    widenPassesCtl,
    'Post-connect widening passes to make caverns more spacious. Apply to rebuild map.',
  );
  const hallwayRunCtl = caveFolder
    .add(settings, 'caveStraightHallwayMinRun', 0, 40, 1)
    .name('Straight hall min run')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    hallwayRunCtl,
    'Minimum straight hallway run before perturbation pass breaks long corridors. Apply to rebuild map.',
  );

  const overlayFolder = gui.addFolder('Overlays');
  overlayFolder.add(settings, 'showRooms').name('Room overlays').onChange(render);
  overlayFolder.add(settings, 'showDoors').name('Door markers').onChange(render);
  overlayFolder.add(settings, 'showSpawn').name('Spawn marker').onChange(render);
  overlayFolder.add(settings, 'showReachability').name('Reachability probe').onChange(render);
  overlayFolder.add(settings, 'showTrashSpawnAreas').name('Trash spawn areas').onChange(render);
  overlayFolder
    .add(settings, 'showFamilyTerritories')
    .name('Territories + family names')
    .onChange(render);
  overlayFolder.add(settings, 'showNpcPositions').name('NPC positions').onChange(render);
  overlayFolder.add(settings, 'showQuestItems').name('Quest items / objectives').onChange(render);
  overlayFolder.add(settings, 'showSpecialMobs').name('Special mobs/spawners').onChange(render);
  overlayFolder.add(settings, 'showSpecialRooms').name('Special room labels').onChange(render);
  overlayFolder.add(settings, 'showLegend').name('Legend panel').onChange(updateLegend);

  const nextSeedCtl = gui
    .add(
      {
        nextSeed: () => {
          settings.seed = settings.seed >= 1_999_999 ? 1 : settings.seed + 1;
          gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
          markMapSettingsDirty();
        },
      },
      'nextSeed',
    )
    .name('➕ Next Seed');
  setControllerTooltip(
    nextSeedCtl,
    'Increment seed and mark map dirty. Press Apply to regenerate.',
  );

  const sweepCtl = gui
    .add(
      {
        sweep: () => {
          const count = 60;
          const offenders: string[] = [];
          for (let seed = 1; seed <= count; seed += 1) {
            const map = shouldUseRuntimeConstrainedPreview()
              ? buildConstrainedFloorPreview(
                  settings.floorConstraint as PreviewFloorId,
                  seed,
                  undefined,
                ).floorMap!
              : (() => {
                  const config = buildConfig();
                  const generator = getGenerator(config.biome);
                  return generator.generate({ ...config, seed }, new SeededRandom(seed));
                })();
            const sealed = findSealedRooms(map, floodFromSpawn(map));
            if (sealed.length > 0) offenders.push(`${seed}:[${sealed.join(',')}]`);
          }
          sweepEl.textContent =
            offenders.length === 0
              ? `Seed sweep (${settings.biome}, seeds 1-${count}): every room reachable ✅`
              : `Seed sweep (${settings.biome}, seeds 1-${count}): ${offenders.length} sealed ❌\n${offenders.join('\n')}`;
        },
      },
      'sweep',
    )
    .name('🧭 Seed Sweep');
  setControllerTooltip(
    sweepCtl,
    'Run deterministic seed sweep and report sealed-room failures for the active generation configuration.',
  );

  const hint = document.createElement('p');
  hint.textContent =
    'Unified map-gen lab: floor constraints, biome knobs, and composable overlays. ' +
    'Hover map markers for tooltips (areas, NPCs, special mobs/rooms, door criteria).';
  hint.style.marginTop = '16px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';
  controls.appendChild(hint);

  function updateCaveControlsVisibility(): void {
    caveFolder.domElement.style.display = settings.biome === BiomeType.CAVE_SYSTEM ? '' : 'none';
  }

  const ro = new ResizeObserver(() => {
    resizeCanvas();
    if (currentMap) render();
  });
  ro.observe(canvasHost);

  setRegenerationStatus('ready');
  applyFloorDefaultsIfEnabled();
  gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  updateCaveControlsVisibility();
  queueGenerate(true);

  return () => {
    ro.disconnect();
    canvas.removeEventListener('mousedown', onMouseDown);
    canvas.removeEventListener('mousemove', onMouseDrag);
    canvas.removeEventListener('mouseup', onMouseUp);
    hideTooltip();
    zoomBar.remove();
    canvas.remove();
    tooltipEl.remove();
    statsEl.remove();
    sweepEl.remove();
    legendEl.remove();
    hint.remove();
  };
}

registerLab('map-gen-lab', {
  category: 'Movement & Physics',
  name: 'Map Generation Lab',
  description:
    'Unified map generation sandbox with floor constraints, cave-system tuning, overlays, tooltips, and legend.',
  create: createMapGenLab,
});
