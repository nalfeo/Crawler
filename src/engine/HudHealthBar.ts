/**
 * HudHealthBar — fixed-position health bar rendered in the Phaser scene.
 *
 * Cohesive pixel-UI styling (see engine/pixel-ui): a raised beveled panel holds
 * a pixel heart icon, an inset segmented HP bar with a glossy shine, and a
 * centered HP readout. Colour transitions green → amber → red; a tween pulses
 * the fill at low HP. A second row below the HP bar carries an inline gold +
 * junk loot readout (folded in from the former standalone `HudLootCounter`
 * row to reclaim vertical HUD space). Public `sync`/`destroy` contract is
 * unchanged.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import {
  PIXEL_UI,
  PIXEL_UI_DEPTH,
  PIXEL_ICON,
  createBeveledPanel,
  createStatBar,
  addPixelIcon,
} from './pixel-ui.js';
import { applyCrispText } from './ui-scale.js';
import { formatCompactLootValue } from './hud-loot-format.js';
import { HUD_FONT_FAMILY } from './ui-theme.js';
import { VITALS_X, VITALS_PANEL_Y } from './HudVitalsLayout.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const PAD = 7;
const ICON_SIZE = 16;
const BAR_WIDTH = 200;
const BAR_HEIGHT = 18;

/** Inline gold/junk readout stacked below the HP bar within the same panel. */
const LOOT_GAP_ICON_TEXT = 5;
const LOOT_VALUE_W = 68;
const LOOT_VALUE_FONT_SIZE = '14px';
const LOOT_VALUE_STROKE_THICKNESS = 3;
const LOOT_ICON_SIZE = 14;
/** Gap between the HP row and the loot row, and between the gold/junk pair. */
const LOOT_ROW_GAP = 6;
const LOOT_PAIR_GAP = 16;
const LOOT_ROW_H = 22;
/**
 * The gold/junk pixel-icon glyphs render with more visual mass toward the
 * bottom of their 8x8 grid than a Phaser text baseline centers to, so the
 * value text reads a few px "high" relative to the icon at this font size.
 * Nudge the text down to align icon and digit visual centers.
 */
const LOOT_TEXT_Y_NUDGE = 3;

const PANEL_W = PAD + ICON_SIZE + 6 + BAR_WIDTH + PAD;
/** Must match `VITALS_ROW_HEIGHTS.health` in HudVitalsLayout.ts. */
const PANEL_H = PAD + BAR_HEIGHT + LOOT_ROW_GAP + LOOT_ROW_H + PAD;

const BAR_X = VITALS_X;
/** Panel top edge comes directly from the shared vitals stack. */
const BAR_Y = VITALS_PANEL_Y.health;

const LOW_HP_THRESHOLD = 0.25;

export interface HudHealthBarOptions {
  /** Horizontal position of left edge. Defaults to 16. */
  x?: number;
  /** Vertical position of panel top edge. Defaults to bottom-left corner. */
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
  const panelY = options.y ?? BAR_Y;
  const parent = options.parent;

  const panelX = barX;

  const panel = createBeveledPanel(scene, panelX, panelY, PANEL_W, PANEL_H, { parent });
  // Invisible measurement zone (same pattern as the loot/skill panels) so e2e
  // probes can read this row's real rendered bounds out of the live scene.
  const panelBounds = scene.add
    .zone(panelX, panelY, PANEL_W, PANEL_H)
    .setOrigin(0, 0)
    .setName('hud-health-panel-bounds');
  parent?.add(panelBounds);

  const hpRowCy = panelY + PAD + BAR_HEIGHT / 2;

  const iconCx = panelX + PAD + ICON_SIZE / 2;
  const icon = addPixelIcon(scene, PIXEL_ICON.heart, iconCx, hpRowCy, {
    depth: PIXEL_UI_DEPTH.overlay,
    parent,
  });

  const innerBarX = panelX + PAD + ICON_SIZE + 6;
  const innerBarY = hpRowCy - BAR_HEIGHT / 2;

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

