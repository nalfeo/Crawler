/**
 * HudDirectionArrows — off-screen quest waypoint pointers.
 *
 * Reads every active quest waypoint (`getQuestWaypoints`) and, for each off-screen
 * target, draws a pulsing arrow pinned to the screen edge plus a feet-distance
 * label. Nearby arrows fan apart so every quest remains individually visible.
 *
 * Render-only: reads sim state in feet, converts to pixels at the boundary, and
 * never writes back. Direction depends only on the player→target vector, so it
 * is correct regardless of camera zoom.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import {
  getQuestWaypoints,
  type QuestWaypoint,
  type QuestWaypointKind,
} from '../core/systems/questWaypoints.js';
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
const SCREEN_MARGIN = 80;
const MIN_ARROW_SEPARATION = 48;
const FAN_ANGLE_STEP = Math.PI / 24;
const LABEL_OFFSET = ARROW_SIZE + 4;
const LABEL_CHAR_WIDTH = 7;
const LABEL_HEIGHT = 16;
const LABEL_COLLISION_PADDING = 6;
const LABEL_VIEWPORT_PADDING = 8;

const KIND_COLORS: Readonly<Record<QuestWaypointKind, number>> = {
  npc: 0xfcd34d,
  item: 0x2dd4bf,
  combat: 0xef4444,
  stairs: 0xf8fafc,
};

export interface DirectionArrowState {
  readonly questId: string;
  readonly label: string;
  readonly kind: QuestWaypointKind;
  readonly screenX: number;
  readonly screenY: number;
  readonly rotation: number;
  readonly distanceFt: number;
  readonly labelText: string;
  readonly labelScreenX: number;
  readonly labelScreenY: number;
  readonly labelWidth: number;
  readonly labelHeight: number;
}

function fanOffset(attempt: number): number {
  if (attempt === 0) {
    return 0;
  }
  const direction = attempt % 2 === 1 ? 1 : -1;
  return Math.ceil(attempt / 2) * FAN_ANGLE_STEP * direction;
}

function labelLayout(
  screenX: number,
  screenY: number,
  text: string,
): { x: number; y: number; width: number; height: number } {
  const width = Math.min(text.length * LABEL_CHAR_WIDTH, GAME.WIDTH - LABEL_VIEWPORT_PADDING * 2);
  return {
    x: Math.min(
      GAME.WIDTH - LABEL_VIEWPORT_PADDING - width / 2,
      Math.max(LABEL_VIEWPORT_PADDING + width / 2, screenX),
    ),
    y: screenY + (screenY >= CY ? -LABEL_OFFSET : LABEL_OFFSET),
    width,
    height: LABEL_HEIGHT,
  };
}

function labelsOverlap(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number },
): boolean {
  return (
    Math.abs(a.x - b.x) * 2 < a.width + b.width + LABEL_COLLISION_PADDING * 2 &&
    Math.abs(a.y - b.y) * 2 < a.height + b.height + LABEL_COLLISION_PADDING * 2
  );
}

/** Pure screen-space layout used by the Phaser widget and unit tests. */
export function resolveDirectionArrowStates(
  waypoints: readonly QuestWaypoint[],
  playerX: number,
  playerY: number,
  zoom: number,
): DirectionArrowState[] {
  const scale = PIXELS_PER_FOOT * (zoom || 1);
  const states: DirectionArrowState[] = [];

  for (const waypoint of waypoints) {
    const dx = waypoint.x - playerX;
    const dy = waypoint.y - playerY;
    const targetScreenX = CX + dx * scale;
    const targetScreenY = CY + dy * scale;
    const onScreen =
      targetScreenX >= SCREEN_MARGIN &&
      targetScreenX <= GAME.WIDTH - SCREEN_MARGIN &&
      targetScreenY >= SCREEN_MARGIN &&
      targetScreenY <= GAME.HEIGHT - SCREEN_MARGIN;
    if (onScreen) {
      continue;
    }

    const targetAngle = Math.atan2(dy, dx);
    const distanceFt = Math.hypot(dx, dy);
    const labelText = `${waypoint.label}  ${Math.round(distanceFt)}'`;
    let screenX = CX + Math.cos(targetAngle) * RX;
    let screenY = CY + Math.sin(targetAngle) * RY;
    let label = labelLayout(screenX, screenY, labelText);
    const maxAttempts = Math.max(24, waypoints.length * 8);
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      const displayAngle = targetAngle + fanOffset(attempt);
      const candidateX = CX + Math.cos(displayAngle) * RX;
      const candidateY = CY + Math.sin(displayAngle) * RY;
      const candidateLabel = labelLayout(candidateX, candidateY, labelText);
      const clear = states.every(
        (state) =>
          Math.hypot(candidateX - state.screenX, candidateY - state.screenY) >=
            MIN_ARROW_SEPARATION &&
          !labelsOverlap(candidateLabel, {
            x: state.labelScreenX,
            y: state.labelScreenY,
            width: state.labelWidth,
            height: state.labelHeight,
          }),
      );
      screenX = candidateX;
      screenY = candidateY;
      label = candidateLabel;
      if (clear) {
        break;
      }
    }

    states.push({
      questId: waypoint.questId,
      label: waypoint.label,
      kind: waypoint.kind,
      screenX,
      screenY,
      rotation: targetAngle + Math.PI / 2,
      distanceFt,
      labelText,
      labelScreenX: label.x,
      labelScreenY: label.y,
      labelWidth: label.width,
      labelHeight: label.height,
    });
  }

  return states;
}

