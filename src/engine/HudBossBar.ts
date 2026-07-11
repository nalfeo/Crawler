/**
 * HudBossBar — screen-space boss health bar for Floor 1 boss fights.
 *
 * Anchored top-center directly beneath the floor-timer panel so the two HUD
 * elements never overlap. It is parented into the same scaled `topCenter` HUD
 * group as the floor timer (see HudUI), so the vertical gap below the timer
 * holds at every UI scale. Hidden unless a boss battle is active.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { PIXEL_UI_DEPTH } from './pixel-ui.js';
import { resolveBossHealthBar } from './boss-health-bar-state.js';
import { applyCrispText } from './ui-scale.js';

const CENTER_X = GAME.WIDTH / 2;
const BAR_WIDTH = 360;
const BAR_HEIGHT = 20;

// `TOP_Y` is the "BOSS" label's top edge. The floor-timer panel occupies y
// 14..52 (top 14, height 38); the bar shell extends a few px above TOP_Y, so a
// value of 60 leaves a small clear gap beneath the timer at scale 1 — and the
// shared scaled group keeps that gap proportional at larger UI scales.
const TOP_Y = 60;
const BAR_CENTER_Y = TOP_Y + 10;
const NAME_Y = TOP_Y + 28;

export function createHudBossBar(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld): void;
  destroy(): void;
} {
  const parent = options.parent;

  const shell = scene.add
    .rectangle(CENTER_X, BAR_CENTER_Y, BAR_WIDTH + 4, BAR_HEIGHT + 4, 0x111827, 0.92)
    .setStrokeStyle(2, 0x4b5563)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.panel)
    .setVisible(false);
  parent?.add(shell);

  const fill = scene.add
    .rectangle(CENTER_X - BAR_WIDTH / 2, BAR_CENTER_Y, BAR_WIDTH, BAR_HEIGHT, 0xf97316)
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content)
    .setVisible(false);
  parent?.add(fill);

  const label = scene.add
    .text(CENTER_X, TOP_Y, 'BOSS', {
      fontFamily: 'monospace',
      fontSize: '12px',
      color: '#fde68a',
    })
    .setOrigin(0.5, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay)
    .setVisible(false);
  parent?.add(label);

  const nameText = scene.add
    .text(CENTER_X, NAME_Y, '', {
      fontFamily: 'monospace',
      fontSize: '13px',
      color: '#f8fafc',
      backgroundColor: '#0f172acc',
      padding: { x: 6, y: 3 },
    })
    .setOrigin(0.5, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay)
    .setVisible(false);
  parent?.add(nameText);
  const detachCrispText = applyCrispText(scene, [label, nameText]);

  function sync(world: GameWorld): void {
    const state = resolveBossHealthBar(
      world.floorScenario?.objective.bossBattles ??
        world.floorExtendedState?.familyState?.bossEncounters,
      world.ecs,
      world.stores.health,
    );
    const visible = state !== null;
    shell.setVisible(visible);
    fill.setVisible(visible);
    label.setVisible(visible);
    nameText.setVisible(visible);
    if (!state) {
      return;
    }

    fill.setSize(Math.max(1, Math.round(BAR_WIDTH * state.pct)), BAR_HEIGHT);
    fill.setFillStyle(state.fillColor);
    nameText.setText(`${state.displayName}  ${Math.ceil(state.current)} / ${Math.ceil(state.max)}`);
  }

  function destroy(): void {
    detachCrispText();
    shell.destroy();
    fill.destroy();
    label.destroy();
    nameText.destroy();
  }

  return { sync, destroy };
}
