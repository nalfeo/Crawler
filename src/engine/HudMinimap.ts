import Phaser from 'phaser';
import { query } from 'bitecs';
import { Enemy, Position } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { RoomRole, type RoomData, TerrainType } from '../shared/map-types.js';
import type { FloorMap } from '../core/map/FloorMap.js';
import {
  clampMinimapViewState,
  panMinimapByScreenDelta,
  zoomMinimapAtPoint,
  type MinimapViewState,
  type MinimapZoomLimits,
} from './minimap-view-state.js';

const HUD_DEPTH = 1000;
const MAP_PADDING = 16;
const MAP_BORDER = 2;
const HUD_MINIMAP_WIDTH = 180;
const HUD_MINIMAP_HEIGHT = 112;
const HUD_MINIMAP_TOP = 62;
/** Fixed zoom level for the HUD minimap widget — centered on the player. */
const HUD_MINIMAP_PLAYER_ZOOM = 3;
const ZOOM_STEP_IN = 1.15;
const ZOOM_STEP_OUT = 0.87;
const DOT_PLAYER = 0xffffff;
const DOT_ENEMY = 0xef4444;
const DOT_SAFE_ROOM = 0x2dd4bf;
const DOT_BOSS_ROOM = 0xf59e0b;
const DOT_SPAWN_ROOM = 0x60a5fa;
const DOT_STAIRS = 0xf8fafc;
const DOT_PLAYER_RADIUS = 0.8;
const DOT_ENEMY_RADIUS = 0.55;
const ROOM_MARKER_SIZE = 1.6;
const STAIRS_MARKER_SIZE = 1.1;

/** Terrain colour palette for minimap (same hues as main terrain, darker). */
const MINI_COLORS: Readonly<Record<number, number>> = {
  [TerrainType.VOID]: 0x05060f,
  [TerrainType.STONE_FLOOR]: 0x374151,
  [TerrainType.STONE_WALL]: 0x1f2937,
  [TerrainType.DOOR]: 0x8b5e34,
  [TerrainType.CORRIDOR]: 0x3d5068,
  [TerrainType.WATER]: 0x1e40af,
  [TerrainType.LAVA]: 0x991b1b,
  [TerrainType.GRASS]: 0x166534,
  [TerrainType.DIRT]: 0x6b3f24,
  [TerrainType.WOOD_FLOOR]: 0x5b4430,
  [TerrainType.WOOD_WALL]: 0x3a2d20,
  [TerrainType.CAVE_FLOOR]: 0x2a2a3d,
  [TerrainType.CAVE_WALL]: 0x1b1b29,
  [TerrainType.BOSS_STAIR_FLOOR]: 0x475569,
  [TerrainType.SAFE_ROOM_FLOOR]: 0x0f766e,
  [TerrainType.TREE]: 0x14532d,
  [TerrainType.RUBBLE]: 0x334155,
} as const;

function buildDefaultViewState(
  mapWidth: number,
  mapHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): { view: MinimapViewState; limits: MinimapZoomLimits } {
  const fitZoom = Math.max(0.1, Math.min(viewportWidth / mapWidth, viewportHeight / mapHeight));
  const limits: MinimapZoomLimits = {
    minZoom: Math.max(0.25, fitZoom * 0.5),
    maxZoom: Math.max(fitZoom * 14, 24),
  };
  const view: MinimapViewState = clampMinimapViewState({
    centerX: mapWidth / 2,
    centerY: mapHeight / 2,
    zoom: fitZoom,
    mapWidth,
    mapHeight,
    viewportWidth,
    viewportHeight,
  });
  return { view, limits };
}

function screenToViewport(
  x: number,
  y: number,
  viewport: Phaser.Geom.Rectangle,
): { x: number; y: number } {
  return {
    x: x - viewport.x,
    y: y - viewport.y,
  };
}

function isInsideViewport(x: number, y: number, viewport: Phaser.Geom.Rectangle): boolean {
  return x >= viewport.x && y >= viewport.y && x <= viewport.right && y <= viewport.bottom;
}

