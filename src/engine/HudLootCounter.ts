/**
 * HudLootCounter — fixed-position gold + junk loot readout.
 *
 * A compact beveled pixel-UI pill in the bottom-left stat column (above the XP
 * bar) that graduates the gold/junk loot totals out of the debug objective text
 * into a real HUD widget. Shows a coin icon + gold count and a scrap icon + junk
 * count, with a short scale pulse on the icon whenever a total increases.
 *
 * Gold reads from `world.playerGold` (persistent); junk reads from the active
 * floor-1 objective (`world.floorScenario.objective.junkCollected`), defaulting to 0
 * when no floor is loaded. Public `sync`/`destroy` mirror the other HUD widgets.
 *
 * Engine layer only (Phaser allowed). No imports from game/labs.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { PIXEL_UI_DEPTH, PIXEL_ICON, createBeveledPanel, addPixelIcon } from './pixel-ui.js';
import { applyCrispText } from './ui-scale.js';
import { formatCompactLootValue } from './hud-loot-format.js';

const PAD = 7;
const ICON_SIZE = 16;
const GAP_ICON_TEXT = 5;
/** Reserved width for a compact value string (up to 4 glyphs at 12px monospace). */
const VALUE_W = 38;
/** Gap between the gold pair and the junk pair. */
const PAIR_GAP = 12;

const PANEL_W =
  PAD + ICON_SIZE + GAP_ICON_TEXT + VALUE_W + PAIR_GAP + ICON_SIZE + GAP_ICON_TEXT + VALUE_W + PAD;
const PANEL_H = PAD + ICON_SIZE + PAD;

const PANEL_X = 16;
/** Sits just above the XP bar panel (which starts ~GAME.HEIGHT - 91). */
const PANEL_Y = GAME.HEIGHT - 124;

export function createHudLootCounter(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld): void;
  destroy(): void;
} {
  const parent = options.parent;
  const panel = createBeveledPanel(scene, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, { parent });
  const panelBounds = scene.add
    .zone(PANEL_X, PANEL_Y, PANEL_W, PANEL_H)
    .setOrigin(0, 0)
    .setName('hud-loot-panel-bounds');
  parent?.add(panelBounds);

  const cy = PANEL_Y + PANEL_H / 2;

  const goldIconCx = PANEL_X + PAD + ICON_SIZE / 2;
  const goldIcon = addPixelIcon(scene, PIXEL_ICON.coin, goldIconCx, cy, {
    depth: PIXEL_UI_DEPTH.overlay,
    parent,
  }).setName('hud-loot-gold-icon');
  const goldTextX = PANEL_X + PAD + ICON_SIZE + GAP_ICON_TEXT;
  const goldValueBounds = scene.add
    .zone(goldTextX, PANEL_Y, VALUE_W, PANEL_H)
    .setOrigin(0, 0)
    .setName('hud-loot-gold-value-bounds');
  const goldText = scene.add
    .text(goldTextX, cy, '0', {
      fontFamily: 'monospace',
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#ffe082',
      stroke: '#02040a',
      strokeThickness: 3,
    })
    .setName('hud-loot-gold-text')
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay);

  const junkIconCx = goldTextX + VALUE_W + PAIR_GAP + ICON_SIZE / 2;
  const junkIcon = addPixelIcon(scene, PIXEL_ICON.junk, junkIconCx, cy, {
    depth: PIXEL_UI_DEPTH.overlay,
    parent,
  }).setName('hud-loot-junk-icon');
  const junkTextX = junkIconCx + ICON_SIZE / 2 + GAP_ICON_TEXT;
  const junkValueBounds = scene.add
    .zone(junkTextX, PANEL_Y, VALUE_W, PANEL_H)
    .setOrigin(0, 0)
    .setName('hud-loot-junk-value-bounds');
  const junkText = scene.add
    .text(junkTextX, cy, '0', {
      fontFamily: 'monospace',
      fontSize: '12px',
      fontStyle: 'bold',
      color: '#cbd5e1',
      stroke: '#02040a',
      strokeThickness: 3,
    })
    .setName('hud-loot-junk-text')
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay);
  parent?.add([goldValueBounds, goldText, junkValueBounds, junkText]);
  const detachCrispText = applyCrispText(scene, [goldText, junkText]);

  let lastGold = -1;
  let lastJunk = -1;

  function pulse(icon: Phaser.GameObjects.Image): void {
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

  function sync(world: GameWorld): void {
    const gold = Math.max(0, Math.floor(world.playerGold));
    const junk = Math.max(0, Math.floor(world.floorScenario?.objective.junkCollected ?? 0));

    if (gold !== lastGold) {
      goldText.setText(formatCompactLootValue(gold));
      if (lastGold >= 0 && gold > lastGold) pulse(goldIcon);
      lastGold = gold;
    }
    if (junk !== lastJunk) {
      junkText.setText(formatCompactLootValue(junk));
      if (lastJunk >= 0 && junk > lastJunk) pulse(junkIcon);
      lastJunk = junk;
    }
  }

  function destroy(): void {
    detachCrispText();
    scene.tweens.killTweensOf(goldIcon);
    scene.tweens.killTweensOf(junkIcon);
    panel.destroy();
    panelBounds.destroy();
    goldIcon.destroy();
    goldValueBounds.destroy();
    goldText.destroy();
    junkIcon.destroy();
    junkValueBounds.destroy();
    junkText.destroy();
  }

  return { sync, destroy };
}
