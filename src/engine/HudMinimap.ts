/**
 * HudMinimap — collapsible top-right minimap.
 *
 * States:
 *   Collapsed: 40×40 icon with "M" hint label.
 *   Expanded:  ~200×150 RenderTexture. Terrain drawn for explored (ever-visible)
 *              tiles only; enemy dots drawn for currently-visible enemies; player
 *              dot always visible.
 *
 * Discovery model:
 *   A local `visitedTiles` Uint8Array accumulates tiles exposed by fovSystem
 *   (floorMap.visible). Terrain is rendered for visited tiles only, preserving
 *   FOV exploration. Enemy dots are drawn only when the enemy's tile is currently
 *   visible, preventing off-screen radar.
 *
 * Toggle:
 *   M key (via window listener, not Phaser keyboard plugin — canvas focus safe).
 *   Also click on the collapsed icon.
 */
import Phaser from 'phaser';
import { query } from 'bitecs';
import { Enemy, Position } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { TerrainType } from '../shared/map-types.js';
import type { FloorMap } from '../core/map/FloorMap.js';

// ---------------------------------------------------------------------------
// Layout / style constants
// ---------------------------------------------------------------------------

const ICON_SIZE = 40;
const ICON_X = GAME.WIDTH - ICON_SIZE - 12;
const ICON_Y = 12;

const MAP_WIDTH = 200;
const MAP_HEIGHT = 150;
const MAP_X = GAME.WIDTH - MAP_WIDTH - 12;
const MAP_Y = 12;
const MAP_BORDER = 1;

const DEPTH = 1000;

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

const DOT_PLAYER = 0xffffff;
const DOT_ENEMY = 0xef4444;
const DOT_PLAYER_RADIUS = 3;
const DOT_ENEMY_RADIUS = 2;

