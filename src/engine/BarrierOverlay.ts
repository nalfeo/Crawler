/**
 * BarrierOverlay — engine-side per-frame renderer for the dynamic barrier
 * primitive (`src/core/barriers/`).
 *
 * Draws one tinted rectangle per active barrier tile. Kind-specific tint
 * gives fence / forcefield / wall distinct silhouettes; alpha is intentionally
 * a hair under one so the barrier reads as a shimmering energy layer rather
 * than a solid block (the fence is TRANSPARENT to FOV, so it must look that
 * way too).
 *
 * The overlay is engine-layer only — it consumes `world.barriers` as data
 * and does not know about spawners, boss rooms, or any specific caller. Any
 * system that raises a barrier gets a visible tile automatically.
 *
 * @remarks
 * We deliberately avoid coupling to the terrain spritesheet: the barrier
 * primitive must render even in tests / headless / early-boot scenes where
 * the Kenney atlas isn't loaded. Colored rectangles are always available
 * via Phaser's built-in graphics stack.
 */
import Phaser from 'phaser';
import type { BarrierRegistry, BarrierRingShape } from '../core/barriers/index.js';
import type { FloorMap } from '../core/map/FloorMap.js';
import { PIXELS_PER_FOOT } from '../shared/units.js';
import { createLogger } from '../shared/logger.js';

const logger = createLogger('engine:barrier-overlay');

/**
 * Depth: above terrain (-20) AND above doors (-19) so a sealed-room doorway
 * plug reads as an energy seal *over* the closed door, while still sitting
 * well below entities (0+). The open-fence ring wall is drawn in open space
 * where door depth is moot.
 */
const BARRIER_OVERLAY_DEPTH = -18;

/** Fallback tint by barrier kind (used when the sprite frame is unavailable). */
const KIND_TINT: Record<string, number> = {
  fence: 0x9be15d,
  forcefield: 0x5db6ff,
  wall: 0xc9a067,
};

/** Alpha for the shimmering tile look — enough to see through but very visible. */
const OVERLAY_ALPHA = 0.55;

/**
 * Alpha for the solid ring-WALL band. Higher than the tile shimmer so the
 * procedural circle reads as a real wall, not an energy field. A brighter thin
 * edge is stroked on the inner + outer faces for definition.
 */
const RING_WALL_ALPHA = 0.85;

export interface BarrierOverlayHandle {
  /** Rebuild the sprite pool from the registry. Cheap when version unchanged. */
  update(): void;
  /** Tear down every sprite. Safe to call more than once. */
  destroy(): void;
}

/**
 * Create + attach a BarrierOverlay. Call `handle.update()` each frame; it
 * short-circuits when the registry version has not changed.
 */
export function createBarrierOverlay(
  scene: Phaser.Scene,
  floorMap: FloorMap,
  registry: BarrierRegistry,
): BarrierOverlayHandle {
  const container = scene.add.container(0, 0).setDepth(BARRIER_OVERLAY_DEPTH);
  const sprites: Phaser.GameObjects.GameObject[] = [];
  let lastVersion = -1;

  const tileSizeFt = floorMap.config.tileSizeFt;
  const tileSizePx = tileSizeFt * PIXELS_PER_FOOT;
  const width = floorMap.width;

  function rebuild(): void {
    for (const sprite of sprites) sprite.destroy();
    sprites.length = 0;

    for (const handle of registry.barriers.values()) {
      const tint = KIND_TINT[handle.kind] ?? KIND_TINT.fence!;
      // Tile-granular barriers (doorway plugs, tile rings) → one rect per tile.
      for (const tileIdx of handle.tiles) {
        const tx = tileIdx % width;
        const ty = Math.floor(tileIdx / width);
        const px = tx * tileSizePx + tileSizePx / 2;
        const py = ty * tileSizePx + tileSizePx / 2;
        const rect = scene.add
          .rectangle(px, py, tileSizePx, tileSizePx, tint, OVERLAY_ALPHA)
          .setStrokeStyle(2, tint, 1);
        container.add(rect);
        sprites.push(rect);
      }
      // Analytic ring-wall barriers → one smooth stroked band (no blocky tiles).
      const shape = handle.shape;
      if (shape && shape.type === 'ring') {
        drawRingWall(shape, tint);
      }
    }
    logger.debug('BarrierOverlay rebuilt', {
      barriers: registry.barriers.size,
      tiles: registry.blockedTiles.size,
      ringShapes: registry.ringShapes.size,
    });
  }

  /**
   * Draw a procedural circular wall for an analytic ring shape. The band
   * `[innerRadiusFt, outerRadiusFt]` is rendered as a thick stroked circle
   * centred on the mid-radius (stroke width = band thickness), plus crisp thin
   * edges on the inner + outer faces so the 1 ft wall reads clearly at any zoom.
   */
  function drawRingWall(shape: BarrierRingShape, tint: number): void {
    const cx = shape.cxFt * PIXELS_PER_FOOT;
    const cy = shape.cyFt * PIXELS_PER_FOOT;
    const innerPx = shape.innerRadiusFt * PIXELS_PER_FOOT;
    const outerPx = shape.outerRadiusFt * PIXELS_PER_FOOT;
    const midPx = (innerPx + outerPx) / 2;
    const thicknessPx = Math.max(1, outerPx - innerPx);
    const g = scene.add.graphics();
    // Solid band: a stroked circle at the mid-radius whose line width equals
    // the band thickness fills exactly [innerPx, outerPx].
    g.lineStyle(thicknessPx, tint, RING_WALL_ALPHA);
    g.strokeCircle(cx, cy, midPx);
    // Bright thin edges for definition.
    g.lineStyle(2, tint, 1);
    g.strokeCircle(cx, cy, innerPx);
    g.strokeCircle(cx, cy, outerPx);
    container.add(g);
    sprites.push(g);
  }

  return {
    update(): void {
      if (registry.version === lastVersion) return;
      lastVersion = registry.version;
      rebuild();
    },
    destroy(): void {
      for (const sprite of sprites) sprite.destroy();
      sprites.length = 0;
      container.destroy();
    },
  };
}