  // -- Inline gold/junk loot readout, stacked below the HP bar row ----------
  const lootRowCy = panelY + PAD + BAR_HEIGHT + LOOT_ROW_GAP + LOOT_ROW_H / 2;
  const lootRowY = panelY + PAD + BAR_HEIGHT + LOOT_ROW_GAP;
  const goldIconCx = iconCx;
  const goldIcon = addPixelIcon(scene, PIXEL_ICON.coin, goldIconCx, lootRowCy, {
    depth: PIXEL_UI_DEPTH.overlay,
    parent,
    scale: LOOT_ICON_SIZE / 16,
  }).setName('hud-loot-gold-icon');
  const goldTextX = goldIconCx + LOOT_ICON_SIZE / 2 + LOOT_GAP_ICON_TEXT;
  const goldValueBounds = scene.add
    .zone(goldTextX, lootRowY, LOOT_VALUE_W, LOOT_ROW_H)
    .setOrigin(0, 0)
    .setName('hud-loot-gold-value-bounds');
  const goldText = scene.add
    .text(goldTextX, lootRowCy + LOOT_TEXT_Y_NUDGE, '0', {
      fontFamily: HUD_FONT_FAMILY,
      fontSize: LOOT_VALUE_FONT_SIZE,
      fontStyle: 'bold',
      color: '#ffd54a',
      stroke: '#02040a',
      strokeThickness: LOOT_VALUE_STROKE_THICKNESS,
    })
    .setName('hud-loot-gold-text')
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay);

  const junkIconCx = goldTextX + LOOT_VALUE_W + LOOT_PAIR_GAP + LOOT_ICON_SIZE / 2;
  const junkIcon = addPixelIcon(scene, PIXEL_ICON.junk, junkIconCx, lootRowCy, {
    depth: PIXEL_UI_DEPTH.overlay,
    parent,
    scale: LOOT_ICON_SIZE / 16,
  }).setName('hud-loot-junk-icon');
  const junkTextX = junkIconCx + LOOT_ICON_SIZE / 2 + LOOT_GAP_ICON_TEXT;
  const junkValueBounds = scene.add
    .zone(junkTextX, lootRowY, LOOT_VALUE_W, LOOT_ROW_H)
    .setOrigin(0, 0)
    .setName('hud-loot-junk-value-bounds');
  const junkText = scene.add
    .text(junkTextX, lootRowCy + LOOT_TEXT_Y_NUDGE, '0', {
      fontFamily: HUD_FONT_FAMILY,
      fontSize: LOOT_VALUE_FONT_SIZE,
      fontStyle: 'bold',
      color: '#f1f5f9',
      stroke: '#02040a',
      strokeThickness: LOOT_VALUE_STROKE_THICKNESS,
    })
    .setName('hud-loot-junk-text')
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay);
  parent?.add([goldValueBounds, goldText, junkValueBounds, junkText]);

  const detachCrispText = applyCrispText(scene, [label, goldText, junkText]);

  let lastGold = -1;
  let lastJunk = -1;

  function pulseLootIcon(icon: Phaser.GameObjects.Image): void {
    scene.tweens.killTweensOf(icon);
    icon.setScale(1);
    scene.tweens.add({
      targets: icon,
      scale: 1.4,
      duration: 110,
      yoyo: true,
      ease: 'Quad.easeOut',
    });
  }

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

    const gold = Math.max(0, Math.floor(world.playerGold));
    const junk = Math.max(0, Math.floor(world.floorScenario?.objective.junkCollected ?? 0));

    if (gold !== lastGold) {
      goldText.setText(formatCompactLootValue(gold));
      if (lastGold >= 0 && gold > lastGold) pulseLootIcon(goldIcon);
      lastGold = gold;
    }
    if (junk !== lastJunk) {
      junkText.setText(formatCompactLootValue(junk));
      if (lastJunk >= 0 && junk > lastJunk) pulseLootIcon(junkIcon);
      lastJunk = junk;
    }
  }

  function destroy(): void {
    detachCrispText();
    pulseTween?.stop();
    scene.tweens.killTweensOf(goldIcon);
    scene.tweens.killTweensOf(junkIcon);
    panel.destroy();
    panelBounds.destroy();
    bar.destroy();
    label.destroy();
    icon.destroy();
    goldIcon.destroy();
    goldValueBounds.destroy();
    goldText.destroy();
    junkIcon.destroy();
    junkValueBounds.destroy();
    junkText.destroy();
  }

  return { sync, destroy };
}
