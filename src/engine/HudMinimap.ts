import Phaser from 'phaser';
import { query } from 'bitecs';
import { Enemy, Npc, Position } from '../core/components.js';
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
import { PIXEL_UI } from './pixel-ui.js';
import { getUiScale, type ScreenBounds } from './ui-scale.js';

const HUD_DEPTH = 1000;
const MAP_BORDER = 2;
// Round radar minimap pinned to the very top-right corner.
const HUD_RADAR_DIAMETER = 152;
const HUD_RADAR_MARGIN = 12;
/**
 * Upper bound on docked-radar magnification on small screens. The dial is a
 * spatial widget anchored to the top-right corner; capping the scale keeps it
 * legible/tappable on mobile while leaving room for the quest tracker that
 * stacks beneath it. At scale 1 (desktop) the dial is pixel-identical.
 */
const HUD_RADAR_MAX_SCALE = 1.4;
const HUD_RADAR_RADIUS = HUD_RADAR_DIAMETER / 2;
// Inner radius the radar content is clipped to (leaves a thin rim for the rings).
const RADAR_CLIP_RADIUS = HUD_RADAR_RADIUS - 4;
// Player-centred radar zoom: pixels rendered per dungeon tile.
const RADAR_PX_PER_TILE = 6;
const ZOOM_STEP_IN = 1.15;
const ZOOM_STEP_OUT = 0.87;
const OVERLAY_CLOSE_BUTTON_SIZE = 52;
const OVERLAY_CLOSE_BUTTON_MAX_SIZE = 72;
const OVERLAY_CLOSE_BUTTON_MARGIN = 14;
const DOT_PLAYER = 0xffffff;
const DOT_PLAYER_RING = 0xffd23f;
const DOT_OUTLINE = 0x0b0b14;
const DOT_OUTLINE_WIDTH = 0.32;
const DOT_ENEMY = 0xef4444;
const DOT_NPC = 0x4ade80;
const DOT_SAFE_ROOM = 0x2dd4bf;
const DOT_BOSS_ROOM = 0xf59e0b;
const DOT_SPAWN_ROOM = 0x60a5fa;
const DOT_STAIRS = 0xf8fafc;
const DOT_PLAYER_RADIUS = 0.8;
const DOT_ENEMY_RADIUS = 0.55;
const DOT_NPC_RADIUS = 0.62;
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
  /**
   * Test/automation affordance: world-space bounds of the fullscreen-overlay
   * close button while the overlay is open, or null when it is closed. Lets e2e
   * harnesses tap the close button at its real (responsive) position.
   */
  getOverlayCloseBounds(): ScreenBounds | null;
  destroy(): void;
} {
  // --- Round radar minimap chrome (top-right corner) ------------------------
  // Filled disc background (also the click target that toggles the overlay).
  const hudMapBg = scene.add
    .circle(0, 0, HUD_RADAR_RADIUS, PIXEL_UI.panelFill, 0.96)
    .setStrokeStyle(8, PIXEL_UI.border)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH)
    .setInteractive({
      hitArea: new Phaser.Geom.Circle(HUD_RADAR_RADIUS, HUD_RADAR_RADIUS, HUD_RADAR_RADIUS),
      hitAreaCallback: Phaser.Geom.Circle.Contains,
      useHandCursor: true,
    });

  // Substantial beveled frame: dark outer rim → thick gold band → light inner bevel.
  // The gold band also masks the jagged square-pixel edge of the clipped radar.
  const hudRingOuter = scene.add
    .circle(0, 0, HUD_RADAR_RADIUS + 3, 0x000000, 0)
    .setStrokeStyle(4, PIXEL_UI.border, 0.95)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 5);
  const hudRingGold = scene.add
    .circle(0, 0, HUD_RADAR_RADIUS - 2, 0x000000, 0)
    .setStrokeStyle(6, PIXEL_UI.gold, 0.95)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 5);
  const hudRingInner = scene.add
    .circle(0, 0, HUD_RADAR_RADIUS - 6, 0x000000, 0)
    .setStrokeStyle(2, PIXEL_UI.bevelLight, 0.5)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 5);

  // Compass "N" marker at the top of the dial for orientation.
  const hudCompass = scene.add
    .text(0, 0, 'N', {
      fontFamily: 'monospace',
      fontSize: '10px',
      fontStyle: 'bold',
      color: '#fcd34d',
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 6);

  // Small "MAP (M)" hint tab beneath the dial.
  const hudMapLabel = scene.add
    .text(0, 0, 'MAP (M)', {
      fontFamily: 'monospace',
      fontSize: '11px',
      fontStyle: 'bold',
      color: '#fcd34d',
    })
    .setOrigin(0.5, 0)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 6);

  // Phaser 4 dropped WebGL support for setMask() / geometry + bitmap masks
  // ("This method is not supported in WebGL. Create a Mask filter instead.").
  // The docked radar composites its terrain + blips into a fixed-size
  // RenderTexture; the circular clip is applied analytically per-tile in
  // drawRadar (erase(canvasTexture) proved unreliable under WebGL — it left
  // wedge artifacts and edge bleed).

  const overlayDimmer = scene.add
    .rectangle(0, 0, 0, 0, 0x020617, 0.86)
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH)
    .setVisible(false);

  const panelBg = scene.add
    .rectangle(0, 0, 0, 0, PIXEL_UI.panelFill, 0.97)
    .setStrokeStyle(MAP_BORDER, PIXEL_UI.border)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 1)
    .setVisible(false);

  const panelTitle = scene.add
    .text(0, 0, 'Dungeon Map', {
      fontFamily: 'monospace',
      fontSize: '16px',
      fontStyle: 'bold',
      color: '#fcd34d',
    })
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2)
    .setVisible(false);

  const panelHint = scene.add
    .text(0, 0, 'Drag/pinch: pan & zoom  ·  Wheel/+/-: zoom  ·  M: close', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#94a3b8',
    })
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2)
    .setVisible(false);

  const viewportFrame = scene.add
    .rectangle(0, 0, 0, 0, PIXEL_UI.trackFill, 1)
    .setStrokeStyle(1, PIXEL_UI.border)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 2)
    .setVisible(false);

  const closeLabel = scene.add
    .text(0, 0, '✕', {
      fontFamily: 'monospace',
      fontSize: '26px',
      color: '#fcd34d',
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    // Above viewportHitArea (+3) and dotGraphics (+4): on small screens uiScale
    // enlarges the close button so its centre dips into the pan/drag zone. With
    // Phaser's default topOnly input that zone would otherwise swallow the tap,
    // so the overlay could not be closed by tapping the button (mobile bug).
    .setDepth(HUD_DEPTH + 8)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  const closeButtonBg = scene.add
    .rectangle(0, 0, OVERLAY_CLOSE_BUTTON_SIZE, OVERLAY_CLOSE_BUTTON_SIZE, PIXEL_UI.panelFill, 0.97)
    .setStrokeStyle(1, PIXEL_UI.border)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 7)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  const viewportHitArea = scene.add
    .zone(0, 0, 1, 1)
    .setOrigin(0, 0)
    .setDepth(HUD_DEPTH + 3)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  let terrainRt: Phaser.GameObjects.RenderTexture | undefined;
  // dotGraphics must sit above terrainRt (HUD_DEPTH+4 > HUD_DEPTH+3) so blips
  // render on top of the baked terrain tiles.
  const dotGraphics = scene.add
    .graphics()
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 4)
    .setVisible(false);

  // Fixed screen-space content for the docked radar dial. Terrain + blips are
  // composited here every frame and clipped with the annulus cutout (erase).
  const radarRt = scene.add
    .renderTexture(0, 0, HUD_RADAR_DIAMETER, HUD_RADAR_DIAMETER)
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(HUD_DEPTH + 1)
    .setVisible(false);
  radarRt.texture.setFilter(Phaser.Textures.FilterMode.NEAREST);
  // Scratch surface for drawing the radar blips before compositing into radarRt.
  const radarScratch = scene.add.graphics().setScrollFactor(0).setVisible(false);

  let overlayOpen = false;
  let lastFloorMap: FloorMap | null = null;
  let visitedTiles: Uint8Array | null = null;
  let viewState: MinimapViewState | null = null;
  let zoomLimits: MinimapZoomLimits = { minZoom: 0.5, maxZoom: 12 };
  let viewport = new Phaser.Geom.Rectangle(0, 0, 0, 0);
  let hudRadarCenterX = 0;
  let hudRadarCenterY = 0;
  let lastPlayerWorldX = 0;
  let lastPlayerWorldY = 0;
  let lastPointerX = 0;
  let lastPointerY = 0;
  let dragging = false;
  let lastPinchDist = 0;

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

    // Enlarge the docked dial on small screens (mirrors the responsive HUD).
    // The radar content composites into a fixed-size, dial-local RenderTexture,
    // so scaling the chrome + radarRt display uniformly grows the whole widget
    // without touching the per-tile clip math in drawRadar.
    const radarScale = Math.min(getUiScale(scene), HUD_RADAR_MAX_SCALE);
    const scaledRadius = HUD_RADAR_RADIUS * radarScale;
    const scaledCx = width - HUD_RADAR_MARGIN - scaledRadius;
    const scaledCy = HUD_RADAR_MARGIN + scaledRadius;
    hudRadarCenterX = scaledCx;
    hudRadarCenterY = scaledCy;

    hudMapBg.setPosition(scaledCx, scaledCy).setScale(radarScale);
    hudRingOuter.setPosition(scaledCx, scaledCy).setScale(radarScale);
    hudRingGold.setPosition(scaledCx, scaledCy).setScale(radarScale);
    hudRingInner.setPosition(scaledCx, scaledCy).setScale(radarScale);
    hudCompass.setPosition(scaledCx, scaledCy - scaledRadius + 9 * radarScale).setScale(radarScale);
    hudMapLabel
      .setPosition(scaledCx, scaledCy + scaledRadius + 4 * radarScale)
      .setScale(radarScale);

    // Pin the docked radar content to the dial's bounding box (top-left origin).
    radarRt.setPosition(scaledCx - scaledRadius, scaledCy - scaledRadius).setScale(radarScale);

    overlayDimmer.setSize(width, height);
    panelBg.setPosition(panelX + panelW / 2, panelY + panelH / 2).setSize(panelW, panelH);
    panelTitle.setPosition(panelX + 14, panelY + 10);
    panelHint.setPosition(panelX + 14, panelY + panelH - 26);
    const closeButtonSize = Math.min(
      OVERLAY_CLOSE_BUTTON_MAX_SIZE,
      Math.round(OVERLAY_CLOSE_BUTTON_SIZE * getUiScale(scene)),
    );
    const closeButtonCenterX = panelX + panelW - OVERLAY_CLOSE_BUTTON_MARGIN - closeButtonSize / 2;
    const closeButtonCenterY = panelY + OVERLAY_CLOSE_BUTTON_MARGIN + closeButtonSize / 2;
    closeButtonBg.setPosition(closeButtonCenterX, closeButtonCenterY);
    closeButtonBg.setSize(closeButtonSize, closeButtonSize);
    closeLabel.setPosition(closeButtonCenterX, closeButtonCenterY);
    closeLabel.setFontSize(`${Math.round(closeButtonSize * 0.5)}px`);

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
    viewportHitArea.setVisible(visible);

    hudMapBg.setVisible(!visible);
    hudRingOuter.setVisible(!visible);
    hudRingGold.setVisible(!visible);
    hudRingInner.setVisible(!visible);
    hudCompass.setVisible(!visible);
    hudMapLabel.setVisible(!visible);
    if (visible) {
      // Full-screen overlay: show the whole map via the large terrain texture.
      radarRt.setVisible(false);
      terrainRt?.setVisible(Boolean(lastFloorMap));
      dotGraphics.setVisible(Boolean(lastFloorMap));
      applyViewTransform();
    } else {
      // Docked radar: the clipped radarRt is the only visible content.
      terrainRt?.setVisible(false);
      dotGraphics.setVisible(false);
      radarRt.setVisible(Boolean(lastFloorMap));
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

  function applyHudTransform(): void {
    if (!terrainRt || !lastFloorMap) {
      return;
    }
    const tileFt = lastFloorMap.config.tileSizeFt;
    const playerTileX = lastPlayerWorldX / tileFt;
    const playerTileY = lastPlayerWorldY / tileFt;
    // Centre the player in the dial; terrain + dots scroll underneath the mask.
    const originX = hudRadarCenterX - playerTileX * RADAR_PX_PER_TILE;
    const originY = hudRadarCenterY - playerTileY * RADAR_PX_PER_TILE;
    terrainRt.setPosition(Math.round(originX), Math.round(originY)).setScale(RADAR_PX_PER_TILE);
    dotGraphics.setPosition(Math.round(originX), Math.round(originY)).setScale(RADAR_PX_PER_TILE);
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
      const stairTile = floorMap.worldToTile(objective.staircasePos.x, objective.staircasePos.y);
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

    const tileFt = floorMap.config.tileSizeFt;
    const enemies = query(world.ecs, [Enemy, Position]);
    for (const eid of enemies) {
      const wx = world.stores.position.x[eid] ?? 0;
      const wy = world.stores.position.y[eid] ?? 0;
      const tx = Math.floor(wx / tileFt);
      const ty = Math.floor(wy / tileFt);
      if (tx < 0 || ty < 0 || tx >= floorMap.width || ty >= floorMap.height) continue;
      const idx = ty * floorMap.width + tx;
      if (!visited[idx]) continue;
      dotGraphics.fillStyle(DOT_OUTLINE, 1);
      dotGraphics.fillCircle(tx + 0.5, ty + 0.5, DOT_ENEMY_RADIUS + DOT_OUTLINE_WIDTH);
      dotGraphics.fillStyle(DOT_ENEMY, 1);
      dotGraphics.fillCircle(tx + 0.5, ty + 0.5, DOT_ENEMY_RADIUS);
    }

    const npcs = query(world.ecs, [Npc, Position]);
    for (const eid of npcs) {
      const wx = world.stores.position.x[eid] ?? 0;
      const wy = world.stores.position.y[eid] ?? 0;
      const tx = Math.floor(wx / tileFt);
      const ty = Math.floor(wy / tileFt);
      if (tx < 0 || ty < 0 || tx >= floorMap.width || ty >= floorMap.height) continue;
      const idx = ty * floorMap.width + tx;
      if (!visited[idx]) continue;
      dotGraphics.fillStyle(DOT_OUTLINE, 1);
      dotGraphics.fillCircle(tx + 0.5, ty + 0.5, DOT_NPC_RADIUS + DOT_OUTLINE_WIDTH);
      dotGraphics.fillStyle(DOT_NPC, 1);
      dotGraphics.fillCircle(tx + 0.5, ty + 0.5, DOT_NPC_RADIUS);
    }

    if (playerEid >= 0) {
      const px = world.stores.position.x[playerEid] ?? 0;
      const py = world.stores.position.y[playerEid] ?? 0;
      lastPlayerWorldX = px;
      lastPlayerWorldY = py;
      const ptx = px / tileFt;
      const pty = py / tileFt;
      dotGraphics.fillStyle(DOT_OUTLINE, 1);
      dotGraphics.fillCircle(ptx, pty, DOT_PLAYER_RADIUS + DOT_OUTLINE_WIDTH);
      dotGraphics.fillStyle(DOT_PLAYER_RING, 1);
      dotGraphics.fillCircle(ptx, pty, DOT_PLAYER_RADIUS);
      dotGraphics.fillStyle(DOT_PLAYER, 1);
      dotGraphics.fillCircle(ptx, pty, DOT_PLAYER_RADIUS - 0.3);
    }
  }

  /**
   * Renders the docked radar dial: terrain tiles + entity blips composited into
   * `radarRt` in dial-local pixels (player centred), with terrain analytically
   * clipped to the dial circle. Screen-space, deterministic, no masks.
   */
  function drawRadar(
    world: GameWorld,
    playerEid: number,
    floorMap: FloorMap,
    visited: Uint8Array,
  ): void {
    const tileFt = floorMap.config.tileSizeFt;
    let ptx = lastPlayerWorldX / tileFt;
    let pty = lastPlayerWorldY / tileFt;
    if (playerEid >= 0) {
      const px = world.stores.position.x[playerEid] ?? 0;
      const py = world.stores.position.y[playerEid] ?? 0;
      lastPlayerWorldX = px;
      lastPlayerWorldY = py;
      ptx = px / tileFt;
      pty = py / tileFt;
    }
    const scale = RADAR_PX_PER_TILE;
    const cx = HUD_RADAR_RADIUS;
    const cy = HUD_RADAR_RADIUS;
    // Keep blips (and their outlines) fully inside the dial so nothing pokes past
    // the gold ring; the ring band then covers the clipped terrain edge cleanly.
    const reach = RADAR_CLIP_RADIUS - 6;
    const clipR = RADAR_CLIP_RADIUS;
    const clipR2 = clipR * clipR;
    const localX = (tileX: number): number => cx + (tileX - ptx) * scale;
    const localY = (tileY: number): number => cy + (tileY - pty) * scale;
    const inDial = (x: number, y: number): boolean => Math.hypot(x - cx, y - cy) <= reach;

    radarRt.clear();

    // Terrain tiles around the player, analytically clipped to the dial circle.
    // Phaser 4.1's erase(canvasTexture) clip was unreliable (left wedge artifacts
    // and edge bleed), so each tile rect is intersected with the circle here:
    // fully-inside tiles fill in one rect, edge tiles fill per scanline so the
    // terrain disc has a clean circular boundary with zero overflow.
    const tileReach = Math.ceil(RADAR_CLIP_RADIUS / scale) + 2;
    const baseTx = Math.floor(ptx);
    const baseTy = Math.floor(pty);
    for (let ty = baseTy - tileReach; ty <= baseTy + tileReach; ty += 1) {
      if (ty < 0 || ty >= floorMap.height) continue;
      for (let tx = baseTx - tileReach; tx <= baseTx + tileReach; tx += 1) {
        if (tx < 0 || tx >= floorMap.width) continue;
        const idx = ty * floorMap.width + tx;
        if (!visited[idx]) continue;
        const terrain = floorMap.terrain[idx] ?? TerrainType.VOID;
        const color = MINI_COLORS[terrain] ?? 0x05060f;
        const left = Math.round(localX(tx));
        const top = Math.round(localY(ty));
        const right = left + scale;
        const bottom = top + scale;
        // Nearest point of the rect to the dial centre — reject fully-outside tiles.
        const ndx = left > cx ? left - cx : right < cx ? cx - right : 0;
        const ndy = top > cy ? top - cy : bottom < cy ? cy - bottom : 0;
        if (ndx * ndx + ndy * ndy >= clipR2) continue;
        // Farthest corner — accept fully-inside tiles with a single fill.
        const fdx = Math.max(Math.abs(left - cx), Math.abs(right - cx));
        const fdy = Math.max(Math.abs(top - cy), Math.abs(bottom - cy));
        if (fdx * fdx + fdy * fdy <= clipR2) {
          radarRt.fill(color, 1, left, top, scale, scale);
          continue;
        }
        // Edge tile: fill per 1px scanline clipped to the circle for a smooth arc.
        for (let yy = top; yy < bottom; yy += 1) {
          const dy = yy + 0.5 - cy;
          const inside = clipR2 - dy * dy;
          if (inside <= 0) continue;
          const dxh = Math.sqrt(inside);
          const xL = Math.max(left, Math.round(cx - dxh));
          const xR = Math.min(right, Math.round(cx + dxh));
          if (xR > xL) radarRt.fill(color, 1, xL, yy, xR - xL, 1);
        }
      }
    }

    // Blips drawn in dial-local pixels into the scratch graphics.
    radarScratch.clear();

    for (const room of floorMap.rooms) {
      const roomColor =
        room.role === RoomRole.SAFE
          ? DOT_SAFE_ROOM
          : room.role === RoomRole.BOSS_STAIR
            ? DOT_BOSS_ROOM
            : room.role === RoomRole.SPAWN
              ? DOT_SPAWN_ROOM
              : null;
      if (roomColor === null) continue;
      if (!roomHasDiscoveredTile(room, floorMap, visited)) continue;
      const rx = localX(room.bounds.x + Math.floor(room.bounds.width / 2) + 0.5);
      const ry = localY(room.bounds.y + Math.floor(room.bounds.height / 2) + 0.5);
      if (!inDial(rx, ry)) continue;
      const half = ROOM_MARKER_SIZE * scale * 0.5;
      radarScratch.fillStyle(roomColor, 1);
      radarScratch.fillRect(rx - half, ry - half, half * 2, half * 2);
    }

    const objective = world.floor1?.objective;
    if (objective?.staircaseSpawned && objective.staircaseDiscovered) {
      const stairTile = floorMap.worldToTile(objective.staircasePos.x, objective.staircasePos.y);
      if (
        stairTile.x >= 0 &&
        stairTile.y >= 0 &&
        stairTile.x < floorMap.width &&
        stairTile.y < floorMap.height &&
        visited[stairTile.y * floorMap.width + stairTile.x]
      ) {
        const sx = localX(stairTile.x + 0.5);
        const sy = localY(stairTile.y + 0.5);
        if (inDial(sx, sy)) {
          const half = STAIRS_MARKER_SIZE * scale * 0.5;
          radarScratch.fillStyle(DOT_STAIRS, 1);
          radarScratch.fillRect(sx - half, sy - half, half * 2, half * 2);
        }
      }
    }

    const outline = DOT_OUTLINE_WIDTH * scale;
    const enemyEids = query(world.ecs, [Enemy, Position]);
    for (const eid of enemyEids) {
      const wx = world.stores.position.x[eid] ?? 0;
      const wy = world.stores.position.y[eid] ?? 0;
      const tx = Math.floor(wx / tileFt);
      const ty = Math.floor(wy / tileFt);
      if (tx < 0 || ty < 0 || tx >= floorMap.width || ty >= floorMap.height) continue;
      if (!visited[ty * floorMap.width + tx]) continue;
      const ex = localX(wx / tileFt);
      const ey = localY(wy / tileFt);
      if (!inDial(ex, ey)) continue;
      radarScratch.fillStyle(DOT_OUTLINE, 1);
      radarScratch.fillCircle(ex, ey, DOT_ENEMY_RADIUS * scale + outline);
      radarScratch.fillStyle(DOT_ENEMY, 1);
      radarScratch.fillCircle(ex, ey, DOT_ENEMY_RADIUS * scale);
    }

    const npcEids = query(world.ecs, [Npc, Position]);
    for (const eid of npcEids) {
      const wx = world.stores.position.x[eid] ?? 0;
      const wy = world.stores.position.y[eid] ?? 0;
      const tx = Math.floor(wx / tileFt);
      const ty = Math.floor(wy / tileFt);
      if (tx < 0 || ty < 0 || tx >= floorMap.width || ty >= floorMap.height) continue;
      if (!visited[ty * floorMap.width + tx]) continue;
      const nx = localX(wx / tileFt);
      const ny = localY(wy / tileFt);
      if (!inDial(nx, ny)) continue;
      radarScratch.fillStyle(DOT_OUTLINE, 1);
      radarScratch.fillCircle(nx, ny, DOT_NPC_RADIUS * scale + outline);
      radarScratch.fillStyle(DOT_NPC, 1);
      radarScratch.fillCircle(nx, ny, DOT_NPC_RADIUS * scale);
    }

    if (playerEid >= 0) {
      radarScratch.fillStyle(DOT_OUTLINE, 1);
      radarScratch.fillCircle(cx, cy, DOT_PLAYER_RADIUS * scale + outline);
      radarScratch.fillStyle(DOT_PLAYER_RING, 1);
      radarScratch.fillCircle(cx, cy, DOT_PLAYER_RADIUS * scale);
      radarScratch.fillStyle(DOT_PLAYER, 1);
      radarScratch.fillCircle(cx, cy, (DOT_PLAYER_RADIUS - 0.3) * scale);
    }

    radarRt.draw(radarScratch);
    // Phaser 4 DynamicTexture ops (clear/fill/draw) are deferred to a command
    // buffer — render() flushes them so the dial actually updates. The circular
    // clip is done analytically in the terrain loop above (no erase needed).
    radarRt.render();
  }

  function ensureTerrainTexture(floorMap: FloorMap): void {
    if (terrainRt) {
      return;
    }
    // Depth HUD_DEPTH+3: above panelBg (+1), radarRt (+1), and viewportFrame (+2)
    // so terrain renders on top of the dark viewport background rectangle.
    // dotGraphics is at HUD_DEPTH+4 to render blips above terrain.
    terrainRt = scene.add
      .renderTexture(viewport.x, viewport.y, floorMap.width, floorMap.height)
      .setOrigin(0, 0)
      .setDepth(HUD_DEPTH + 3)
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
      if (overlayOpen) {
        drawDots(world, playerEid, floorMap, visited);
        applyViewTransform();
        terrainRt.setVisible(true);
        dotGraphics.setVisible(true);
        radarRt.setVisible(false);
      } else {
        drawRadar(world, playerEid, floorMap, visited);
        applyHudTransform();
        terrainRt.setVisible(false);
        dotGraphics.setVisible(false);
        radarRt.setVisible(true);
      }
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
    hudRingOuter.destroy();
    hudRingGold.destroy();
    hudRingInner.destroy();
    hudCompass.destroy();
    hudMapLabel.destroy();
    radarRt.destroy();
    radarScratch.destroy();
    overlayDimmer.destroy();
    panelBg.destroy();
    panelTitle.destroy();
    panelHint.destroy();
    viewportFrame.destroy();
    viewportHitArea.destroy();
    closeButtonBg.destroy();
    closeLabel.destroy();
  }

  function handlePointerUp(): void {
    dragging = false;
    lastPinchDist = 0;
  }

  hudMapBg.on('pointerdown', toggle);
  closeButtonBg.on('pointerdown', closeOverlay);
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
    getOverlayCloseBounds: (): ScreenBounds | null => {
      if (!overlayOpen) return null;
      const b = closeButtonBg.getBounds();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    },
    destroy,
  };
}
