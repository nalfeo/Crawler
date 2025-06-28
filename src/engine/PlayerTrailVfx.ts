/**
 * Player Trail VFX — small dust puffs that shed behind the player as they move.
 *
 * Purely cosmetic — reads the player's world-space position each rendered
 * frame, and when the player has moved far enough since the last emit,
 * spawns a fading dust circle at the player's PREVIOUS position. That places
 * the puff visually behind the direction of motion without needing to read
 * the player's facing.
 *
 * Non-deterministic (uses a private LCG for size / spread jitter) — render
 * only, never touches game state or the seeded gameplay RNG.
 *
 * Lives on the world camera at {@link WORLD_VFX_DEPTH.playerTrail} so puffs
 * scroll with the map.
 */
import type Phaser from 'phaser';
import { hasComponent, query } from 'bitecs';
import { Player, Position } from '../core/components.js';
import type { GameWorld } from '../core/world.js';
import { WORLD_VFX_DEPTH } from '../shared/render-depths.js';
import { ftToPx } from '../shared/units.js';
import { isBloodyFootprintSourceActive } from '../shared/blood-surfaces.js';

/** World-feet the player must travel before another puff is spawned. */
const TRAIL_EMIT_DISTANCE_FT = 0.35;
/** Puff lifetime in ms — short so the trail reads as motion, not a smear. */
const TRAIL_PUFF_LIFETIME_MS = 320;
/** Base puff radius in render pixels. */
const TRAIL_PUFF_BASE_RADIUS_PX = 3;
/** Vertical offset (px) applied so puffs anchor near the player's feet, not centre. */
const TRAIL_PUFF_FOOT_OFFSET_PX = 4;
/** Dust colour (dim grey/tan). ADD blend keeps it visible on dark floors. */
const TRAIL_PUFF_COLOR = 0x9a9080;
/** Peak alpha of a freshly-spawned puff. */
const TRAIL_PUFF_ALPHA = 0.35;

export interface PlayerTrailVfx {
  update(world: GameWorld, renderElapsedMs: number): void;
  destroy(): void;
}

