/**
 * HudDirectionArrows — off-screen quest waypoint pointer.
 *
 * Reads the tracked quest's active waypoint (`getQuestWaypoints`) and, when the
 * target is off the visible viewport, draws a pulsing arrow pinned to the screen
 * edge that points toward it plus a feet-distance label. When the target is
 * on-screen the arrow hides (the minimap marker + world beacon take over).
 *
 * Render-only: reads sim state in feet, converts to pixels at the boundary, and
 * never writes back. Direction depends only on the player→target vector, so it
 * is correct regardless of camera zoom.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { getQuestWaypoints, type QuestWaypointKind } from '../core/systems/questWaypoints.js';
import { GAME } from '../shared/constants.js';
import { PIXELS_PER_FOOT } from '../shared/units.js';
import { applyCrispText } from './ui-scale.js';

const DEPTH = 1000;
const CX = GAME.WIDTH / 2;
const CY = GAME.HEIGHT / 2;
// Edge inset for the pointer ring; keeps the arrow clear of corner HUD panels.
const RING_INSET = 96;
const RX = GAME.WIDTH / 2 - RING_INSET;
const RY = GAME.HEIGHT / 2 - RING_INSET;
const ARROW_SIZE = 22;

const KIND_COLORS: Readonly<Record<QuestWaypointKind, number>> = {
  npc: 0xfcd34d,
  item: 0x2dd4bf,
  combat: 0xef4444,
  stairs: 0xf8fafc,
};

export function createHudDirectionArrows(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  destroy(): void;
} {
  // Isosceles triangle pointing up (+x apex after we rotate by angle+90°).
  const arrow = scene.add
    .triangle(CX, CY, 0, ARROW_SIZE, ARROW_SIZE, ARROW_SIZE, ARROW_SIZE / 2, 0, 0xfcd34d, 1)
    .setStrokeStyle(2, 0x02040a, 1)
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setVisible(false);

  const label = scene.add
    .text(CX, CY, '', {
      fontFamily: 'monospace',
      fontSize: '11px',
      fontStyle: 'bold',
      color: '#fde68a',
      stroke: '#02040a',
      strokeThickness: 3,
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setVisible(false);
  const detachCrispText = applyCrispText(scene, [label]);

  const pulse = scene.tweens.add({
    targets: arrow,
    alpha: { from: 1, to: 0.5 },
    duration: 600,
    yoyo: true,
    repeat: -1,
    ease: 'Sine.easeInOut',
    paused: true,
  });

  function hide(): void {
    if (arrow.visible) {
      arrow.setVisible(false);
      label.setVisible(false);
      pulse.pause();
    }
  }

  function sync(world: GameWorld, playerEid: number): void {
    if (playerEid < 0) {
      hide();
      return;
    }
    const waypoints = getQuestWaypoints(world, playerEid);
    const wp = waypoints[0];
    const px = world.stores.position.x[playerEid];
    const py = world.stores.position.y[playerEid];
    if (!wp || px === undefined || py === undefined) {
      hide();
      return;
    }

    const zoom = scene.cameras.main.zoom || 1;
    const scale = PIXELS_PER_FOOT * zoom;
    // Player is camera-centred, so target screen px is centre + offset.
    const sx = CX + (wp.x - px) * scale;
    const sy = CY + (wp.y - py) * scale;
    const margin = 80;
    const onScreen =
      sx >= margin && sx <= GAME.WIDTH - margin && sy >= margin && sy <= GAME.HEIGHT - margin;
    if (onScreen) {
      hide();
      return;
    }

    const distFt = Math.hypot(wp.x - px, wp.y - py);
    const angle = Math.atan2(wp.y - py, wp.x - px);
    const ex = CX + Math.cos(angle) * RX;
    const ey = CY + Math.sin(angle) * RY;
    const color = KIND_COLORS[wp.kind];

    arrow
      .setPosition(ex, ey)
      .setRotation(angle + Math.PI / 2)
      .setFillStyle(color, 1)
      .setVisible(true);
    label
      .setPosition(ex, ey + ARROW_SIZE + 4)
      .setText(`${wp.label}  ${Math.round(distFt)}'`)
      .setVisible(true);
    pulse.resume();
  }

  function destroy(): void {
    detachCrispText();
    pulse.stop();
    arrow.destroy();
    label.destroy();
  }

  return { sync, destroy };
}
