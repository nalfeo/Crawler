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
import { getAvailableFloorIds, getFloorManifest } from '../../shared/floor-registry.js';
import { loadFamilies } from '../../shared/data/families.js';
import { getNpcDef } from '../../shared/npc-types.js';
import { SeededRandom } from '../../shared/random.js';
import { getFloorEnemyPack } from '../../shared/enemy-packs.js';
import {
  BiomeType,
  RoomRole,
  TerrainType,
  TileFlags,
  type MapConfig,
  type RoomData,
} from '../../shared/map-types.js';
import { FloorMap } from '../../core/map/FloorMap.js';
import { TileMap } from '../../core/map/TileMap.js';
import { RoomGraph } from '../../core/map/RoomGraph.js';
import { carveSetPieceRoom } from '../../core/map/carveSetPieceRoom.js';
import { getSpawnerArchetypeByIndex } from '../../game/spawners/registry.js';
import type { SpawnerArchetype } from '../../game/spawners/types.js';
import {
  buildConstrainedFloorPreview,
  getFloorConstraintDefaults,
  type PreviewFloorId,
} from './runtime-preview.js';
import {
  buildHoverTooltipContent,
  collectHoverTargetsAtPoint,
  type HoverTooltipTarget,
} from './hover-utils.js';
import {
  buildSpawnTableRows,
  type SpawnQuadrantId,
  type SpawnTableQuadrantEntry,
  type SpawnTableRow,
} from './spawn-table-model.js';
import { stampSetPiece, type StampedSetPiece } from '../../core/map/stampSetPiece.js';
import { getSetPieceDef, getSetPieceFootprint } from '../../shared/set-piece-types.js';
import { SHEETS } from '../../engine/sprites/index.js';
import { TILE_SPRITES, resolveFrame } from '../../engine/sprites/tile-visuals.js';
import { TERRAIN_FALLBACK_COLORS, colorToCss } from '../../shared/terrain-colors.js';

const LAB_ID = 'map-gen-lab';
const CELL_SIZE = 8;
const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 60;
type FloorConstraintId = 'none' | 'floor1' | 'floor2';

type HoverTarget = HoverTooltipTarget;

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
  caveResourceHeartDiameterTiles: number;
  caveTerritoryRadiusFraction: number;
  caveDenStartAngleJitterFraction: number;
  caveDenDistanceJitterFraction: number;
  caveDenTargetRadiusMinFraction: number;
  caveDenTargetRadiusMaxFraction: number;
  caveDenTargetMinSeparationTiles: number;
  caveSpawnMinDistanceFromDenTiles: number;
  caveSpawnMinDistanceFromResourceHeartTiles: number;
  caveSpawnMinDistanceFromSettlementTiles: number;
  caveSettlementMinDistanceFromDenTiles: number;
  caveSettlementMinDistanceFromResourceHeartTiles: number;
  caveRegionSeparationTiles: number;
  caveMaxRetries: number;
  caveCavernWidenPasses: number;
  caveStraightHallwayMinRun: number;
  showRooms: boolean;
  showDoors: boolean;
  showSpawn: boolean;
  showReachability: boolean;
  showSetPiece: boolean;
  showSpawnZones: boolean;
  showFamilyTerritories: boolean;
  showNpcPositions: boolean;
  showQuestItems: boolean;
  showSpecialMobs: boolean;
  showSpecialRooms: boolean;
  showLegend: boolean;
  showSpriteMode: boolean;
  showCoverageOverlay: boolean;
}

// The set piece the overlay stamps into a generated room, and the anchor-role
// tint used for its NPC markers (matches the set-piece lab).
const OVERLAY_SET_PIECE_ID = 'welcome-room';
const NPC_ANCHOR_COLOR: Record<string, string> = {
  welcome: '#fbbf24',
  shop: '#22c55e',
  spell: '#a855f7',
};
const NPC_DEFAULT_COLOR = '#38bdf8';

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

/** CSS hex strings for sprite-mode fallbacks, derived from the engine fallback colour table. */
const TERRAIN_FALLBACK_CSS: Record<number, string> = Object.fromEntries(
  Object.entries(TERRAIN_FALLBACK_COLORS).map(([k, v]) => [k, colorToCss(v)]),
);

interface SheetImage {
  img: HTMLImageElement;
  loaded: boolean;
  error: boolean;
  frameWidth: number;
  frameHeight: number;
  spacing: number;
  cols: number;
}

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

const QUADRANT_NEIGHBORS: Record<'N' | 'S' | 'E' | 'W', readonly [string, string, string]> = {
  N: ['E', 'S', 'W'],
  S: ['N', 'W', 'E'],
  E: ['N', 'W', 'S'],
  W: ['S', 'E', 'N'],
};

interface SpawnZoneContext {
  readonly ambientPack?: ReturnType<typeof getFloorEnemyPack>;
  readonly includeGlobalAmbient: boolean;
  readonly quadrants: readonly SpawnTableQuadrantEntry[];
}

