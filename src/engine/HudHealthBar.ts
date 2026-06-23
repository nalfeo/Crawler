/**
 * HudHealthBar — fixed-position health bar rendered in the Phaser scene.
 *
 * Cohesive pixel-UI styling (see engine/pixel-ui): a raised beveled panel holds
 * a pixel heart icon, an inset segmented HP bar with a glossy shine, and a
 * centered HP readout. Colour transitions green → amber → red; a tween pulses
 * the fill at low HP. Public `sync`/`destroy` contract is unchanged.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import {
  PIXEL_UI,
  PIXEL_UI_DEPTH,
  PIXEL_ICON,
  createBeveledPanel,
  createStatBar,
  addPixelIcon,
} from './pixel-ui.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const PAD = 7;
const ICON_SIZE = 16;
const BAR_WIDTH = 200;
const BAR_HEIGHT = 18;
const PANEL_W = PAD + ICON_SIZE + 6 + BAR_WIDTH + PAD;
const PANEL_H = PAD + BAR_HEIGHT + PAD;

const BAR_X = 16;
const BAR_Y = GAME.HEIGHT - 52;

const LOW_HP_THRESHOLD = 0.25;

export interface HudHealthBarOptions {
  /** Horizontal position of left edge. Defaults to 16. */
  x?: number;
  /** Vertical position of bar top edge. Defaults to bottom-left corner. */
  y?: number;
  /** Optional container to parent all created objects into (for group scaling). */
  parent?: Phaser.GameObjects.Container;
}

export function createHudHealthBar(
  scene: Phaser.Scene,
  options: HudHealthBarOptions = {},
): {
  sync(world: GameWorld, playerEid: number): void;
  destroy(): void;
} {
  const barX = options.x ?? BAR_X;
  const barY = options.y ?? BAR_Y;
  const parent = options.parent;

  const panelX = barX;
  const panelY = barY + BAR_HEIGHT / 2 - PANEL_H / 2;

  const panel = createBeveledPanel(scene, panelX, panelY, PANEL_W, PANEL_H, { parent });

  const iconCx = panelX + PAD + ICON_SIZE / 2;
  const iconCy = panelY + PANEL_H / 2;
  const icon = addPixelIcon(scene, PIXEL_ICON.heart, iconCx, iconCy, {
    depth: PIXEL_UI_DEPTH.overlay,
    parent,
  });

  const innerBarX = panelX + PAD + ICON_SIZE + 6;
  const innerBarY = panelY + (PANEL_H - BAR_HEIGHT) / 2;

  const bar = createStatBar(scene, innerBarX, innerBarY, BAR_WIDTH, BAR_HEIGHT, {
    fill: PIXEL_UI.hpHigh,
    depth: PIXEL_UI_DEPTH.content,
    segment: 25,
    parent,
  });

  const label = scene.add
    .text(innerBarX + BAR_WIDTH / 2, innerBarY + BAR_HEIGHT / 2, '', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#f8fafc',
      stroke: '#02040a',
      strokeThickness: 3,
    })
    .setOrigin(0.5, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay);
  parent?.add(label);

  let pulseTween: Phaser.Tweens.Tween | undefined;
  let wasPulsing = false;

  function startPulse(): void {
    if (wasPulsing) return;
    wasPulsing = true;
    pulseTween?.stop();
    pulseTween = scene.tweens.add({
      targets: bar.fill,
      alpha: { from: 1, to: 0.5 },
      duration: 400,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });
  }

  function stopPulse(): void {
    if (!wasPulsing) return;
    wasPulsing = false;
    pulseTween?.stop();
    pulseTween = undefined;
    bar.fill.setAlpha(1);
  }

  function sync(world: GameWorld, playerEid: number): void {
    if (playerEid < 0) return;

    const current = world.stores.health.current[playerEid] ?? 0;
    const max = world.stores.health.max[playerEid] ?? 1;
    const pct = max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;

    bar.setPercent(pct);
    const color = pct > 0.5 ? PIXEL_UI.hpHigh : pct >= 0.25 ? PIXEL_UI.hpMid : PIXEL_UI.hpLow;
    bar.setColor(color);

    label.setText(`${Math.ceil(current)} / ${Math.ceil(max)}`);

    if (pct < LOW_HP_THRESHOLD) {
      startPulse();
    } else {
      stopPulse();
    }
  }

  function destroy(): void {
    pulseTween?.stop();
    panel.destroy();
    bar.destroy();
    label.destroy();
    icon.destroy();
  }

  return { sync, destroy };
}
