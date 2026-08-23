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
import type Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import {
  getQuestWaypoints,
  type QuestWaypoint,
  type QuestWaypointKind,
} from '../core/systems/questWaypoints.js';
import { GAME } from '../shared/constants.js';
import { PIXELS_PER_FOOT } from '../shared/units.js';
import { applyCrispText, type ScreenBounds } from './ui-scale.js';
import { getRenderScale } from './render-scale.js';
import { BLUE_STEEL } from './ui-theme.js';
import { boundsOverlap } from './navigation-hud-layout.js';

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
const LABEL_CHAR_WIDTH = 8;
const LABEL_LINE_HEIGHT = 15;
const LABEL_HORIZONTAL_PADDING = 14;
const LABEL_VERTICAL_PADDING = 12;
const LABEL_COLLISION_PADDING = 6;
const LABEL_VIEWPORT_PADDING = 18;
const LABEL_ARROW_GAP = 10;
const MAX_LABEL_LINE_CHARS = 36;
const MAX_LABEL_LINES = 2;

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

function fanDistance(attempt: number): number {
  if (attempt === 0) {
    return 0;
  }
  const direction = attempt % 2 === 1 ? 1 : -1;
  return Math.ceil(attempt / 2) * MIN_ARROW_SEPARATION * direction;
}