export function createPlayerTrailVfx(scene: Phaser.Scene): PlayerTrailVfx {
  // Capability guard: headless/mocked scenes may not provide add.circle or the
  // tween manager. When absent we no-op — the trail is cosmetic and never
  // affects sim state, so silently skipping is correct.
  const dustEnabled =
    typeof scene.add?.circle === 'function' && typeof scene.tweens?.add === 'function';
  const graphicsEnabled = typeof scene.add?.graphics === 'function';

  const active = new Set<Phaser.GameObjects.Shape>();
  const footprintGraphics = new Map<number, Phaser.GameObjects.Graphics>();

  /** Private non-deterministic RNG — cosmetic only, isolated from world.rng. */
  let seed = 0x1a2b3c;
  const rand = (): number => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };

  let lastEmitX: number | null = null;
  let lastEmitY: number | null = null;

  function spawnPuff(px: number, py: number): void {
    if (!dustEnabled) return;
    const radius = TRAIL_PUFF_BASE_RADIUS_PX * (0.7 + rand() * 0.6);
    const puff = scene.add.circle(
      px + (rand() - 0.5) * 2,
      py + TRAIL_PUFF_FOOT_OFFSET_PX + (rand() - 0.5) * 2,
      radius,
      TRAIL_PUFF_COLOR,
      TRAIL_PUFF_ALPHA,
    );
    puff.setDepth(WORLD_VFX_DEPTH.playerTrail);
    puff.setBlendMode('ADD');
    // World-space only: hide from the UI camera the same way EffectsVfx does.
    (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(puff);
    active.add(puff);

    scene.tweens.add({
      targets: puff,
      alpha: { from: TRAIL_PUFF_ALPHA, to: 0 },
      scale: { from: 1, to: 1.6 },
      y: puff.y + 1.5,
      duration: TRAIL_PUFF_LIFETIME_MS * (0.8 + rand() * 0.4),
      ease: 'Quad.easeOut',
      onComplete: () => {
        active.delete(puff);
        puff.destroy();
      },
    });
  }

  function drawFootprintShape(
    graphic: Phaser.GameObjects.Graphics,
    footprint: GameWorld['bloodyFootprints'][number],
  ): void {
    graphic.clear();
    graphic.fillStyle(footprint.color, 1);
    if (footprint.smearLengthFt > 0) {
      graphic.fillEllipse(
        ftToPx(footprint.toeOffsetFt * 0.5),
        0,
        ftToPx(footprint.smearLengthFt),
        ftToPx(footprint.smearWidthFt),
      );
    }
    graphic.fillEllipse(
      0,
      0,
      ftToPx(footprint.heelRadiusXFt) * 2,
      ftToPx(footprint.heelRadiusYFt) * 2,
    );
    graphic.fillEllipse(
      ftToPx(footprint.toeOffsetFt),
      0,
      ftToPx(footprint.toeRadiusXFt) * 2,
      ftToPx(footprint.toeRadiusYFt) * 2,
    );
    graphic.setRotation(footprint.angleRad);
  }

  function setFootprintAlpha(
    graphic: Phaser.GameObjects.Graphics,
    footprint: GameWorld['bloodyFootprints'][number],
    simNowMs: number,
  ): void {
    const lifetimeMs = Math.max(1, footprint.expiresAtMs - footprint.createdAtMs);
    const progress = Math.max(0, Math.min(1, (simNowMs - footprint.createdAtMs) / lifetimeMs));
    const alpha = 0.58 * (1 - progress);
    graphic.setAlpha(alpha);
  }

  return {
    update(world: GameWorld, _renderElapsedMs: number): void {
      if (!dustEnabled && !graphicsEnabled) return;
      if (graphicsEnabled) {
        const activeFootprintIds = new Set(world.bloodyFootprints.map((footprint) => footprint.id));
        for (const [id, graphic] of footprintGraphics) {
          if (!activeFootprintIds.has(id)) {
            graphic.destroy();
            footprintGraphics.delete(id);
          }
        }
        for (const footprint of world.bloodyFootprints) {
          let graphic = footprintGraphics.get(footprint.id);
          if (!graphic) {
            graphic = scene.add.graphics({
              x: ftToPx(footprint.x),
              y: ftToPx(footprint.y) + TRAIL_PUFF_FOOT_OFFSET_PX,
            });
            graphic.setDepth(WORLD_VFX_DEPTH.bloodyFootprint);
            graphic.name = `bloody-footprint:${footprint.id}`;
            (scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(
              graphic,
            );
            drawFootprintShape(graphic, footprint);
            footprintGraphics.set(footprint.id, graphic);
          }
          setFootprintAlpha(graphic, footprint, world.elapsedMs);
        }
      }

      const players = query(world.ecs, [Player, Position]);
      if (players.length === 0) {
        lastEmitX = null;
        lastEmitY = null;
        return;
      }
      const playerEid = players[0]!;
      if (!hasComponent(world.ecs, playerEid, Position)) return;

      const wx = world.stores.position.x[playerEid] ?? 0;
      const wy = world.stores.position.y[playerEid] ?? 0;
      const sourceActive = isBloodyFootprintSourceActive(
        world.bloodyFootprintState.source,
        world.elapsedMs,
      );

      if (lastEmitX === null || lastEmitY === null) {
        lastEmitX = wx;
        lastEmitY = wy;
        return;
      }

      const dx = wx - lastEmitX;
      const dy = wy - lastEmitY;
      const distSq = dx * dx + dy * dy;
      if (distSq < TRAIL_EMIT_DISTANCE_FT * TRAIL_EMIT_DISTANCE_FT) return;

      if (!sourceActive) {
        // Spawn the puff at the PREVIOUS emit point so it visibly trails the
        // player rather than pinning to their current position.
        spawnPuff(ftToPx(lastEmitX), ftToPx(lastEmitY));
      }
      lastEmitX = wx;
      lastEmitY = wy;
    },

    destroy(): void {
      if (dustEnabled) {
        scene.tweens.killTweensOf([...active]);
      }
      for (const obj of active) obj.destroy();
      active.clear();
      for (const graphic of footprintGraphics.values()) {
        graphic.destroy();
      }
      footprintGraphics.clear();
      lastEmitX = null;
      lastEmitY = null;
    },
  };
}