interface ArrowVisual {
  readonly arrow: Phaser.GameObjects.Triangle;
  readonly label: Phaser.GameObjects.Text;
  readonly pulse: Phaser.Tweens.Tween;
  readonly detachCrispText: () => void;
}

export function createHudDirectionArrows(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number): void;
  setVisible(visible: boolean): void;
  destroy(): void;
} {
  const visuals = new Map<string, ArrowVisual>();

  function createVisual(questId: string): ArrowVisual {
    // Isosceles triangle pointing up (+x apex after rotation by angle+90°).
    const arrow = scene.add
      .triangle(CX, CY, 0, ARROW_SIZE, ARROW_SIZE, ARROW_SIZE, ARROW_SIZE / 2, 0, 0xfcd34d, 1)
      .setStrokeStyle(2, 0x02040a, 1)
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(DEPTH)
      .setName(`quest-direction-arrow:${questId}`)
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
      .setName(`quest-direction-label:${questId}`)
      .setVisible(false);
    const pulse = scene.tweens.add({
      targets: arrow,
      alpha: { from: 1, to: 0.5 },
      duration: 600,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
      paused: true,
    });
    return { arrow, label, pulse, detachCrispText: applyCrispText(scene, [label]) };
  }

  function hideVisual(visual: ArrowVisual): void {
    visual.arrow.setVisible(false);
    visual.label.setVisible(false);
    visual.pulse.pause();
  }

  function destroyVisual(visual: ArrowVisual): void {
    visual.detachCrispText();
    visual.pulse.stop();
    visual.arrow.destroy();
    visual.label.destroy();
  }

  function sync(world: GameWorld, playerEid: number): void {
    if (playerEid < 0) {
      for (const visual of visuals.values()) {
        hideVisual(visual);
      }
      return;
    }
    const waypoints = getQuestWaypoints(world, playerEid);
    const px = world.stores.position.x[playerEid];
    const py = world.stores.position.y[playerEid];
    if (px === undefined || py === undefined) {
      for (const visual of visuals.values()) {
        hideVisual(visual);
      }
      return;
    }

    const activeQuestIds = new Set(waypoints.map((waypoint) => waypoint.questId));
    for (const [questId, visual] of visuals) {
      if (!activeQuestIds.has(questId)) {
        destroyVisual(visual);
        visuals.delete(questId);
      }
    }

    const states = resolveDirectionArrowStates(waypoints, px, py, scene.cameras.main.zoom || 1);
    const stateByQuestId = new Map(states.map((state) => [state.questId, state]));
    for (const waypoint of waypoints) {
      const state = stateByQuestId.get(waypoint.questId);
      const existing = visuals.get(waypoint.questId);
      if (!state) {
        if (existing) {
          hideVisual(existing);
        }
        continue;
      }
      const visual = existing ?? createVisual(waypoint.questId);
      if (!existing) {
        visuals.set(waypoint.questId, visual);
      }
      visual.arrow
        .setPosition(state.screenX, state.screenY)
        .setRotation(state.rotation)
        .setFillStyle(KIND_COLORS[state.kind], 1)
        .setVisible(true);
      visual.label
        .setPosition(state.labelScreenX, state.labelScreenY)
        .setText(state.labelText)
        .setVisible(true);
      visual.pulse.resume();
    }
  }

  /**
   * Master visibility gate used when a full-screen panel (character/equipment
   * screen) is open. Hiding just calls hide(); showing is a no-op because the
   * next sync() re-derives arrow visibility from world state (and HudUI stops
   * calling sync() while the HUD is hidden).
   */
  function setVisible(visible: boolean): void {
    if (!visible) {
      for (const visual of visuals.values()) {
        hideVisual(visual);
      }
    }
  }

  function destroy(): void {
    for (const visual of visuals.values()) {
      destroyVisual(visual);
    }
    visuals.clear();
  }

  return { sync, setVisible, destroy };
}