function labelLayout(
  screenX: number,
  screenY: number,
  text: string,
): { x: number; y: number; width: number; height: number } {
  const lines = text.split('\n');
  const width = Math.min(
    Math.max(...lines.map((line) => line.length)) * LABEL_CHAR_WIDTH + LABEL_HORIZONTAL_PADDING,
    GAME.WIDTH - LABEL_VIEWPORT_PADDING * 2,
  );
  const height = lines.length * LABEL_LINE_HEIGHT + LABEL_VERTICAL_PADDING;
  const verticalDirection = screenY >= CY ? -1 : 1;
  return {
    x: Math.min(
      GAME.WIDTH - LABEL_VIEWPORT_PADDING - width / 2,
      Math.max(LABEL_VIEWPORT_PADDING + width / 2, screenX),
    ),
    y: screenY + verticalDirection * (ARROW_SIZE / 2 + height / 2 + LABEL_ARROW_GAP),
    width,
    height,
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

export function formatWaypointDistance(distanceFt: number): string {
  if (distanceFt >= 10_000) {
    return `${Math.round(distanceFt / 1000)}k'`;
  }
  if (distanceFt >= 1000) {
    return `${(distanceFt / 1000).toFixed(1)}k'`;
  }
  return `${Math.round(distanceFt)}'`;
}

function wrapWaypointText(text: string): string {
  const lines: string[] = [];
  let current = '';
  const words = text
    .split(/\s+/)
    .filter((word) => word.length > 0)
    .flatMap((word) => {
      const chunks: string[] = [];
      for (let i = 0; i < word.length; i += MAX_LABEL_LINE_CHARS) {
        chunks.push(word.slice(i, i + MAX_LABEL_LINE_CHARS));
      }
      return chunks;
    });
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (candidate.length <= MAX_LABEL_LINE_CHARS) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current.length > 0) lines.push(current);
  if (lines.length <= MAX_LABEL_LINES) return lines.join('\n');
  const visible = lines.slice(0, MAX_LABEL_LINES);
  visible[MAX_LABEL_LINES - 1] =
    `${visible[MAX_LABEL_LINES - 1]!.slice(0, MAX_LABEL_LINE_CHARS - 3).trimEnd()}...`;
  return visible.join('\n');
}

function arrowBounds(x: number, y: number): ScreenBounds {
  return {
    x: x - ARROW_SIZE / 2,
    y: y - ARROW_SIZE / 2,
    width: ARROW_SIZE,
    height: ARROW_SIZE,
  };
}

function labelBounds(label: { x: number; y: number; width: number; height: number }): ScreenBounds {
  return {
    x: label.x - label.width / 2,
    y: label.y - label.height / 2,
    width: label.width,
    height: label.height,
  };
}

/**
 * Project a direction angle onto the rectangular inset boundary. Returns the
 * point on the boundary (centred at CX, CY) that a ray in direction `angle`
 * would hit first. Using the rectangle instead of the old ellipse keeps each
 * arrow pinned to exactly one screen edge (right/top/left/bottom), preventing
 * side-to-side bouncing as the player moves.
 */
type RectEdge = 'left' | 'right' | 'top' | 'bottom';

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

interface EdgePoint {
  readonly edge: RectEdge;
  readonly x: number;
  readonly y: number;
  readonly cos: number;
  readonly sin: number;
}

function rectEdgePt(angle: number): EdgePoint {
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const tH = cos !== 0 ? RX / Math.abs(cos) : Infinity;
  const tV = sin !== 0 ? RY / Math.abs(sin) : Infinity;
  const t = Math.min(tH, tV);
  return {
    edge: tH <= tV ? (cos >= 0 ? 'right' : 'left') : sin >= 0 ? 'bottom' : 'top',
    x: CX + cos * t,
    y: CY + sin * t,
    cos,
    sin,
  };
}

/**
 * Restrict the fan slide to the half of the edge the arrow actually points
 * toward. Without this, a strongly right-pointing arrow parked on the top or
 * bottom edge could be fanned all the way past screen centre and end up on the
 * left of the player while still pointing right (and vice versa).
 *
 * The lock only engages once the direction component along the slide axis is
 * meaningful; a near-perpendicular arrow (e.g. pointing straight down on the
 * bottom edge) has no "side" to honour, so it keeps the full edge for fanning.
 */
const SIDE_LOCK_THRESHOLD = Math.sin(Math.PI / 12); // 15°

function slideRange(
  component: number,
  center: number,
  halfExtent: number,
): { min: number; max: number } {
  if (component >= SIDE_LOCK_THRESHOLD) {
    return { min: center, max: center + halfExtent };
  }
  if (component <= -SIDE_LOCK_THRESHOLD) {
    return { min: center - halfExtent, max: center };
  }
  return { min: center - halfExtent, max: center + halfExtent };
}

function slideAlongEdge(edgePoint: EdgePoint, offset: number): { x: number; y: number } {
  switch (edgePoint.edge) {
    case 'left':
    case 'right': {
      const { min, max } = slideRange(edgePoint.sin, CY, RY);
      return { x: edgePoint.x, y: clamp(edgePoint.y + offset, min, max) };
    }
    case 'top':
    case 'bottom': {
      const { min, max } = slideRange(edgePoint.cos, CX, RX);
      return { x: clamp(edgePoint.x + offset, min, max), y: edgePoint.y };
    }
  }
}

/** Pure screen-space layout used by the Phaser widget and unit tests. */
export function resolveDirectionArrowStates(
  waypoints: readonly QuestWaypoint[],
  playerX: number,
  playerY: number,
  zoom: number,
  forbiddenRegions: readonly ScreenBounds[] = [],
): DirectionArrowState[] {
  const scale = PIXELS_PER_FOOT * (zoom || 1);
  const states: DirectionArrowState[] = [];

  for (const waypoint of waypoints) {
    // Off-screen culling and the displayed distance always use the precise
    // target so they stay accurate per-quest; only the angle is normalized
    // to the shared room anchor (`dirX`/`dirY`) so co-located arrows agree
    // on direction without misreporting visibility or range.
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

    const angleDx = waypoint.dirX - playerX;
    const angleDy = waypoint.dirY - playerY;
    const targetAngle = Math.atan2(angleDy, angleDx);
    const distanceFt = Math.hypot(dx, dy);
    const labelText = wrapWaypointText(`${waypoint.label}  ${formatWaypointDistance(distanceFt)}`);
    const edgePoint = rectEdgePt(targetAngle);
    const maxAttempts = Math.max(48, waypoints.length * 12);
    let placement:
      | {
          readonly screenX: number;
          readonly screenY: number;
          readonly label: ReturnType<typeof labelLayout>;
        }
      | undefined;
    let labelOverlapFallback:
      | {
          readonly screenX: number;
          readonly screenY: number;
          readonly label: ReturnType<typeof labelLayout>;
        }
      | undefined;
    for (let attempt = 0; attempt <= maxAttempts; attempt += 1) {
      const { x: candidateX, y: candidateY } = slideAlongEdge(edgePoint, fanDistance(attempt));
      const candidateLabel = labelLayout(candidateX, candidateY, labelText);
      const arrowAvoidsHud = forbiddenRegions.every(
        (region) =>
          !boundsOverlap(arrowBounds(candidateX, candidateY), region, LABEL_COLLISION_PADDING),
      );
      if (!arrowAvoidsHud) {
        continue;
      }
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
      if (!clear) {
        continue;
      }
      const labelAvoidsHud = forbiddenRegions.every(
        (region) => !boundsOverlap(labelBounds(candidateLabel), region, LABEL_COLLISION_PADDING),
      );
      if (labelAvoidsHud) {
        placement = { screenX: candidateX, screenY: candidateY, label: candidateLabel };
        break;
      }
      if (!labelOverlapFallback) {
        labelOverlapFallback = { screenX: candidateX, screenY: candidateY, label: candidateLabel };
      }
    }
    placement ??= labelOverlapFallback;

    if (!placement) {
      continue;
    }

    states.push({
      questId: waypoint.questId,
      label: waypoint.label,
      kind: waypoint.kind,
      screenX: placement.screenX,
      screenY: placement.screenY,
      rotation: targetAngle + Math.PI / 2,
      distanceFt,
      labelText,
      labelScreenX: placement.label.x,
      labelScreenY: placement.label.y,
      labelWidth: placement.label.width,
      labelHeight: placement.label.height,
    });
  }

  return states;
}

interface ArrowVisual {
  readonly arrow: Phaser.GameObjects.Triangle;
  readonly labelBg: Phaser.GameObjects.Rectangle;
  readonly label: Phaser.GameObjects.Text;
  readonly pulse: Phaser.Tweens.Tween;
  readonly detachCrispText: () => void;
}

export function createHudDirectionArrows(scene: Phaser.Scene): {
  sync(world: GameWorld, playerEid: number, forbiddenRegions?: readonly ScreenBounds[]): void;
  setVisible(visible: boolean): void;
  getBounds(): readonly ScreenBounds[];
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
    const labelBg = scene.add
      .rectangle(CX, CY, 1, LABEL_LINE_HEIGHT + LABEL_VERTICAL_PADDING, BLUE_STEEL.panelBg, 0.94)
      .setStrokeStyle(1, BLUE_STEEL.panelBorder, 1)
      .setOrigin(0.5, 0.5)
      .setScrollFactor(0)
      .setDepth(DEPTH - 1)
      .setVisible(false);
    const label = scene.add
      .text(CX, CY, '', {
        fontFamily: '"Press Start 2P", "Courier New", monospace',
        fontSize: '8px',
        fontStyle: 'bold',
        align: 'center',
        lineSpacing: 3,
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
    return { arrow, labelBg, label, pulse, detachCrispText: applyCrispText(scene, [label]) };
  }

  function hideVisual(visual: ArrowVisual): void {
    visual.arrow.setVisible(false);
    visual.labelBg.setVisible(false);
    visual.label.setVisible(false);
    visual.pulse.pause();
  }

  function destroyVisual(visual: ArrowVisual): void {
    visual.detachCrispText();
    visual.pulse.stop();
    visual.arrow.destroy();
    visual.labelBg.destroy();
    visual.label.destroy();
  }

  function sync(
    world: GameWorld,
    playerEid: number,
    forbiddenRegions: readonly ScreenBounds[] = [],
  ): void {
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

    // Divide by renderScale so the on-screen check operates in design-space
    // pixels, not canvas pixels.  camera.zoom = BASE_ZOOM * renderScale, so
    // scale = PIXELS_PER_FOOT * (zoom / renderScale) = PIXELS_PER_FOOT * BASE_ZOOM
    // regardless of HiDPI supersample factor.
    const renderScale = getRenderScale(scene);
    const states = resolveDirectionArrowStates(
      waypoints,
      px,
      py,
      (scene.cameras.main.zoom || 1) / renderScale,
      forbiddenRegions,
    );
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
      visual.labelBg
        .setPosition(state.labelScreenX, state.labelScreenY)
        .setSize(state.labelWidth, state.labelHeight)
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

  function getBounds(): readonly ScreenBounds[] {
    const bounds: ScreenBounds[] = [];
    for (const visual of visuals.values()) {
      if (!visual.arrow.visible || !visual.labelBg.visible) {
        continue;
      }
      const arrow = visual.arrow.getBounds();
      const label = visual.labelBg.getBounds();
      const left = Math.min(arrow.x, label.x);
      const top = Math.min(arrow.y, label.y);
      const right = Math.max(arrow.right, label.right);
      const bottom = Math.max(arrow.bottom, label.bottom);
      bounds.push({ x: left, y: top, width: right - left, height: bottom - top });
    }
    return bounds;
  }

  return { sync, setVisible, getBounds, destroy };
}
