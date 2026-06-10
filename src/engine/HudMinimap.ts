import Phaser from 'phaser';
import { query } from 'bitecs';
import { Enemy, Position } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { TerrainType } from '../shared/map-types.js';
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
const ICON_SIZE = 40;
const ZOOM_STEP_IN = 1.15;
const ZOOM_STEP_OUT = 0.87;
const DOT_PLAYER = 0xffffff;
const DOT_ENEMY = 0xef4444;
const DOT_PLAYER_RADIUS = 0.8;
const DOT_ENEMY_RADIUS = 0.55;

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

export function createHudMinimap(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  toggle(): void;
  isOverlayOpen(): boolean;
  destroy(): void;
} {
  const iconBg = scene.add
    .rectangle(0, 0, ICON_SIZE, ICON_SIZE, 0x111827, 0.9)
    .setStrokeStyle(1, 0x334155)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH)
    .setInteractive({ useHandCursor: true });

  const iconLabel = scene.add
    .text(0, 0, 'MAP', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#e2e8f0',
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 1);

  const iconHint = scene.add
    .text(0, 0, 'M', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#64748b',
    })
    .setOrigin(0.5, 0)
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
    .text(0, 0, 'Wheel: zoom  Drag: pan  +/-: zoom  M: close', {
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
      fontSize: '14px',
      color: '#94a3b8',
    })
    .setOrigin(1, 0)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 3)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  const viewportHitArea = scene.add
    .zone(0, 0, 0, 0)
    .setOrigin(0, 0)
    .setDepth(HUD_DEPTH + 3)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  const maskGraphics = scene.add
    .graphics()
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 3)
    .setVisible(false);
  const viewportMask = maskGraphics.createGeometryMask();

  let terrainRt: Phaser.GameObjects.RenderTexture | undefined;
  const dotGraphics = scene.add
    .graphics()
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2)
    .setVisible(false)
    .setMask(viewportMask);

  let overlayOpen = false;
  let lastFloorMap: FloorMap | null = null;
  let visitedTiles: Uint8Array | null = null;
  let viewState: MinimapViewState | null = null;
  let zoomLimits: MinimapZoomLimits = { minZoom: 0.5, maxZoom: 12 };
  let viewport = new Phaser.Geom.Rectangle(0, 0, 0, 0);
  let lastPointerX = 0;
  let lastPointerY = 0;
  let dragging = false;

  function getGameSize(): { width: number; height: number } {
    return { width: scene.scale.gameSize.width, height: scene.scale.gameSize.height };
  }

  function updateLayout(): void {
    const { width, height } = getGameSize();
    const panelW = Math.floor(Math.max(160, width - MAP_PADDING * 2));
    const panelH = Math.floor(Math.max(140, height - MAP_PADDING * 2));
    const panelX = Math.floor((width - panelW) / 2);
    const panelY = Math.floor((height - panelH) / 2);
    const viewportX = panelX + 16;
    const viewportY = panelY + 42;
    const viewportW = Math.max(120, panelW - 32);
    const viewportH = Math.max(80, panelH - 76);

    iconBg.setPosition(width - ICON_SIZE / 2 - 12, ICON_SIZE / 2 + 12);
    iconLabel.setPosition(iconBg.x, iconBg.y);
    iconHint.setPosition(iconBg.x, iconBg.y + ICON_SIZE / 2 + 4);

    overlayDimmer.setSize(width, height);
    panelBg.setPosition(panelX + panelW / 2, panelY + panelH / 2).setSize(panelW, panelH);
    panelTitle.setPosition(panelX + 14, panelY + 10);
    panelHint.setPosition(panelX + 14, panelY + panelH - 26);
    closeLabel.setPosition(panelX + panelW - 10, panelY + 8);

    viewport = new Phaser.Geom.Rectangle(viewportX, viewportY, viewportW, viewportH);
    viewportFrame
      .setPosition(viewport.centerX, viewport.centerY)
      .setSize(viewport.width, viewport.height);
    viewportHitArea.setPosition(viewport.x, viewport.y);
    viewportHitArea.setSize(viewport.width, viewport.height);

    maskGraphics.clear();
    maskGraphics.fillStyle(0xffffff, 1);
    maskGraphics.fillRect(viewport.x, viewport.y, viewport.width, viewport.height);

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
      applyViewTransform();
    }
  }

  function setOverlayVisible(visible: boolean): void {
    overlayDimmer.setVisible(visible);
    panelBg.setVisible(visible);
    panelTitle.setVisible(visible);
    panelHint.setVisible(visible);
    viewportFrame.setVisible(visible);
    closeLabel.setVisible(visible);
    viewportHitArea.setVisible(visible);
    terrainRt?.setVisible(visible);
    dotGraphics.setVisible(visible);

    iconBg.setVisible(!visible);
    iconLabel.setVisible(!visible);
    iconHint.setVisible(!visible);
  }

  function applyViewTransform(): void {
    if (!terrainRt || !viewState) {
      return;
    }
    const originX = viewport.centerX - viewState.centerX * viewState.zoom;
    const originY = viewport.centerY - viewState.centerY * viewState.zoom;
    terrainRt.setPosition(originX, originY).setScale(viewState.zoom);
    dotGraphics.setPosition(originX, originY).setScale(viewState.zoom);
  }

  function drawDots(world: GameWorld, playerEid: number, floorMap: FloorMap): void {
    dotGraphics.clear();
    dotGraphics.fillStyle(DOT_ENEMY, 1);

    const tilePx = floorMap.config.tileSizePx;
    const enemies = query(world.ecs, [Enemy, Position]);
    for (const eid of enemies) {
      const wx = world.stores.position.x[eid] ?? 0;
      const wy = world.stores.position.y[eid] ?? 0;
      const tx = Math.floor(wx / tilePx);
      const ty = Math.floor(wy / tilePx);
      if (tx < 0 || ty < 0 || tx >= floorMap.width || ty >= floorMap.height) continue;
      const idx = ty * floorMap.width + tx;
      if (!floorMap.visible[idx]) continue;
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
      .setScrollFactor(0)
      .setVisible(false)
      .setMask(viewportMask);

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
    if (!overlayOpen || !dragging || !viewState) {
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
      applyViewTransform();
      if (overlayOpen) {
        terrainRt?.setVisible(true);
      }
    }

    if (overlayOpen && terrainRt) {
      drawDots(world, playerEid, floorMap);
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
    iconBg.destroy();
    iconLabel.destroy();
    iconHint.destroy();
    overlayDimmer.destroy();
    panelBg.destroy();
    panelTitle.destroy();
    panelHint.destroy();
    viewportFrame.destroy();
    viewportHitArea.destroy();
    closeLabel.destroy();
    maskGraphics.destroy();
  }

  function handlePointerUp(): void {
    dragging = false;
  }

  iconBg.on('pointerdown', toggle);
  closeLabel.on('pointerdown', closeOverlay);
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