function normalizeQuadrantId(quadrant: string): SpawnQuadrantId | null {
  return quadrant === 'N' || quadrant === 'S' || quadrant === 'E' || quadrant === 'W'
    ? quadrant
    : null;
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

/**
 * Pick the room to stamp the overlay set piece into: the largest-interior room
 * that can hold the footprint, falling back to the largest room overall. Pure.
 * Returns -1 when the floor has no rooms.
 */
function pickSetPieceRoomIndex(
  map: FloorMap,
  footprint: { width: number; height: number },
): number {
  const rooms = map.rooms;
  let bestFit = -1;
  let bestFitArea = -1;
  let bestAny = -1;
  let bestAnyArea = -1;
  for (let i = 0; i < rooms.length; i++) {
    const b = rooms[i]!.bounds;
    // Interior = 1-tile inset (border tiles are walls).
    const interiorW = b.width - 2;
    const interiorH = b.height - 2;
    const area = interiorW * interiorH;
    if (area > bestAnyArea) {
      bestAnyArea = area;
      bestAny = i;
    }
    if (interiorW >= footprint.width && interiorH >= footprint.height && area > bestFitArea) {
      bestFitArea = area;
      bestFit = i;
    }
  }
  return bestFit >= 0 ? bestFit : bestAny;
}

function createMapGenLab(canvasHost: HTMLElement, controls: HTMLElement): () => void {
  const gui = (controls as HTMLElement & { __labGui?: GUI }).__labGui;
  if (!(gui instanceof GUI)) throw new Error('Lab runner did not initialize lil-gui.');

  const initialFloor = (
    getAvailableFloorIds().includes('floor1') ? 'floor1' : 'none'
  ) as FloorConstraintId;
  type SavedMapGenLabState = Partial<MapGenLabSettings> & {
    showGlobalSpawnZone?: boolean;
    showTrashSpawnAreas?: boolean;
  };
  const savedState = loadLabState<SavedMapGenLabState>(LAB_ID);
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
    caveResourceHeartDiameterTiles: 20,
    caveTerritoryRadiusFraction: 0.3,
    caveDenStartAngleJitterFraction: 1.0,
    caveDenDistanceJitterFraction: 1.0,
    caveDenTargetRadiusMinFraction: 0.6,
    caveDenTargetRadiusMaxFraction: 0.8,
    caveDenTargetMinSeparationTiles: 12,
    caveSpawnMinDistanceFromDenTiles: 24,
    caveSpawnMinDistanceFromResourceHeartTiles: 24,
    caveSpawnMinDistanceFromSettlementTiles: 24,
    caveSettlementMinDistanceFromDenTiles: 20,
    caveSettlementMinDistanceFromResourceHeartTiles: 16,
    caveRegionSeparationTiles: 0,
    caveMaxRetries: 8,
    caveCavernWidenPasses: 2,
    caveStraightHallwayMinRun: 10,
    showRooms: true,
    showDoors: true,
    showSpawn: true,
    showReachability: true,
    showSetPiece: false,
    showSpawnZones: true,
    showFamilyTerritories: true,
    showNpcPositions: true,
    showQuestItems: true,
    showSpecialMobs: true,
    showSpecialRooms: true,
    showLegend: true,
    showSpriteMode: false,
    showCoverageOverlay: false,
    ...savedState,
  };
  if (
    savedState &&
    savedState.showSpawnZones === undefined &&
    (savedState.showGlobalSpawnZone !== undefined || savedState.showTrashSpawnAreas !== undefined)
  ) {
    settings.showSpawnZones = Boolean(
      savedState.showGlobalSpawnZone || savedState.showTrashSpawnAreas,
    );
  }

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

  const errorEl = document.createElement('pre');
  errorEl.style.marginTop = '8px';
  errorEl.style.padding = '12px';
  errorEl.style.background = 'rgba(127, 29, 29, 0.35)';
  errorEl.style.border = '1px solid rgba(248, 113, 113, 0.45)';
  errorEl.style.borderRadius = '8px';
  errorEl.style.color = '#fecaca';
  errorEl.style.fontSize = '12px';
  errorEl.style.fontFamily = 'monospace';
  errorEl.style.lineHeight = '1.5';
  errorEl.style.whiteSpace = 'pre-wrap';
  errorEl.style.display = 'none';
  canvasHost.appendChild(errorEl);

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

  const spawnTableHost = document.createElement('div');
  spawnTableHost.style.marginTop = '8px';
  spawnTableHost.style.padding = '12px';
  spawnTableHost.style.background = 'rgba(8, 12, 24, 0.6)';
  spawnTableHost.style.borderRadius = '8px';
  spawnTableHost.style.color = '#d1defd';
  spawnTableHost.style.fontSize = '12px';
  spawnTableHost.style.fontFamily = 'monospace';
  spawnTableHost.style.lineHeight = '1.55';
  canvasHost.appendChild(spawnTableHost);

  const spawnTableTitle = document.createElement('div');
  spawnTableTitle.textContent = 'Spawn Regions';
  spawnTableTitle.style.fontWeight = '700';
  spawnTableTitle.style.marginBottom = '8px';
  spawnTableHost.appendChild(spawnTableTitle);

  const spawnTableEl = document.createElement('table');
  spawnTableEl.style.width = '100%';
  spawnTableEl.style.borderCollapse = 'collapse';
  spawnTableEl.style.fontSize = '12px';
  spawnTableEl.style.tableLayout = 'fixed';
  spawnTableHost.appendChild(spawnTableEl);

  let currentMap: FloorMap | null = null;
  let currentPreviewWorld: GameWorld | null = null;
  let currentReachable: Uint8Array | null = null;
  let currentSealed: number[] = [];
  let hoverTargets: HoverTarget[] = [];
  let generationMs = 0;
  let isGenerating = false;
  let pendingRegeneration = false;
  let generationQueued = false;
  let lastGenerationError: string | null = null;
  let currentSpawnRows: SpawnTableRow[] = [];

  // ── per-map caches (invalidated on generateNow) ───────────────────────────
  let cachedTerrainCanvas: HTMLCanvasElement | null = null;
  interface DoorCacheEntry {
    room: RoomData | undefined;
    hasLock: boolean;
    lines: string[];
    x: number;
    y: number;
  }
  let cachedDoorMap: Map<string, DoorCacheEntry> | null = null;
  let cachedRoomAnnotations: Map<number, HoverTarget> | null = null;
  // RAF handle for pan-drag throttling
  let rafDragId: number | null = null;

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

  // ── Sprite sheet infrastructure (used when showSpriteMode or showCoverageOverlay) ──
  const spriteSheets = new Map<string, SheetImage>();
  const spriteSheetKeysInUse = new Set(
    Object.values(TILE_SPRITES)
      .filter((visual): visual is NonNullable<typeof visual> => visual !== undefined)
      .map((visual) => visual.sheetKey),
  );
  for (const sheet of SHEETS) {
    if (!spriteSheetKeysInUse.has(sheet.key)) continue;
    const entry: SheetImage = {
      img: new Image(),
      loaded: false,
      error: false,
      frameWidth: sheet.frameWidth,
      frameHeight: sheet.frameHeight,
      spacing: sheet.spacing,
      cols: sheet.cols,
    };
    entry.img.addEventListener('load', () => {
      entry.loaded = true;
      if (settings.showSpriteMode || settings.showCoverageOverlay) {
        cachedTerrainCanvas = null;
        render();
      }
    });
    entry.img.addEventListener('error', () => {
      entry.error = true;
      if (settings.showSpriteMode || settings.showCoverageOverlay) {
        cachedTerrainCanvas = null;
        render();
      }
    });
    entry.img.src = sheet.path;
    spriteSheets.set(sheet.key, entry);
  }

  function drawSpriteFrame(
    sctx: CanvasRenderingContext2D,
    sheet: SheetImage,
    frame: number,
    destX: number,
    destY: number,
    destW: number,
    destH: number,
  ): void {
    const col = frame % sheet.cols;
    const row = Math.floor(frame / sheet.cols);
    const srcX = col * (sheet.frameWidth + sheet.spacing);
    const srcY = row * (sheet.frameHeight + sheet.spacing);
    sctx.drawImage(
      sheet.img,
      srcX,
      srcY,
      sheet.frameWidth,
      sheet.frameHeight,
      destX,
      destY,
      destW,
      destH,
    );
  }

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
    settings.caveResourceHeartDiameterTiles = defaults.caveResourceHeartDiameterTiles;
    settings.caveTerritoryRadiusFraction = defaults.caveTerritoryRadiusFraction;
    settings.caveDenStartAngleJitterFraction = defaults.caveDenStartAngleJitterFraction;
    settings.caveDenDistanceJitterFraction = defaults.caveDenDistanceJitterFraction;
    settings.caveDenTargetRadiusMinFraction = defaults.caveDenTargetRadiusMinFraction;
    settings.caveDenTargetRadiusMaxFraction = defaults.caveDenTargetRadiusMaxFraction;
    settings.caveDenTargetMinSeparationTiles = defaults.caveDenTargetMinSeparationTiles;
    settings.caveSpawnMinDistanceFromDenTiles = defaults.caveSpawnMinDistanceFromDenTiles;
    settings.caveSpawnMinDistanceFromResourceHeartTiles =
      defaults.caveSpawnMinDistanceFromResourceHeartTiles;
    settings.caveSpawnMinDistanceFromSettlementTiles =
      defaults.caveSpawnMinDistanceFromSettlementTiles;
    settings.caveSettlementMinDistanceFromDenTiles = defaults.caveSettlementMinDistanceFromDenTiles;
    settings.caveSettlementMinDistanceFromResourceHeartTiles =
      defaults.caveSettlementMinDistanceFromResourceHeartTiles;
    settings.caveRegionSeparationTiles = defaults.caveRegionSeparationTiles;
    settings.caveMaxRetries = defaults.caveMaxRetries;
    settings.caveCavernWidenPasses = defaults.caveCavernWidenPasses;
    settings.caveStraightHallwayMinRun = defaults.caveStraightHallwayMinRun;
  }

  function buildConfig(): MapConfig {
    const widthTiles = clampInt(settings.widthTiles, 20, 400);
    const heightTiles = clampInt(settings.heightTiles, 20, 300);
    const maxRegionSeparationTiles = Math.max(
      1,
      Math.floor(Math.hypot(widthTiles - 1, heightTiles - 1)),
    );
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
              resourceHeartDiameterTiles: clampInt(settings.caveResourceHeartDiameterTiles, 10, 48),
              territoryRadiusFraction: Math.max(
                0.1,
                Math.min(1.6, settings.caveTerritoryRadiusFraction),
              ),
              denStartAngleJitterFraction: Math.max(
                0,
                Math.min(1.0, settings.caveDenStartAngleJitterFraction),
              ),
              denDistanceJitterFraction: Math.max(
                0,
                Math.min(1.0, settings.caveDenDistanceJitterFraction),
              ),
              denTargetRadiusMinFraction: Math.max(
                0.2,
                Math.min(0.95, settings.caveDenTargetRadiusMinFraction),
              ),
              denTargetRadiusMaxFraction: Math.max(
                Math.max(0.2, Math.min(0.95, settings.caveDenTargetRadiusMinFraction)),
                Math.min(0.98, settings.caveDenTargetRadiusMaxFraction),
              ),
              denTargetMinSeparationTiles: clampInt(
                settings.caveDenTargetMinSeparationTiles,
                6,
                Math.max(widthTiles, heightTiles),
              ),
              spawnMinDistanceFromDenTiles: clampInt(
                settings.caveSpawnMinDistanceFromDenTiles,
                0,
                Math.max(widthTiles, heightTiles),
              ),
              spawnMinDistanceFromResourceHeartTiles: clampInt(
                settings.caveSpawnMinDistanceFromResourceHeartTiles,
                0,
                Math.max(widthTiles, heightTiles),
              ),
              spawnMinDistanceFromSettlementTiles: clampInt(
                settings.caveSpawnMinDistanceFromSettlementTiles,
                0,
                Math.max(widthTiles, heightTiles),
              ),
              settlementMinDistanceFromDenTiles: clampInt(
                settings.caveSettlementMinDistanceFromDenTiles,
                0,
                Math.max(widthTiles, heightTiles),
              ),
              settlementMinDistanceFromResourceHeartTiles: clampInt(
                settings.caveSettlementMinDistanceFromResourceHeartTiles,
                0,
                Math.max(widthTiles, heightTiles),
              ),
              regionSeparationTiles: clampInt(
                settings.caveRegionSeparationTiles,
                0,
                maxRegionSeparationTiles,
              ),
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

  /** Build offscreen terrain canvas once per map — reused by every render().
   *  In sprite mode, replaces colour blocks with scaled Kenney sprite frames.
   *  The coverage overlay bakes green/red tints into the offscreen canvas so
   *  the main render pass sees sprite-covered (green tint) vs fallback (red tint) tiles.
   */
  function buildTerrainCanvas(map: FloorMap): HTMLCanvasElement {
    const offscreen = document.createElement('canvas');
    offscreen.width = map.width * CELL_SIZE;
    offscreen.height = map.height * CELL_SIZE;
    const octx = offscreen.getContext('2d')!;
    octx.imageSmoothingEnabled = false;
    const spriteMode = settings.showSpriteMode;
    const coverageMode = settings.showCoverageOverlay;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const idx = y * map.width + x;
        const terrainType = map.terrain[idx] as number;
        const dx = x * CELL_SIZE;
        const dy = y * CELL_SIZE;

        if (spriteMode || coverageMode) {
          const tileInfo = TILE_SPRITES[terrainType as TerrainType];
          const sheet = tileInfo ? spriteSheets.get(tileInfo.sheetKey) : undefined;
          const frame = tileInfo
            ? resolveFrame(
                tileInfo,
                map.terrain as Uint8Array,
                map.width,
                map.height,
                x,
                y,
                terrainType as TerrainType,
              )
            : undefined;
          const covered = frame !== undefined;

          if (spriteMode && covered && sheet?.loaded && !sheet.error) {
            drawSpriteFrame(octx, sheet, frame!, dx, dy, CELL_SIZE, CELL_SIZE);
          } else {
            octx.fillStyle =
              TERRAIN_FALLBACK_CSS[terrainType] ?? TERRAIN_COLORS[terrainType] ?? '#0a0a0f';
            octx.fillRect(dx, dy, CELL_SIZE, CELL_SIZE);
          }

          if (coverageMode && terrainType !== TerrainType.VOID) {
            octx.fillStyle = covered ? 'rgba(0,255,0,0.35)' : 'rgba(255,0,0,0.35)';
            octx.fillRect(dx, dy, CELL_SIZE, CELL_SIZE);
          }
        } else {
          octx.fillStyle = TERRAIN_COLORS[terrainType] ?? '#0a0a0f';
          octx.fillRect(dx, dy, CELL_SIZE, CELL_SIZE);
        }
      }
    }
    return offscreen;
  }

  /** Pre-compute door metadata once per map — replaces O(rooms+doors) per-render scans. */
  function buildDoorCacheForMap(map: FloorMap): Map<string, DoorCacheEntry> {
    // Index doors → room in O(rooms)
    const doorTileToRoom = new Map<string, RoomData>();
    for (const room of map.rooms) {
      for (const door of room.doors) {
        doorTileToRoom.set(`${door.x},${door.y}`, room);
      }
    }
    // Index ECS door entities → tile in O(door_entities)
    const doorEidByTile = new Map<string, number>();
    if (currentPreviewWorld) {
      for (const doorEid of query(currentPreviewWorld.ecs, [DoorState])) {
        const tx = currentPreviewWorld.stores.doorState.tileX[doorEid];
        const ty = currentPreviewWorld.stores.doorState.tileY[doorEid];
        if (tx !== undefined && ty !== undefined) {
          doorEidByTile.set(`${tx},${ty}`, doorEid);
        }
      }
    }
    // Build final cache — one entry per door tile
    const cache = new Map<string, DoorCacheEntry>();
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const idx = y * map.width + x;
        if ((map.flags[idx]! & TileFlags.DOOR) === 0) continue;
        const key = `${x},${y}`;
        const room = doorTileToRoom.get(key);
        const doorEid = doorEidByTile.get(key);
        let hasLock = false;
        let lines: string[];
        if (doorEid !== undefined && currentPreviewWorld) {
          const config = currentPreviewWorld.doorLockConfigs.get(doorEid);
          hasLock = config !== undefined;
          lines = config
            ? [
                ...formatDoorConditionGroup('Unlock', config.unlock),
                ...(config.relock ? formatDoorConditionGroup('Relock', config.relock) : []),
              ]
            : ['Unlock criteria: none (runtime ambient door)'];
        } else {
          lines = room
            ? doorCriteriaForRoom(room, settings.floorConstraint)
            : ['Unlock criteria: unknown'];
        }
        cache.set(key, { room, hasLock, lines, x, y });
      }
    }
    return cache;
  }

  function familyNameForIndex(familyIndex: number): string {
    const familyId =
      currentPreviewWorld?.floorExtendedState?.familyState?.presentFamilies[familyIndex];
    return (familyId && FAMILY_NAME_BY_ID.get(familyId)) ?? `Family ${familyIndex}`;
  }

  function familyNameForRoom(room: RoomData): string {
    if (room.familyIndex === undefined) return '';
    return familyNameForIndex(room.familyIndex);
  }

  function formatRoleLabel(room: RoomData): string {
    if (room.familyIndex === undefined) return room.role;
    return `${room.role} • ${familyNameForRoom(room)}`;
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

  function drawCircularRoomOverlay(room: RoomData, fillStyle: string): void {
    const interior = room.interiorCells ?? [];
    if (interior.length === 0) {
      ctx.fillStyle = fillStyle;
      ctx.fillRect(
        room.bounds.x * CELL_SIZE,
        room.bounds.y * CELL_SIZE,
        room.bounds.width * CELL_SIZE,
        room.bounds.height * CELL_SIZE,
      );
      return;
    }
    ctx.fillStyle = fillStyle;
    for (const tile of interior) {
      ctx.fillRect(tile.x * CELL_SIZE, tile.y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
    }
  }

  function drawResourceHeartStroke(room: RoomData, strokeStyle: string): HoverTarget {
    const center = roomCenter(room);
    const cx = center.tx * CELL_SIZE + CELL_SIZE / 2;
    const cy = center.ty * CELL_SIZE + CELL_SIZE / 2;
    const interior = room.interiorCells ?? [];
    let radiusPx = Math.max(
      CELL_SIZE,
      Math.min(room.bounds.width, room.bounds.height) * CELL_SIZE * 0.45,
    );
    if (interior.length > 0) {
      let farthest = 0;
      for (const tile of interior) {
        const tx = tile.x * CELL_SIZE + CELL_SIZE / 2;
        const ty = tile.y * CELL_SIZE + CELL_SIZE / 2;
        farthest = Math.max(farthest, Math.hypot(tx - cx, ty - cy));
      }
      radiusPx = Math.max(CELL_SIZE, farthest + CELL_SIZE * 0.5);
    }
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radiusPx, 0, Math.PI * 2);
    ctx.stroke();
    return {
      kind: 'point',
      x: cx,
      y: cy,
      radius: radiusPx,
      title: roomDisplayName(room, settings.floorConstraint),
      lines: [formatRoleLabel(room), `room=${room.id}`],
    };
  }

  function render(): void {
    if (!currentMap) return;
    hoverTargets = [];
    const map = currentMap;
    const floorAttached = settings.applyFloorConstraints && settings.floorConstraint !== 'none';
    const spawnZoneContext = buildSpawnZoneContext();
    const roomAnnotations = cachedRoomAnnotations ?? buildRoomAnnotations(map);
    cachedRoomAnnotations ??= roomAnnotations;
    const doorCache = cachedDoorMap ?? buildDoorCacheForMap(map);
    cachedDoorMap ??= doorCache;
    const terrainCanvas = cachedTerrainCanvas ?? buildTerrainCanvas(map);
    cachedTerrainCanvas ??= terrainCanvas;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(zoom, zoom);

    // Terrain — single drawImage instead of O(w*h) fillRects
    ctx.drawImage(terrainCanvas, 0, 0);

    const w = map.width;
    const h = map.height;
    const mapPixelW = w * CELL_SIZE;
    const mapPixelH = h * CELL_SIZE;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, mapPixelW, mapPixelH);
    ctx.clip();

    if (floorAttached && settings.showSpawnZones && spawnZoneContext.includeGlobalAmbient) {
      const globalLine =
        spawnZoneContext.ambientPack !== undefined
          ? `Ambient cadence ${spawnZoneContext.ambientPack.spawnIntervalMs}ms (shared cap ${spawnZoneContext.ambientPack.enemyCap})`
          : 'Ambient/global spawn coverage';
      ctx.fillStyle = 'rgba(129, 140, 248, 0.05)';
      ctx.fillRect(0, 0, w * CELL_SIZE, h * CELL_SIZE);
      hoverTargets.push({
        kind: 'rect',
        x: 0,
        y: 0,
        width: w * CELL_SIZE,
        height: h * CELL_SIZE,
        title: 'Global spawn zone',
        lines: [globalLine],
      });
    }

    if (
      floorAttached &&
      settings.showSpawnZones &&
      map.config.biome === BiomeType.CAVE_SYSTEM &&
      spawnZoneContext.quadrants.length > 0
    ) {
      const quadrantAssignments = new Map(
        spawnZoneContext.quadrants.map((entry) => [entry.quadrant, entry.archetypeName] as const),
      );
      const midX = Math.floor(w / 2);
      const midY = Math.floor(h / 2);
      const quadrants = [
        { id: 'N' as const, x0: 0, y0: 0, x1: midX, y1: midY, color: 'rgba(148, 163, 184, 0.08)' },
        {
          id: 'S' as const,
          x0: 0,
          y0: midY,
          x1: midX,
          y1: h,
          color: 'rgba(148, 163, 184, 0.12)',
        },
        {
          id: 'E' as const,
          x0: midX,
          y0: 0,
          x1: w,
          y1: midY,
          color: 'rgba(148, 163, 184, 0.16)',
        },
        {
          id: 'W' as const,
          x0: midX,
          y0: midY,
          x1: w,
          y1: h,
          color: 'rgba(148, 163, 184, 0.1)',
        },
      ];
      for (const quadrant of quadrants) {
        const qx = quadrant.x0 * CELL_SIZE;
        const qy = quadrant.y0 * CELL_SIZE;
        const qWidth = (quadrant.x1 - quadrant.x0) * CELL_SIZE;
        const qHeight = (quadrant.y1 - quadrant.y0) * CELL_SIZE;
        const [nearA, nearB, far] = QUADRANT_NEIGHBORS[quadrant.id];
        const primaryName = quadrantAssignments.get(quadrant.id) ?? quadrant.id;
        const nearAName = quadrantAssignments.get(nearA as SpawnQuadrantId) ?? nearA;
        const nearBName = quadrantAssignments.get(nearB as SpawnQuadrantId) ?? nearB;
        const farName = quadrantAssignments.get(far as SpawnQuadrantId) ?? far;
        ctx.fillStyle = quadrant.color;
        ctx.fillRect(qx, qy, qWidth, qHeight);
        hoverTargets.push({
          kind: 'rect',
          x: qx,
          y: qy,
          width: qWidth,
          height: qHeight,
          title: `Trash spawn quadrant ${quadrant.id}`,
          lines: [
            `Primary: ${primaryName} (50%)`,
            `Neighbor: ${nearAName} (20%)`,
            `Neighbor: ${nearBName} (20%)`,
            `Opposite: ${farName} (10%)`,
          ],
        });
      }
      const midPxX = midX * CELL_SIZE;
      const midPxY = midY * CELL_SIZE;
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(midPxX, 0);
      ctx.lineTo(midPxX, h * CELL_SIZE);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(0, midPxY);
      ctx.lineTo(w * CELL_SIZE, midPxY);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = 'rgba(241, 245, 249, 0.88)';
      ctx.font = 'bold 12px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('N', midPxX / 2, midPxY / 2);
      ctx.fillText('S', midPxX / 2, midPxY + midPxY / 2);
      ctx.fillText('E', midPxX + midPxX / 2, midPxY / 2);
      ctx.fillText('W', midPxX + midPxX / 2, midPxY + midPxY / 2);
    }

    if (settings.showRooms) {
      for (let i = 0; i < map.rooms.length; i++) {
        const room = map.rooms[i]!;
        if (room.role === RoomRole.TERRITORY) continue;
        if (room.role === RoomRole.RESOURCE_HEART) {
          drawCircularRoomOverlay(room, ROOM_COLORS[i % ROOM_COLORS.length]!);
          continue;
        }
        ctx.fillStyle = ROOM_COLORS[i % ROOM_COLORS.length]!;
        ctx.fillRect(
          room.bounds.x * CELL_SIZE,
          room.bounds.y * CELL_SIZE,
          room.bounds.width * CELL_SIZE,
          room.bounds.height * CELL_SIZE,
        );
      }
    }

    if (settings.showFamilyTerritories && map.config.biome === BiomeType.CAVE_SYSTEM) {
      for (const zone of map.territoryZones ?? []) {
        const familyIndex = zone.familyIndex ?? 0;
        const familyName = familyNameForIndex(familyIndex);
        const px = zone.centerX * CELL_SIZE + CELL_SIZE / 2;
        const py = zone.centerY * CELL_SIZE + CELL_SIZE / 2;
        const pr = zone.radius * CELL_SIZE;
        const color = TERRITORY_COLORS[familyIndex % TERRITORY_COLORS.length]!;
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.beginPath();
        ctx.arc(px, py, pr, 0, Math.PI * 2);
        ctx.strokeStyle = '#e2e8f0';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(px, py, Math.max(3, CELL_SIZE * 0.8), 0, Math.PI * 2);
        ctx.fillStyle = '#f8fafc';
        ctx.fill();
        ctx.fillStyle = '#0f172a';
        ctx.font = 'bold 10px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`T${familyIndex}`, px, py);
        hoverTargets.push({
          kind: 'point',
          x: px,
          y: py,
          radius: pr,
          title: `Family territory zone T${familyIndex}`,
          lines: [
            `family=${familyName}`,
            `center=(${zone.centerX}, ${zone.centerY})`,
            `radius=${zone.radius} tiles`,
            `diameter=${zone.radius * 2} tiles`,
          ],
        });
      }
      for (const room of map.rooms) {
        if (room.role !== RoomRole.BOSS_DEN) continue;
        const center = roomCenter(room);
        const familyIndex = room.familyIndex ?? 0;
        const familyName = familyNameForRoom(room);
        const px = center.tx * CELL_SIZE + CELL_SIZE / 2;
        const py = center.ty * CELL_SIZE + CELL_SIZE / 2;
        ctx.fillStyle = '#fb7185';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`D${familyIndex}`, px, py);
        hoverTargets.push({
          kind: 'point',
          x: px,
          y: py,
          radius: Math.max(8, CELL_SIZE),
          title: `Boss den D${familyIndex}`,
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
        if (room.role === RoomRole.RESOURCE_HEART) {
          const hover = drawResourceHeartStroke(room, stroke);
          hoverTargets.push({
            ...hover,
            title: annotation?.title ?? hover.title,
            lines: [...(annotation?.lines ?? []), formatRoleLabel(room), `room=${room.id}`],
          });
        } else {
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
    }

    if (settings.showDoors) {
      // Use pre-computed door cache — O(door_count) instead of O(w*h) tile scan
      for (const entry of doorCache.values()) {
        const { x, y, hasLock, lines } = entry;
        ctx.fillStyle = '#ed8936';
        ctx.fillRect(x * CELL_SIZE, y * CELL_SIZE, CELL_SIZE, CELL_SIZE);
        if (hasLock) {
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
          lines,
        });
      }
    } else {
      // Overlay off: register hover targets from cache, no tile scan needed
      for (const entry of doorCache.values()) {
        const { x, y, lines } = entry;
        hoverTargets.push({
          kind: 'rect',
          x: x * CELL_SIZE,
          y: y * CELL_SIZE,
          width: CELL_SIZE,
          height: CELL_SIZE,
          title: `Door (${x}, ${y})`,
          lines,
        });
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

    // Overlay: carve the welcome-room prefab into a real generated room and draw
    // its REAL tile output — impassable walls, TileFlags.DOOR doors — plus its
    // render-only props + NPC markers. Uses the SAME pure carveSetPieceRoom the
    // floor scenario uses, so what you see here is the geometry the real game
    // generates (rendered from a throwaway clone so the lab map stays clean).
    if (settings.showSetPiece) {
      drawSetPieceOverlay(currentMap);
    }
  }

  /**
   * Deep-copy a FloorMap enough to run a mutating {@link carveSetPieceRoom} on it
   * without touching the persistent lab map: clones the tile flags + terrain
   * arrays and rebuilds the RoomGraph from copied RoomData records (bounds/doors/
   * neighbors), preserving room ids. FOV/visibility buffers are freshly zeroed by
   * the FloorMap constructor, which is fine for a render-only overlay.
   */
  function cloneFloorMapForCarve(map: FloorMap): FloorMap {
    const flags = map.tileMap.flags.slice();
    const terrain = map.terrain.slice();
    const tileMap = new TileMap(map.width, map.height, flags);
    const rooms: RoomData[] = map.roomGraph.getAll().map((r) => ({
      ...r,
      bounds: { ...r.bounds },
      doors: r.doors.map((d) => ({ ...d })),
      neighbors: [...r.neighbors],
      interiorCells: r.interiorCells ? r.interiorCells.map((c) => ({ ...c })) : undefined,
    }));
    const roomGraph = new RoomGraph(rooms);
    return new FloorMap(map.config, tileMap, roomGraph, terrain, {
      x: map.playerSpawn.x,
      y: map.playerSpawn.y,
    });
  }

  function drawSetPieceOverlay(map: FloorMap): void {
    const def = getSetPieceDef(OVERLAY_SET_PIECE_ID);
    if (!def) return;
    const footprint = getSetPieceFootprint(def);
    const roomIdx = pickSetPieceRoomIndex(map, footprint);
    if (roomIdx < 0) return;
    const room = map.rooms[roomIdx]!;
    const tileSizeFt = map.config.tileSizeFt;

    // Carve the prefab into a throwaway CLONE so we can draw the REAL tile-write
    // output (impassable walls + TileFlags.DOOR doors) the production mapgen path
    // produces, without mutating the persistent lab map (toggling the overlay off
    // must restore a clean render). The lab is a dev aid only — rule #9's
    // observe-before-done still requires the headless reachability gate.
    const clone = cloneFloorMapForCarve(map);
    const cloneRoom = clone.roomGraph.get(room.id)!;
    const carve = carveSetPieceRoom(clone, cloneRoom, def);

    ctx.save();

    if (!carve.fitted || !carve.bounds || !carve.doors) {
      // Prefab did not fit — surface the reason and highlight the rejected room.
      ctx.strokeStyle = '#f87171';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(
        room.bounds.x * CELL_SIZE + 1,
        room.bounds.y * CELL_SIZE + 1,
        room.bounds.width * CELL_SIZE - 2,
        room.bounds.height * CELL_SIZE - 2,
      );
      ctx.setLineDash([]);
      ctx.fillStyle = '#f87171';
      ctx.font = `${Math.max(CELL_SIZE, 9)}px monospace`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(
        `prefab unfit: ${carve.reason}`,
        room.bounds.x * CELL_SIZE + 2,
        room.bounds.y * CELL_SIZE + 2,
      );
      ctx.restore();
      return;
    }

    const bounds = carve.bounds;
    const doorKeys = new Set(carve.doors.map((d) => `${d.x},${d.y}`));

    // 1. Real carved tiles: read the clone's flags across the footprint and paint
    //    walls (impassable), doors (TileFlags.DOOR), and interior floor distinctly.
    for (let ty = bounds.y; ty < bounds.y + bounds.height; ty++) {
      for (let tx = bounds.x; tx < bounds.x + bounds.width; tx++) {
        const idx = ty * clone.width + tx;
        const flag = clone.flags[idx]!;
        const px = tx * CELL_SIZE;
        const py = ty * CELL_SIZE;
        if (doorKeys.has(`${tx},${ty}`) || (flag & TileFlags.DOOR) !== 0) {
          ctx.fillStyle = '#f59e0b';
          ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        } else if ((flag & TileFlags.PASSABLE) === 0) {
          ctx.fillStyle = '#1f2937';
          ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        } else {
          ctx.fillStyle = 'rgba(126, 224, 255, 0.18)';
          ctx.fillRect(px, py, CELL_SIZE, CELL_SIZE);
        }
      }
    }

    // Highlight the carved footprint so the authoritative prefab bounds are clear.
    ctx.strokeStyle = '#7ee0ff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(
      bounds.x * CELL_SIZE + 1,
      bounds.y * CELL_SIZE + 1,
      bounds.width * CELL_SIZE - 2,
      bounds.height * CELL_SIZE - 2,
    );
    ctx.setLineDash([]);

    // 2. Props (render-only sidecars) aligned to the carved footprint, so the
    //    dressing reads in the same front-to-back order as the game.
    const stamp: StampedSetPiece = stampSetPiece(def, { roomBounds: bounds, tileSizeFt });
    for (const prop of stamp.props) {
      const wTiles = prop.render.widthFt / tileSizeFt;
      const hTiles = prop.render.heightFt / tileSizeFt;
      ctx.fillStyle = prop.render.tintHex ? `${prop.render.tintHex}66` : 'rgba(148, 163, 184, 0.4)';
      ctx.fillRect(
        prop.tileX * CELL_SIZE,
        prop.tileY * CELL_SIZE,
        Math.max(CELL_SIZE, wTiles * CELL_SIZE),
        Math.max(CELL_SIZE, hTiles * CELL_SIZE),
      );
      ctx.strokeStyle = 'rgba(226, 232, 240, 0.5)';
      ctx.lineWidth = 1;
      ctx.strokeRect(
        prop.tileX * CELL_SIZE + 0.5,
        prop.tileY * CELL_SIZE + 0.5,
        Math.max(CELL_SIZE, wTiles * CELL_SIZE) - 1,
        Math.max(CELL_SIZE, hTiles * CELL_SIZE) - 1,
      );
    }

    // 3. NPC markers on top, tinted by objective anchor role.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.font = `${Math.max(CELL_SIZE, 9)}px monospace`;
    for (const npc of stamp.npcs) {
      const cx = npc.tileX * CELL_SIZE + CELL_SIZE / 2;
      const cy = npc.tileY * CELL_SIZE + CELL_SIZE / 2;
      const color = (npc.anchorRole && NPC_ANCHOR_COLOR[npc.anchorRole]) ?? NPC_DEFAULT_COLOR;
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(CELL_SIZE / 2, 4), 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#0b0b12';
      ctx.stroke();
      const label = npc.anchorRole ?? npc.npcTypeId;
      ctx.fillStyle = color;
      ctx.fillText(label, cx, cy - Math.max(CELL_SIZE / 2, 4) - 1);
    }
    ctx.restore();
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
    const floorAttached = settings.applyFloorConstraints && settings.floorConstraint !== 'none';
    const isFloor1Attached = floorAttached && settings.floorConstraint === 'floor1';
    const isFloor2Attached = floorAttached && settings.floorConstraint === 'floor2';
    const lines = ['Legend', '======', 'White ring: player spawn', 'Orange square: door tile'];
    if (settings.showDoors) lines.push('Orange tiles: door (dark = closed, 🔒 = locked)');
    if (settings.showRooms) lines.push('Blue/green/etc fill: room bounds');
    if (settings.showReachability) lines.push('Red fill/outline: unreachable or sealed room');
    const spawnZoneContext = buildSpawnZoneContext();
    if (floorAttached && settings.showSpawnZones && spawnZoneContext.includeGlobalAmbient)
      lines.push('Full-map spawn zone: ambient/global director coverage');
    if (floorAttached && settings.showSpawnZones && spawnZoneContext.quadrants.length > 0)
      lines.push('Quadrant overlays: N/S/E/W trash zones with 50/20/20/10 weighting');
    if (isFloor2Attached && settings.showFamilyTerritories)
      lines.push('Circular family territories: T# zone + D# boss-den markers');
    if (floorAttached && settings.showNpcPositions) lines.push('Blue diamonds: NPC positions');
    if (isFloor1Attached && settings.showQuestItems)
      lines.push('Gold diamonds: quest items / objective locations');
    if (settings.showSpecialMobs) lines.push('Red squares/dots: special mobs / spawners');
    if (settings.showSpecialRooms) lines.push('Colored room outlines: special rooms');
    if (settings.showSpriteMode) lines.push('Sprite mode: Kenney tileset replaces colour blocks');
    if (settings.showCoverageOverlay)
      lines.push('🟩 green tint = sprite found  🟥 red tint = colour fallback');
    else if (!settings.showSpriteMode)
      lines.push('Use "Sprite mode" + "Coverage overlay" to audit sprite coverage.');
    lines.push('Hover map markers/areas to inspect details.');
    legendEl.textContent = lines.join('\n');
  }

  function buildSpawnZoneContext(): SpawnZoneContext {
    const manifest =
      settings.floorConstraint !== 'none' ? getFloorManifest(settings.floorConstraint) : undefined;
    const ambientPack =
      manifest?.enemyPackId !== undefined ? getFloorEnemyPack(manifest.enemyPackId) : undefined;
    const territories = currentPreviewWorld?.floorExtendedState?.trashTerritories;
    const quadrants: SpawnTableQuadrantEntry[] = [];
    if (territories && territories.size > 0 && ambientPack) {
      for (const [rawQuadrant, archetypeId] of territories.entries()) {
        const quadrant = normalizeQuadrantId(rawQuadrant);
        if (!quadrant) continue;
        const archetypeName =
          ambientPack.archetypes.find((entry) => entry.id === archetypeId)?.name ?? archetypeId;
        quadrants.push({
          quadrant,
          archetypeId,
          archetypeName,
        });
      }
      const quadrantOrder: Record<SpawnQuadrantId, number> = { N: 0, S: 1, E: 2, W: 3 };
      quadrants.sort((a, b) => quadrantOrder[a.quadrant] - quadrantOrder[b.quadrant]);
    }
    const includeGlobalAmbient = settings.floorConstraint !== 'floor2';
    return {
      ambientPack,
      includeGlobalAmbient,
      quadrants,
    };
  }

  function collectSpawnRows(map: FloorMap): SpawnTableRow[] {
    const spawnZoneContext = buildSpawnZoneContext();
    const floorFamilies =
      currentPreviewWorld?.floorExtendedState?.familyState?.presentFamilies ?? [];
    const territories = map.territoryZones.map((zone, index) => {
      const familyId = floorFamilies[zone.familyIndex];
      const familyName = familyId
        ? (FAMILY_NAME_BY_ID.get(familyId) ?? `Family ${zone.familyIndex}`)
        : `Family ${zone.familyIndex}`;
      return {
        region: `Territory T${zone.familyIndex} (#${index})`,
        familyId,
        familyName,
      };
    });
    const bossDens = map.rooms
      .filter((room) => room.role === RoomRole.BOSS_DEN)
      .map((room) => {
        const familyIndex = room.familyIndex ?? -1;
        const familyId = familyIndex >= 0 ? floorFamilies[familyIndex] : undefined;
        return {
          region: `Boss den D${familyIndex >= 0 ? familyIndex : '?'} (room ${room.id})`,
          familyId,
          familyName: familyIndex >= 0 ? familyNameForIndex(familyIndex) : 'Unknown family',
        };
      });
    const spawners: Array<{ region: string; archetype: SpawnerArchetype }> = [];
    if (currentPreviewWorld !== null) {
      for (const eid of query(currentPreviewWorld.ecs, [Spawner])) {
        const archetype = getSpawnerArchetypeByIndex(
          currentPreviewWorld.stores.spawner.defIndex[eid] ?? -1,
        );
        if (!archetype) continue;
        const x = currentPreviewWorld.stores.position.x[eid] ?? Number.NaN;
        const y = currentPreviewWorld.stores.position.y[eid] ?? Number.NaN;
        if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
        const tile = map.worldToTile(x, y);
        const roomId = map.roomGraph.getRoomAt(tile.x, tile.y);
        const region =
          roomId >= 0
            ? `${roomDisplayName(map.rooms[roomId]!, settings.floorConstraint)} (room ${roomId})`
            : `Open cavern (${tile.x}, ${tile.y})`;
        spawners.push({ region, archetype });
      }
    }

    return buildSpawnTableRows({
      biome: map.config.biome,
      ambientPack: spawnZoneContext.ambientPack,
      includeGlobalAmbient: spawnZoneContext.includeGlobalAmbient,
      quadrants: spawnZoneContext.quadrants,
      spawners,
      territories,
      bossDens,
    });
  }

  function updateSpawnTable(): void {
    const floorAttached = settings.applyFloorConstraints && settings.floorConstraint !== 'none';
    spawnTableHost.style.display = floorAttached ? 'block' : 'none';
    if (!floorAttached) {
      return;
    }
    spawnTableEl.textContent = '';
    if (currentSpawnRows.length === 0) {
      const emptyRow = document.createElement('tr');
      const emptyCell = document.createElement('td');
      emptyCell.colSpan = 5;
      emptyCell.textContent = 'No spawn-region metadata available for the current map.';
      emptyCell.style.padding = '6px 8px';
      emptyCell.style.borderBottom = '1px solid rgba(51, 65, 85, 0.6)';
      emptyRow.appendChild(emptyCell);
      spawnTableEl.appendChild(emptyRow);
      return;
    }
    const header = document.createElement('tr');
    for (const [label, width] of [
      ['Region', '20%'],
      ['Mobs', '32%'],
      ['How many', '16%'],
      ['How often', '14%'],
      ['Trigger', '18%'],
    ] as const) {
      const th = document.createElement('th');
      th.textContent = label;
      th.style.textAlign = 'left';
      th.style.verticalAlign = 'top';
      th.style.borderBottom = '1px solid rgba(148, 163, 184, 0.5)';
      th.style.padding = '6px 8px';
      th.style.width = width;
      header.appendChild(th);
    }
    spawnTableEl.appendChild(header);

    for (const row of currentSpawnRows) {
      const tr = document.createElement('tr');
      for (const value of [row.region, row.mobs, row.quantity, row.cadence, row.trigger]) {
        const td = document.createElement('td');
        td.textContent = value;
        td.style.padding = '6px 8px';
        td.style.verticalAlign = 'top';
        td.style.borderBottom = '1px solid rgba(51, 65, 85, 0.6)';
        td.style.wordBreak = 'break-word';
        tr.appendChild(td);
      }
      spawnTableEl.appendChild(tr);
    }
  }

  function updateGenerationError(): void {
    if (!lastGenerationError) {
      errorEl.style.display = 'none';
      return;
    }
    errorEl.style.display = 'block';
    errorEl.textContent = `Generation failed:\n${lastGenerationError}`;
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
      settings.caveResourceHeartDiameterTiles === defaults.caveResourceHeartDiameterTiles &&
      eq(settings.caveTerritoryRadiusFraction, defaults.caveTerritoryRadiusFraction) &&
      eq(settings.caveDenStartAngleJitterFraction, defaults.caveDenStartAngleJitterFraction) &&
      eq(settings.caveDenDistanceJitterFraction, defaults.caveDenDistanceJitterFraction) &&
      eq(settings.caveDenTargetRadiusMinFraction, defaults.caveDenTargetRadiusMinFraction) &&
      eq(settings.caveDenTargetRadiusMaxFraction, defaults.caveDenTargetRadiusMaxFraction) &&
      settings.caveDenTargetMinSeparationTiles === defaults.caveDenTargetMinSeparationTiles &&
      settings.caveSpawnMinDistanceFromDenTiles === defaults.caveSpawnMinDistanceFromDenTiles &&
      settings.caveSpawnMinDistanceFromResourceHeartTiles ===
        defaults.caveSpawnMinDistanceFromResourceHeartTiles &&
      settings.caveSpawnMinDistanceFromSettlementTiles ===
        defaults.caveSpawnMinDistanceFromSettlementTiles &&
      settings.caveSettlementMinDistanceFromDenTiles ===
        defaults.caveSettlementMinDistanceFromDenTiles &&
      settings.caveSettlementMinDistanceFromResourceHeartTiles ===
        defaults.caveSettlementMinDistanceFromResourceHeartTiles &&
      settings.caveRegionSeparationTiles === defaults.caveRegionSeparationTiles &&
      settings.caveMaxRetries === defaults.caveMaxRetries &&
      settings.caveCavernWidenPasses === defaults.caveCavernWidenPasses &&
      settings.caveStraightHallwayMinRun === defaults.caveStraightHallwayMinRun
    );
  }

  function generateNow(): void {
    // Invalidate all render caches
    cachedTerrainCanvas = null;
    cachedDoorMap = null;
    cachedRoomAnnotations = null;

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
    currentSpawnRows = collectSpawnRows(currentMap);
    fitToFrame();
    render();
    updateStats();
    updateLegend();
    updateSpawnTable();
    lastGenerationError = null;
    updateGenerationError();
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
      } catch (error) {
        lastGenerationError = error instanceof Error ? error.message : String(error);
        updateGenerationError();
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

  function hitTestHoverTargets(x: number, y: number): HoverTarget[] {
    return collectHoverTargetsAtPoint(hoverTargets, x, y);
  }

  function showTooltip(targets: readonly HoverTarget[], screenX: number, screenY: number): void {
    const tooltip = buildHoverTooltipContent(targets);
    tooltipEl.style.display = 'block';
    tooltipEl.textContent = [tooltip.title, ...tooltip.lines].join('\n');
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
    const targets = hitTestHoverTargets(mapX, mapY);
    if (targets.length === 0) {
      hideTooltip();
      return;
    }
    showTooltip(targets, evt.clientX, evt.clientY);
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
      if (rafDragId !== null) {
        cancelAnimationFrame(rafDragId);
        rafDragId = null;
        render();
      }
    }
  }

  function onMouseDrag(evt: MouseEvent): void {
    if (isDragging) {
      panX = dragStartPanX + (evt.clientX - dragStartX);
      panY = dragStartPanY + (evt.clientY - dragStartY);
      if (rafDragId === null) {
        rafDragId = requestAnimationFrame(() => {
          rafDragId = null;
          render();
        });
      }
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
      updateControlVisibility();
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
      updateControlVisibility();
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
      updateControlVisibility();
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

  const roomFolder = gui.addFolder('Biome-specific Tweaks (Rooms)');
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
  displayFolder
    .add(settings, 'showReachability')
    .name('Show Reachability')
    .onChange(() => render());
  displayFolder
    .add(settings, 'showSetPiece')
    .name('Stamp Welcome Set Piece')
    .onChange(() => render());

  const caveBiomeFolder = gui.addFolder('Biome-specific Tweaks (Cave System)');
  const initialFillCtl = caveBiomeFolder
    .add(settings, 'caveInitialFill', 0.1, 0.9, 0.01)
    .name('Initial fill')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    initialFillCtl,
    'Initial random wall percentage before cave smoothing. Apply to rebuild map.',
  );
  const smoothingCtl = caveBiomeFolder
    .add(settings, 'caveSmoothingPasses', 1, 12, 1)
    .name('Smoothing passes')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    smoothingCtl,
    'Cellular automata smoothing iterations. Apply to rebuild map.',
  );
  const widenPassesCtl = caveBiomeFolder
    .add(settings, 'caveCavernWidenPasses', 0, 8, 1)
    .name('Cavern widen passes')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    widenPassesCtl,
    'Post-connect widening passes to make caverns more spacious. Apply to rebuild map.',
  );
  const hallwayRunCtl = caveBiomeFolder
    .add(settings, 'caveStraightHallwayMinRun', 0, 40, 1)
    .name('Straight hall min run')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    hallwayRunCtl,
    'Minimum straight hallway run before perturbation pass breaks long corridors. Apply to rebuild map.',
  );

  const floorTweaksFolder = gui.addFolder('Floor-specific Tweaks');
  const presentFamiliesCtl = floorTweaksFolder
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
  const bossDenCtl = floorTweaksFolder
    .add(settings, 'caveBossDenSize', 3, 13, 1)
    .name('Boss den size')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(bossDenCtl, 'Boss-den carved radius/diameter scalar. Apply to rebuild map.');
  const heartSizeCtl = floorTweaksFolder
    .add(settings, 'caveResourceHeartDiameterTiles', 10, 48, 1)
    .name('Resource room diameter')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    heartSizeCtl,
    'Center resource-room diameter in tiles. Apply to rebuild map.',
  );
  const territoryRadiusCtl = floorTweaksFolder
    .add(settings, 'caveTerritoryRadiusFraction', 0.1, 1.6, 0.01)
    .name('Territory radius %')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    territoryRadiusCtl,
    'Family territory-zone diameter as % of map min dimension (0.3 = 30%).',
  );
  const denBandMinCtl = floorTweaksFolder
    .add(settings, 'caveDenTargetRadiusMinFraction', 0.2, 0.95, 0.01)
    .name('Den radial min')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    denBandMinCtl,
    'Minimum den distance from center as fraction toward map edge (e.g., 0.6 = 60%).',
  );
  const denBandMaxCtl = floorTweaksFolder
    .add(settings, 'caveDenTargetRadiusMaxFraction', 0.2, 0.98, 0.01)
    .name('Den radial max')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    denBandMaxCtl,
    'Maximum den distance from center as fraction toward map edge (e.g., 0.8 = 80%).',
  );
  const denSepCtl = floorTweaksFolder
    .add(settings, 'caveDenTargetMinSeparationTiles', 6, 220, 1)
    .name('Den min separation')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(denSepCtl, 'Minimum Euclidean separation between den targets (tiles).');
  const denAngleJitterCtl = floorTweaksFolder
    .add(settings, 'caveDenStartAngleJitterFraction', 0, 1, 0.01)
    .name('Den angle randomness')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    denAngleJitterCtl,
    'Randomized first-den rotation around perimeter (0..1 of one den-step).',
  );
  const denDistanceJitterCtl = floorTweaksFolder
    .add(settings, 'caveDenDistanceJitterFraction', 0, 1, 0.01)
    .name('Den distance randomness')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    denDistanceJitterCtl,
    'Randomized per-den distance inside radial band (0 = fixed, 1 = full jitter).',
  );
  const spawnFromDenCtl = floorTweaksFolder
    .add(settings, 'caveSpawnMinDistanceFromDenTiles', 0, 260, 1)
    .name('Spawn min from dens')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(spawnFromDenCtl, 'Minimum spawn distance from den centers (tiles).');
  const spawnFromHeartCtl = floorTweaksFolder
    .add(settings, 'caveSpawnMinDistanceFromResourceHeartTiles', 0, 260, 1)
    .name('Spawn min from heart')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    spawnFromHeartCtl,
    'Minimum spawn distance from resource heart center (tiles).',
  );
  const spawnFromSettlementCtl = floorTweaksFolder
    .add(settings, 'caveSpawnMinDistanceFromSettlementTiles', 0, 260, 1)
    .name('Spawn min from settlement')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    spawnFromSettlementCtl,
    'Minimum spawn distance from settlement center (tiles).',
  );
  const settlementFromDenCtl = floorTweaksFolder
    .add(settings, 'caveSettlementMinDistanceFromDenTiles', 0, 260, 1)
    .name('Settlement min from dens')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    settlementFromDenCtl,
    'Minimum settlement distance from den centers (tiles).',
  );
  const settlementFromHeartCtl = floorTweaksFolder
    .add(settings, 'caveSettlementMinDistanceFromResourceHeartTiles', 0, 260, 1)
    .name('Settlement min from heart')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    settlementFromHeartCtl,
    'Minimum settlement distance from resource heart center (tiles).',
  );
  const separationCtl = floorTweaksFolder
    .add(settings, 'caveRegionSeparationTiles', 0, Math.floor(Math.hypot(400 - 1, 300 - 1)), 1)
    .name('Region separation')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(
    separationCtl,
    'Minimum tile separation between key regions. Apply to rebuild map.',
  );
  const retriesCtl = floorTweaksFolder
    .add(settings, 'caveMaxRetries', 1, 24, 1)
    .name('Max retries')
    .onChange(markMapSettingsDirty);
  setControllerTooltip(retriesCtl, 'Generation retry cap before giving up. Apply to rebuild map.');

  const overlayFolder = gui.addFolder('Overlays');
  overlayFolder.add(settings, 'showRooms').name('Room overlays').onChange(render);
  overlayFolder.add(settings, 'showDoors').name('Door markers').onChange(render);
  overlayFolder.add(settings, 'showSpawn').name('Spawn marker').onChange(render);
  overlayFolder.add(settings, 'showReachability').name('Reachability probe').onChange(render);
  const spawnZonesCtl = overlayFolder
    .add(settings, 'showSpawnZones')
    .name('Spawn Zones')
    .onChange(render);
  const familyTerritoriesCtl = overlayFolder
    .add(settings, 'showFamilyTerritories')
    .name('Territories + family names')
    .onChange(render);
  const npcPositionsCtl = overlayFolder
    .add(settings, 'showNpcPositions')
    .name('NPC positions')
    .onChange(render);
  const questItemsCtl = overlayFolder
    .add(settings, 'showQuestItems')
    .name('Quest items / objectives')
    .onChange(render);
  overlayFolder.add(settings, 'showSpecialMobs').name('Special mobs/spawners').onChange(render);
  overlayFolder.add(settings, 'showSpecialRooms').name('Special room labels').onChange(render);
  overlayFolder.add(settings, 'showLegend').name('Legend panel').onChange(updateLegend);
  overlayFolder
    .add(settings, 'showSpriteMode')
    .name('Sprite mode (Kenney)')
    .onChange(() => {
      cachedTerrainCanvas = null;
      updateLegend();
      render();
    });
  overlayFolder
    .add(settings, 'showCoverageOverlay')
    .name('Coverage overlay')
    .onChange(() => {
      cachedTerrainCanvas = null;
      updateLegend();
      render();
    });

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
    'Hover map markers for tooltips (areas, NPCs, special mobs/rooms, door criteria), inspect spawn regions below the map, and optionally stamp the welcome set piece overlay.';
  hint.style.marginTop = '16px';
  hint.style.color = '#c9d4ff';
  hint.style.lineHeight = '1.6';
  controls.appendChild(hint);

  function updateControlVisibility(): void {
    const isCaveBiome = settings.biome === BiomeType.CAVE_SYSTEM;
    const floorAttached = settings.applyFloorConstraints && settings.floorConstraint !== 'none';
    const isFloor1Attached = floorAttached && settings.floorConstraint === 'floor1';
    const isFloor2Attached = floorAttached && settings.floorConstraint === 'floor2';
    roomFolder.domElement.style.display = isCaveBiome ? 'none' : '';
    caveBiomeFolder.domElement.style.display = isCaveBiome ? '' : 'none';
    floorTweaksFolder.domElement.style.display =
      isCaveBiome && settings.floorConstraint === 'floor2' ? '' : 'none';
    spawnZonesCtl.domElement.style.display = floorAttached ? '' : 'none';
    familyTerritoriesCtl.domElement.style.display = isFloor2Attached ? '' : 'none';
    npcPositionsCtl.domElement.style.display = floorAttached ? '' : 'none';
    questItemsCtl.domElement.style.display = isFloor1Attached ? '' : 'none';
    spawnTableHost.style.display = floorAttached ? 'block' : 'none';
  }

  const ro = new ResizeObserver(() => {
    resizeCanvas();
    if (currentMap) render();
  });
  ro.observe(canvasHost);

  setRegenerationStatus('ready');
  applyFloorDefaultsIfEnabled();
  gui.controllersRecursive().forEach((controller) => controller.updateDisplay());
  updateControlVisibility();
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
    spawnTableHost.remove();
    errorEl.remove();
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