export function createHudMinimap(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  toggle(): void;
  destroy(): void;
} {
  // --- Collapsed icon ---
  const iconBg = scene.add
    .rectangle(ICON_X + ICON_SIZE / 2, ICON_Y + ICON_SIZE / 2, ICON_SIZE, ICON_SIZE, 0x111827, 0.9)
    .setStrokeStyle(1, 0x334155)
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setInteractive({ useHandCursor: true });

  const iconLabel = scene.add
    .text(ICON_X + ICON_SIZE / 2, ICON_Y + ICON_SIZE / 2, 'MAP', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#e2e8f0',
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1);

  const iconHint = scene.add
    .text(ICON_X + ICON_SIZE / 2, ICON_Y + ICON_SIZE + 4, 'M', {
      fontFamily: 'monospace',
      fontSize: '10px',
      color: '#64748b',
    })
    .setOrigin(0.5, 0)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1);

  // --- Expanded map container ---
  const mapBg = scene.add
    .rectangle(
      MAP_X + MAP_WIDTH / 2,
      MAP_Y + MAP_HEIGHT / 2,
      MAP_WIDTH + MAP_BORDER * 2,
      MAP_HEIGHT + MAP_BORDER * 2,
      0x0d1117,
      0.92,
    )
    .setStrokeStyle(1, 0x334155)
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setVisible(false);

  let rt: Phaser.GameObjects.RenderTexture | undefined;
  const dotGraphics = scene.add
    .graphics()
    .setScrollFactor(0)
    .setDepth(DEPTH + 2)
    .setVisible(false);

  const closeLabel = scene.add
    .text(MAP_X + MAP_WIDTH - 6, MAP_Y + 4, '✕', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#64748b',
    })
    .setOrigin(1, 0)
    .setScrollFactor(0)
    .setDepth(DEPTH + 3)
    .setVisible(false)
    .setInteractive({ useHandCursor: true });

  // --- State ---
  let expanded = false;
  let lastFloorMap: FloorMap | null = null;
  let visitedTiles: Uint8Array | null = null;

  // ---------------------------------------------------------------------------
  // Terrain bake — incremental
  // ---------------------------------------------------------------------------

  // Scale factors cached per floorMap to avoid recomputing each sync.
  let cachedScaleX = 0;
  let cachedScaleY = 0;
  let cachedTilePx = 0;
  let cachedPixW = 0;
  let cachedPixH = 0;

  /**
   * Stamp only the newly revealed tile indices onto the persistent RenderTexture.
   * Creates the RT on first call per floor; reuses it on subsequent calls so we
   * never iterate or redraw already-visited tiles.
   */
  function bakeNewTiles(floorMap: FloorMap, newIndices: number[]): void {
    if (!rt) {
      cachedScaleX = MAP_WIDTH / floorMap.widthPx;
      cachedScaleY = MAP_HEIGHT / floorMap.heightPx;
      cachedTilePx = floorMap.config.tileSizePx;
      cachedPixW = Math.max(1, cachedTilePx * cachedScaleX);
      cachedPixH = Math.max(1, cachedTilePx * cachedScaleY);
      rt = scene.add
        .renderTexture(MAP_X, MAP_Y, MAP_WIDTH, MAP_HEIGHT)
        .setOrigin(0, 0)
        .setScrollFactor(0)
        .setDepth(DEPTH + 1)
        .setVisible(false);
    }

    for (const idx of newIndices) {
      const tx = idx % floorMap.width;
      const ty = Math.floor(idx / floorMap.width);
      const terrain = floorMap.terrain[idx] ?? TerrainType.VOID;
      const color = MINI_COLORS[terrain] ?? 0x05060f;
      rt.fill(
        color,
        1,
        tx * cachedTilePx * cachedScaleX,
        ty * cachedTilePx * cachedScaleY,
        cachedPixW,
        cachedPixH,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Dot overlay
  // ---------------------------------------------------------------------------

  function drawDots(world: GameWorld, playerEid: number, floorMap: FloorMap): void {
    dotGraphics.clear();
    const scaleX = MAP_WIDTH / floorMap.widthPx;
    const scaleY = MAP_HEIGHT / floorMap.heightPx;
    const tilePx = floorMap.config.tileSizePx;

    // Enemy dots — only when tile is currently visible
    const enemies = query(world.ecs, [Enemy, Position]);
    for (const eid of enemies) {
      const wx = world.stores.position.x[eid] ?? 0;
      const wy = world.stores.position.y[eid] ?? 0;
      const tx = Math.floor(wx / tilePx);
      const ty = Math.floor(wy / tilePx);
      const idx = ty * floorMap.width + tx;
      if (tx < 0 || ty < 0 || tx >= floorMap.width || ty >= floorMap.height) continue;
      if (!floorMap.visible[idx]) continue;
      const mx = MAP_X + wx * scaleX;
      const my = MAP_Y + wy * scaleY;
      dotGraphics.fillStyle(DOT_ENEMY, 1);
      dotGraphics.fillCircle(mx, my, DOT_ENEMY_RADIUS);
    }

    // Player dot — always shown
    if (playerEid >= 0) {
      const px = world.stores.position.x[playerEid] ?? 0;
      const py = world.stores.position.y[playerEid] ?? 0;
      const mx = MAP_X + px * scaleX;
      const my = MAP_Y + py * scaleY;
      dotGraphics.fillStyle(DOT_PLAYER, 1);
      dotGraphics.fillCircle(mx, my, DOT_PLAYER_RADIUS);
    }
  }

  // ---------------------------------------------------------------------------
  // Visibility helpers
  // ---------------------------------------------------------------------------

  function showExpanded(): void {
    iconBg.setVisible(false);
    iconLabel.setVisible(false);
    iconHint.setVisible(false);
    mapBg.setVisible(true);
    rt?.setVisible(true);
    dotGraphics.setVisible(true);
    closeLabel.setVisible(true);
  }

  function showCollapsed(): void {
    iconBg.setVisible(true);
    iconLabel.setVisible(true);
    iconHint.setVisible(true);
    mapBg.setVisible(false);
    rt?.setVisible(false);
    dotGraphics.setVisible(false);
    closeLabel.setVisible(false);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  function toggle(): void {
    expanded = !expanded;
    if (expanded) {
      showExpanded();
    } else {
      showCollapsed();
    }
  }

  function sync(world: GameWorld, playerEid: number): void {
    const floorMap = world.floorMap;

    if (!floorMap) {
      return;
    }

    // Reset visited buffer when floor changes
    if (floorMap !== lastFloorMap) {
      lastFloorMap = floorMap;
      visitedTiles = new Uint8Array(floorMap.width * floorMap.height);
      // Invalidate baked terrain
      rt?.destroy();
      rt = undefined;
    }

    // Accumulate explored tiles; collect only newly revealed indices
    const visited = visitedTiles!;
    const newIndices: number[] = [];
    for (let i = 0; i < visited.length; i += 1) {
      if (!visited[i] && floorMap.visible[i]) {
        visited[i] = 1;
        newIndices.push(i);
      }
    }

    // Stamp only new tiles onto the persistent RT (or create it on first call)
    if (newIndices.length > 0 || !rt) {
      bakeNewTiles(floorMap, newIndices);
      if (expanded) {
        rt?.setVisible(true);
      }
    }

    if (expanded) {
      drawDots(world, playerEid, floorMap);
    }
  }

  function destroy(): void {
    rt?.destroy();
    dotGraphics.destroy();
    iconBg.destroy();
    iconLabel.destroy();
    iconHint.destroy();
    mapBg.destroy();
    closeLabel.destroy();
  }

  // --- Wire click listeners ---
  iconBg.on('pointerdown', toggle);
  closeLabel.on('pointerdown', toggle);

  // --- M-key via window listener (canvas-focus-safe) ---
  function handleKeyDown(e: KeyboardEvent): void {
    if (e.key === 'm' || e.key === 'M') {
      toggle();
    }
  }
  window.addEventListener('keydown', handleKeyDown);

  // Extend destroy to remove window listener
  const originalDestroy = destroy;
  return {
    sync,
    toggle,
    destroy() {
      window.removeEventListener('keydown', handleKeyDown);
      originalDestroy();
    },
  };
}