function roomHasDiscoveredTile(room: RoomData, floorMap: FloorMap, visited: Uint8Array): boolean {
  const minX = Math.max(0, room.bounds.x);
  const maxX = Math.min(floorMap.width - 1, room.bounds.x + room.bounds.width - 1);
  const minY = Math.max(0, room.bounds.y);
  const maxY = Math.min(floorMap.height - 1, room.bounds.y + room.bounds.height - 1);
  for (let ty = minY; ty <= maxY; ty += 1) {
    for (let tx = minX; tx <= maxX; tx += 1) {
      if (visited[ty * floorMap.width + tx]) {
        return true;
      }
    }
  }
  return false;
}

function drawSquareMarker(
  graphics: Phaser.GameObjects.Graphics,
  tileX: number,
  tileY: number,
  color: number,
  size: number,
): void {
  const half = size * 0.5;
  graphics.fillStyle(color, 1);
  graphics.fillRect(tileX + 0.5 - half, tileY + 0.5 - half, size, size);
}

export function createHudMinimap(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  toggle(): void;
  isOverlayOpen(): boolean;
  destroy(): void;
} {
  const hudMapBg = scene.add
    .rectangle(0, 0, HUD_MINIMAP_WIDTH, HUD_MINIMAP_HEIGHT, 0x0b1020, 0.95)
    .setStrokeStyle(1, 0x334155)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH)
    .setInteractive({ useHandCursor: true });

  const hudMapLabel = scene.add
    .text(0, 0, 'MAP (M)', {
      fontFamily: 'monospace',
      fontSize: '11px',
      color: '#e2e8f0',
    })
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2);

  const hudMapViewportFrame = scene.add
    .rectangle(0, 0, 0, 0, 0x0f172a, 1)
    .setStrokeStyle(1, 0x475569)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 1);

  const overlayDimmer = scene.add
    .rectangle(0, 0, 0, 0, 0x020617, 0.86)
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH)
    .setVisible(false);

  const panelBg = scene.add
    .rectangle(0, 0, 0, 0, 0x0b1020, 0.95)
    .setStrokeStyle(MAP_BORDER, 0x334155)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 1)
    .setVisible(false);

  const panelTitle = scene.add
    .text(0, 0, 'Dungeon Map', {
      fontFamily: 'monospace',
      fontSize: '16px',
      color: '#cbd5e1',
    })
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2)
    .setVisible(false);

  const panelHint = scene.add
    .text(0, 0, 'Drag/pinch: pan & zoom  ·  +/−: zoom  ·  M/tap ✕: close', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#94a3b8',
    })
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2)
    .setVisible(false);

  const viewportFrame = scene.add
    .rectangle(0, 0, 0, 0, 0x0f172a, 1)
    .setStrokeStyle(1, 0x475569)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2)
    .setVisible(false);

  const closeLabel = scene.add
    .text(0, 0, '✕', {
      fontFamily: 'monospace',
      fontSize: '18px',
      color: '#94a3b8',
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 3)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  const closeButtonBg = scene.add
    .rectangle(0, 0, 44, 44, 0x0f172a, 0.96)
    .setStrokeStyle(1, 0x475569)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  /** Tap-friendly zoom-in button shown in the fullscreen overlay. */
  const overlayZoomInBtn = scene.add
    .text(0, 0, '+', {
      fontFamily: 'monospace',
      fontSize: '22px',
      color: '#e2e8f0',
      backgroundColor: '#0f172acc',
      padding: { x: 14, y: 8 },
    })
    .setOrigin(1, 1)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 3)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  /** Tap-friendly zoom-out button shown in the fullscreen overlay. */
  const overlayZoomOutBtn = scene.add
    .text(0, 0, '−', {
      fontFamily: 'monospace',
      fontSize: '22px',
      color: '#e2e8f0',
      backgroundColor: '#0f172acc',
      padding: { x: 14, y: 8 },
    })
    .setOrigin(1, 1)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 3)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  const viewportHitArea = scene.add
    .zone(0, 0, 1, 1)
    .setOrigin(0, 0)
    .setDepth(HUD_DEPTH + 3)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  let terrainRt: Phaser.GameObjects.RenderTexture | undefined;
  const dotGraphics = scene.add
    .graphics()
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2)
    .setVisible(false);

  let overlayOpen = false;
  let lastFloorMap: FloorMap | null = null;
  let visitedTiles: Uint8Array | null = null;
  let viewState: MinimapViewState | null = null;
  let zoomLimits: MinimapZoomLimits = { minZoom: 0.5, maxZoom: 12 };
  let viewport = new Phaser.Geom.Rectangle(0, 0, 0, 0);
  let hudViewport = new Phaser.Geom.Rectangle(0, 0, 0, 0);
  let lastPointerX = 0;
  let lastPointerY = 0;
  let dragging = false;
  let lastPinchDist = 0;
  /** Last known player tile position for HUD widget centering. */
  let lastPlayerTileX: number | undefined;
  let lastPlayerTileY: number | undefined;

  function getGameSize(): { width: number; height: number } {
    return { width: scene.scale.gameSize.width, height: scene.scale.gameSize.height };
  }

  function updateLayout(): void {
    const { width, height } = getGameSize();
    const panelW = Math.floor(Math.min(1120, Math.max(640, width * 0.86)));
    const panelH = Math.floor(Math.min(720, Math.max(420, height * 0.84)));
    const panelX = Math.floor((width - panelW) / 2);
    const panelY = Math.floor((height - panelH) / 2);
    const viewportX = panelX + 16;
    const viewportY = panelY + 42;
    const viewportW = Math.max(120, panelW - 32);
    const viewportH = Math.max(80, panelH - 76);

    const hudMapX = width - MAP_PADDING - HUD_MINIMAP_WIDTH;
    const hudMapY = MAP_PADDING + HUD_MINIMAP_TOP;
    const hudMapInnerX = hudMapX + 6;
    const hudMapInnerY = hudMapY + 24;
    const hudMapInnerW = HUD_MINIMAP_WIDTH - 12;
    const hudMapInnerH = HUD_MINIMAP_HEIGHT - 30;

    hudMapBg
      .setPosition(hudMapX + HUD_MINIMAP_WIDTH / 2, hudMapY + HUD_MINIMAP_HEIGHT / 2)
      .setSize(HUD_MINIMAP_WIDTH, HUD_MINIMAP_HEIGHT);
    hudMapLabel.setPosition(hudMapX + 7, hudMapY + 6);
    hudViewport = new Phaser.Geom.Rectangle(hudMapInnerX, hudMapInnerY, hudMapInnerW, hudMapInnerH);
    hudMapViewportFrame
      .setPosition(hudViewport.centerX, hudViewport.centerY)
      .setSize(hudViewport.width, hudViewport.height);

    overlayDimmer.setSize(width, height);
    panelBg.setPosition(panelX + panelW / 2, panelY + panelH / 2).setSize(panelW, panelH);
    panelTitle.setPosition(panelX + 14, panelY + 10);
    panelHint.setPosition(panelX + 14, panelY + panelH - 26);
    closeButtonBg.setPosition(panelX + panelW - 14 - 22, panelY + 10 + 22);
    closeLabel.setPosition(panelX + panelW - 14 - 22, panelY + 10 + 22);
    // Overlay zoom buttons — bottom-right of panel, above the hint line
    overlayZoomInBtn.setPosition(panelX + panelW - 14, panelY + panelH - 36);
    overlayZoomOutBtn.setPosition(panelX + panelW - 14 - 52, panelY + panelH - 36);

    viewport = new Phaser.Geom.Rectangle(viewportX, viewportY, viewportW, viewportH);
    viewportFrame
      .setPosition(viewport.centerX, viewport.centerY)
      .setSize(viewport.width, viewport.height);
    viewportHitArea.setPosition(viewport.x, viewport.y);
    viewportHitArea.setSize(viewport.width, viewport.height);

    if (viewState) {
      viewState = clampMinimapViewState({
        ...viewState,
        viewportWidth: viewport.width,
        viewportHeight: viewport.height,
      });
      const fitZoom = Math.max(
        0.1,
        Math.min(viewport.width / viewState.mapWidth, viewport.height / viewState.mapHeight),
      );
      zoomLimits = {
        minZoom: Math.max(0.25, fitZoom * 0.5),
        maxZoom: Math.max(fitZoom * 14, 24),
      };
      viewState = zoomMinimapAtPoint(
        viewState,
        viewState.zoom,
        viewport.width * 0.5,
        viewport.height * 0.5,
        zoomLimits,
      );
      if (overlayOpen) {
        applyViewTransform();
      } else {
        applyHudTransform();
      }
    }
  }

  function setOverlayVisible(visible: boolean): void {
    overlayDimmer.setVisible(visible);
    panelBg.setVisible(visible);
    panelTitle.setVisible(visible);
    panelHint.setVisible(visible);
    viewportFrame.setVisible(visible);
    closeButtonBg.setVisible(visible);
    closeLabel.setVisible(visible);
    overlayZoomInBtn.setVisible(visible);
    overlayZoomOutBtn.setVisible(visible);
    viewportHitArea.setVisible(visible);
    terrainRt?.setVisible(Boolean(lastFloorMap));
    dotGraphics.setVisible(Boolean(lastFloorMap));

    hudMapBg.setVisible(!visible);
    hudMapLabel.setVisible(!visible);
    hudMapViewportFrame.setVisible(!visible);
    if (visible) {
      applyViewTransform();
    } else {
      applyHudTransform();
    }
  }

  function applyViewTransform(): void {
    if (!terrainRt || !viewState) {
      return;
    }
    const snappedZoom = Math.max(0.25, Math.round(viewState.zoom * 2) / 2);
    const originX = viewport.centerX - viewState.centerX * snappedZoom;
    const originY = viewport.centerY - viewState.centerY * snappedZoom;
    terrainRt.setPosition(Math.round(originX), Math.round(originY)).setScale(snappedZoom);
    dotGraphics.setPosition(Math.round(originX), Math.round(originY)).setScale(snappedZoom);
  }

  /**
   * Position the terrain texture and dot layer inside the HUD widget.
   * When a player tile position is supplied the map is zoomed in at
   * HUD_MINIMAP_PLAYER_ZOOM and centered on the player so the local area
   * is clearly visible and scrolls with movement.  Falls back to a
   * fit-to-view layout (whole map visible) when no position is known yet.
   */
  function applyHudTransform(): void {
    if (!terrainRt) {
      return;
    }
    const mapWidth = lastFloorMap?.width ?? viewState?.mapWidth ?? 0;
    const mapHeight = lastFloorMap?.height ?? viewState?.mapHeight ?? 0;
    if (mapWidth <= 0 || mapHeight <= 0) {
      return;
    }

    if (lastPlayerTileX !== undefined && lastPlayerTileY !== undefined) {
      // Fixed 3× zoom centered on the player tile.
      const scale = HUD_MINIMAP_PLAYER_ZOOM;
      const halfW = hudViewport.width / (2 * scale);
      const halfH = hudViewport.height / (2 * scale);
      const clampedX = Math.max(halfW, Math.min(mapWidth - halfW, lastPlayerTileX));
      const clampedY = Math.max(halfH, Math.min(mapHeight - halfH, lastPlayerTileY));
      const originX = hudViewport.centerX - clampedX * scale;
      const originY = hudViewport.centerY - clampedY * scale;
      terrainRt.setPosition(Math.round(originX), Math.round(originY)).setScale(scale);
      dotGraphics.setPosition(Math.round(originX), Math.round(originY)).setScale(scale);
    } else {
      // Fallback: fit the entire map inside the HUD widget.
      const scale = Math.min(hudViewport.width / mapWidth, hudViewport.height / mapHeight);
      const originX = hudViewport.centerX - mapWidth * scale * 0.5;
      const originY = hudViewport.centerY - mapHeight * scale * 0.5;
      terrainRt.setPosition(Math.round(originX), Math.round(originY)).setScale(scale);
      dotGraphics.setPosition(Math.round(originX), Math.round(originY)).setScale(scale);
    }
  }

  function drawDots(
    world: GameWorld,
    playerEid: number,
    floorMap: FloorMap,
    visited: Uint8Array,
  ): void {
    dotGraphics.clear();
    for (const room of floorMap.rooms) {
      const color =
        room.role === RoomRole.SAFE
          ? DOT_SAFE_ROOM
          : room.role === RoomRole.BOSS_STAIR
            ? DOT_BOSS_ROOM
            : room.role === RoomRole.SPAWN
              ? DOT_SPAWN_ROOM
              : null;
      if (color === null) {
        continue;
      }
      if (!roomHasDiscoveredTile(room, floorMap, visited)) {
        continue;
      }
      const centerX = room.bounds.x + Math.floor(room.bounds.width / 2);
      const centerY = room.bounds.y + Math.floor(room.bounds.height / 2);
      drawSquareMarker(dotGraphics, centerX, centerY, color, ROOM_MARKER_SIZE);
    }

    const objective = world.floor1?.objective;
    if (objective?.staircaseSpawned && objective.staircaseDiscovered) {
      const stairTile = floorMap.pixelToTile(objective.staircasePos.x, objective.staircasePos.y);
      if (
        stairTile.x >= 0 &&
        stairTile.y >= 0 &&
        stairTile.x < floorMap.width &&
        stairTile.y < floorMap.height &&
        visited[stairTile.y * floorMap.width + stairTile.x]
      ) {
        drawSquareMarker(dotGraphics, stairTile.x, stairTile.y, DOT_STAIRS, STAIRS_MARKER_SIZE);
      }
    }

    const tilePx = floorMap.config.tileSizePx;
    const enemies = query(world.ecs, [Enemy, Position]);
    dotGraphics.fillStyle(DOT_ENEMY, 1);
    for (const eid of enemies) {
      const wx = world.stores.position.x[eid] ?? 0;
      const wy = world.stores.position.y[eid] ?? 0;
      const tx = Math.floor(wx / tilePx);
      const ty = Math.floor(wy / tilePx);
      if (tx < 0 || ty < 0 || tx >= floorMap.width || ty >= floorMap.height) continue;
      const idx = ty * floorMap.width + tx;
      if (!visited[idx]) continue;
      dotGraphics.fillCircle(tx + 0.5, ty + 0.5, DOT_ENEMY_RADIUS);
    }

    if (playerEid >= 0) {
      const px = world.stores.position.x[playerEid] ?? 0;
      const py = world.stores.position.y[playerEid] ?? 0;
      dotGraphics.fillStyle(DOT_PLAYER, 1);
      dotGraphics.fillCircle(px / tilePx, py / tilePx, DOT_PLAYER_RADIUS);
    }
  }

  function ensureTerrainTexture(floorMap: FloorMap): void {
    if (terrainRt) {
      return;
    }
    terrainRt = scene.add
      .renderTexture(viewport.x, viewport.y, floorMap.width, floorMap.height)
      .setOrigin(0, 0)
      .setDepth(HUD_DEPTH + 2)
      .setScrollFactor(0);
    terrainRt.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
    terrainRt.setVisible(false);

    const built = buildDefaultViewState(
      floorMap.width,
      floorMap.height,
      viewport.width,
      viewport.height,
    );
    viewState = built.view;
    zoomLimits = built.limits;
    applyViewTransform();
  }

  function bakeNewTiles(floorMap: FloorMap, newIndices: number[]): void {
    ensureTerrainTexture(floorMap);
    if (!terrainRt || newIndices.length === 0) {
      return;
    }
    for (const idx of newIndices) {
      const tx = idx % floorMap.width;
      const ty = Math.floor(idx / floorMap.width);
      const terrain = floorMap.terrain[idx] ?? TerrainType.VOID;
      const color = MINI_COLORS[terrain] ?? 0x05060f;
      terrainRt.fill(color, 1, tx, ty, 1, 1);
    }
    terrainRt.render();
  }

  function openOverlay(): void {
    overlayOpen = true;
    setOverlayVisible(true);
  }

  function closeOverlay(): void {
    overlayOpen = false;
    dragging = false;
    setOverlayVisible(false);
  }

  function toggle(): void {
    if (overlayOpen) {
      closeOverlay();
    } else {
      openOverlay();
    }
  }

  function handleKeyDown(event: KeyboardEvent): void {
    if (event.key === 'm' || event.key === 'M') {
      if (event.repeat) {
        return;
      }
      toggle();
      return;
    }

    if (!overlayOpen || !viewState) {
      return;
    }

    if (event.key === '+' || event.key === '=' || event.key === 'NumpadAdd') {
      viewState = zoomMinimapAtPoint(
        viewState,
        viewState.zoom * ZOOM_STEP_IN,
        viewState.viewportWidth * 0.5,
        viewState.viewportHeight * 0.5,
        zoomLimits,
      );
      applyViewTransform();
    } else if (event.key === '-' || event.key === '_' || event.key === 'NumpadSubtract') {
      viewState = zoomMinimapAtPoint(
        viewState,
        viewState.zoom * ZOOM_STEP_OUT,
        viewState.viewportWidth * 0.5,
        viewState.viewportHeight * 0.5,
        zoomLimits,
      );
      applyViewTransform();
    } else if (event.key === 'Escape') {
      closeOverlay();
    }
  }

  function handleWheel(
    pointer: Phaser.Input.Pointer,
    _targets: Phaser.GameObjects.GameObject[],
    _deltaX: number,
    deltaY: number,
  ): void {
    if (!overlayOpen || !viewState) {
      return;
    }
    if (!isInsideViewport(pointer.x, pointer.y, viewport)) {
      return;
    }
    const local = screenToViewport(pointer.x, pointer.y, viewport);
    const nextZoom = deltaY > 0 ? viewState.zoom * ZOOM_STEP_OUT : viewState.zoom * ZOOM_STEP_IN;
    viewState = zoomMinimapAtPoint(viewState, nextZoom, local.x, local.y, zoomLimits);
    applyViewTransform();
  }

  function handlePointerMove(pointer: Phaser.Input.Pointer): void {
    if (!overlayOpen || !viewState) {
      return;
    }

    // Pinch-to-zoom: two simultaneous touch pointers
    const p2 = scene.input.pointer2;
    if (p2?.isDown) {
      const p1 = scene.input.pointer1;
      const dist = Math.hypot(p1.x - p2.x, p1.y - p2.y);
      if (lastPinchDist > 0 && dist > 0) {
        const scaleFactor = dist / lastPinchDist;
        const midX = (p1.x + p2.x) / 2;
        const midY = (p1.y + p2.y) / 2;
        const local = screenToViewport(midX, midY, viewport);
        viewState = zoomMinimapAtPoint(
          viewState,
          viewState.zoom * scaleFactor,
          local.x,
          local.y,
          zoomLimits,
        );
        applyViewTransform();
      }
      lastPinchDist = dist;
      dragging = false;
      return;
    }

    lastPinchDist = 0;

    if (!dragging) {
      return;
    }
    const dx = pointer.x - lastPointerX;
    const dy = pointer.y - lastPointerY;
    lastPointerX = pointer.x;
    lastPointerY = pointer.y;
    viewState = panMinimapByScreenDelta(viewState, dx, dy);
    applyViewTransform();
  }

  function sync(world: GameWorld, playerEid: number): void {
    const floorMap = world.floorMap;
    if (!floorMap) {
      return;
    }

    if (floorMap !== lastFloorMap) {
      lastFloorMap = floorMap;
      visitedTiles = new Uint8Array(floorMap.width * floorMap.height);
      terrainRt?.destroy();
      terrainRt = undefined;
      viewState = null;
    }

    // Track player tile position so the HUD widget can follow the player.
    if (playerEid >= 0) {
      const tilePx = floorMap.config.tileSizePx;
      lastPlayerTileX = (world.stores.position.x[playerEid] ?? 0) / tilePx;
      lastPlayerTileY = (world.stores.position.y[playerEid] ?? 0) / tilePx;
    }

    const visited = visitedTiles!;
    const newIndices: number[] = [];
    for (let i = 0; i < visited.length; i += 1) {
      if (!visited[i] && floorMap.visible[i]) {
        visited[i] = 1;
        newIndices.push(i);
      }
    }
    if (newIndices.length > 0 || !terrainRt) {
      bakeNewTiles(floorMap, newIndices);
      if (overlayOpen) {
        applyViewTransform();
      } else {
        applyHudTransform();
      }
    }

    if (terrainRt) {
      drawDots(world, playerEid, floorMap, visited);
      if (overlayOpen) {
        applyViewTransform();
      } else {
        applyHudTransform();
      }
      terrainRt.setVisible(true);
      dotGraphics.setVisible(true);
    }
  }

  function destroy(): void {
    window.removeEventListener('keydown', handleKeyDown);
    scene.scale.off('resize', updateLayout);
    scene.input.off('wheel', handleWheel);
    scene.input.off('pointermove', handlePointerMove);
    scene.input.off('pointerup', handlePointerUp);
    scene.input.off('pointerupoutside', handlePointerUp);

    terrainRt?.destroy();
    dotGraphics.destroy();
    hudMapBg.destroy();
    hudMapLabel.destroy();
    hudMapViewportFrame.destroy();
    overlayDimmer.destroy();
    panelBg.destroy();
    panelTitle.destroy();
    panelHint.destroy();
    viewportFrame.destroy();
    viewportHitArea.destroy();
    closeButtonBg.destroy();
    closeLabel.destroy();
    overlayZoomInBtn.destroy();
    overlayZoomOutBtn.destroy();
  }

  function handlePointerUp(): void {
    dragging = false;
    lastPinchDist = 0;
  }

  hudMapBg.on('pointerdown', toggle);
  closeButtonBg.on('pointerdown', closeOverlay);
  closeLabel.on('pointerdown', closeOverlay);
  overlayZoomInBtn.on('pointerdown', () => {
    if (!overlayOpen || !viewState) {
      return;
    }
    viewState = zoomMinimapAtPoint(
      viewState,
      viewState.zoom * ZOOM_STEP_IN,
      viewState.viewportWidth * 0.5,
      viewState.viewportHeight * 0.5,
      zoomLimits,
    );
    applyViewTransform();
  });
  overlayZoomOutBtn.on('pointerdown', () => {
    if (!overlayOpen || !viewState) {
      return;
    }
    viewState = zoomMinimapAtPoint(
      viewState,
      viewState.zoom * ZOOM_STEP_OUT,
      viewState.viewportWidth * 0.5,
      viewState.viewportHeight * 0.5,
      zoomLimits,
    );
    applyViewTransform();
  });
  viewportHitArea.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
    if (!overlayOpen) {
      return;
    }
    dragging = true;
    lastPointerX = pointer.x;
    lastPointerY = pointer.y;
  });

  window.addEventListener('keydown', handleKeyDown);
  scene.scale.on('resize', updateLayout);
  scene.input.on('wheel', handleWheel);
  scene.input.on('pointermove', handlePointerMove);
  scene.input.on('pointerup', handlePointerUp);
  scene.input.on('pointerupoutside', handlePointerUp);

  updateLayout();
  closeOverlay();

  return {
    sync,
    toggle,
    isOverlayOpen: () => overlayOpen,
    destroy,
  };
}
