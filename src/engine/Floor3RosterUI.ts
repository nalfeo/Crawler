/**
 * Floor3RosterUI — Floor-3 companion roster / detail overlay (game-design §15
 * surface 5).
 *
 * Blocking overlay listing every party Companion. The cursor selects one and
 * the detail column shows persona, affinity strengths/weaknesses, the
 * evolution track, and the five ability milestones with learned state.
 *
 * All content comes from the pure resolvers in `floor3-companion-detail-state`;
 * this module only draws them, so the overlay can never perturb the simulation.
 *
 * Engine layer only (Phaser allowed). No imports from game/labs.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { PIXEL_UI, PIXEL_UI_DEPTH, createBeveledPanel } from './pixel-ui.js';
import { applyCrispText } from './ui-scale.js';
import { BLUE_STEEL, MIN_TEXT_RESOLUTION, hex } from './ui-theme.js';
import {
  detailLines,
  MAX_DETAIL_LINES,
  resolveRosterEntries,
  wrapRosterIndex,
} from './floor3-companion-detail-state.js';

const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 404;
const PANEL_PAD = 14;
const LIST_WIDTH = 190;
const LIST_ROW_H = 26;
const MAX_LIST_ROWS = 6;
const DETAIL_LINE_H = 13;

const FONT_FAMILY = '"Press Start 2P", "Courier New", monospace';

export interface Floor3RosterState {
  readonly open: boolean;
  readonly cursor: number;
  readonly entries: readonly string[];
  readonly detailLines: readonly string[];
}

export function createFloor3RosterUI(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  open(world: GameWorld): void;
  close(): void;
  isOpen(): boolean;
  moveCursor(world: GameWorld, delta: number): void;
  sync(world: GameWorld): void;
  getState(): Floor3RosterState;
  destroy(): void;
} {
  const panelX = Math.round((GAME.WIDTH - PANEL_WIDTH) / 2);
  const panelY = Math.round((GAME.HEIGHT - PANEL_HEIGHT) / 2);
  const root = scene.add
    .container(panelX, panelY)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.overlay ?? PIXEL_UI_DEPTH.panel)
    .setVisible(false);
  options.parent?.add(root);

  createBeveledPanel(scene, 0, 0, PANEL_WIDTH, PANEL_HEIGHT, {
    parent: root,
    fill: BLUE_STEEL.panelBg,
    highlight: BLUE_STEEL.panelBorder,
    shadow: PIXEL_UI.bevelDark,
    border: PIXEL_UI.border,
    fillAlpha: 0.98,
  });

  const title = scene.add
    .text(PANEL_PAD, PANEL_PAD, 'COMPANION ROSTER', {
      fontFamily: FONT_FAMILY,
      fontSize: '11px',
      fontStyle: 'bold',
      color: hex(BLUE_STEEL.textPrimary),
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(0, 0);
  root.add(title);

  const hint = scene.add
    .text(PANEL_WIDTH - PANEL_PAD, PANEL_PAD + 2, 'W/S select   ESC close', {
      fontFamily: FONT_FAMILY,
      fontSize: '8px',
      color: hex(BLUE_STEEL.textSecondary),
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(1, 0);
  root.add(hint);

  const listTop = PANEL_PAD + 32;
  const listRows: {
    background: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
    swatch: Phaser.GameObjects.Rectangle;
  }[] = [];
  for (let i = 0; i < MAX_LIST_ROWS; i += 1) {
    const y = listTop + i * LIST_ROW_H;
    const background = scene.add
      .rectangle(PANEL_PAD, y, LIST_WIDTH, LIST_ROW_H - 2, 0x35476d)
      .setOrigin(0, 0)
      .setStrokeStyle(1, BLUE_STEEL.panelBorder);
    const swatch = scene.add
      .rectangle(PANEL_PAD + 5, y + 7, 10, 10, 0x64748b)
      .setOrigin(0, 0)
      .setStrokeStyle(1, PIXEL_UI.border);
    const label = scene.add
      .text(PANEL_PAD + 22, y + 5, '', {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: hex(BLUE_STEEL.textPrimary),
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 3, bottom: 3 },
      })
      .setOrigin(0, 0);
    root.add([background, swatch, label]);
    listRows.push({ background, label, swatch });
  }

  const detailTexts: Phaser.GameObjects.Text[] = [];
  for (let i = 0; i < MAX_DETAIL_LINES; i += 1) {
    const text = scene.add
      .text(PANEL_PAD + LIST_WIDTH + 18, listTop + i * DETAIL_LINE_H, '', {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: hex(BLUE_STEEL.textPrimary),
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 2, bottom: 2 },
      })
      .setOrigin(0, 0);
    root.add(text);
    detailTexts.push(text);
  }

  const detachCrispText = applyCrispText(
    scene,
    [title, hint, ...detailTexts, ...listRows.map((row) => row.label)],
    MIN_TEXT_RESOLUTION + 2,
  );

  let open = false;
  let cursor = 0;
  let entries: readonly string[] = [];
  let lines: readonly string[] = [];

  function sync(world: GameWorld): void {
    const details = resolveRosterEntries(world);
    cursor = details.length === 0 ? 0 : wrapRosterIndex(cursor, details.length);
    entries = details.map((detail) => `${detail.slot + 1} ${detail.displayName} L${detail.level}`);
    lines = detailLines(details[cursor]);

    for (let i = 0; i < MAX_LIST_ROWS; i += 1) {
      const row = listRows[i]!;
      const detail = details[i];
      const used = detail !== undefined;
      row.background.setVisible(used);
      row.swatch.setVisible(used);
      row.label.setVisible(used);
      if (detail === undefined) continue;
      row.background.setFillStyle(i === cursor ? BLUE_STEEL.sectionHeader : 0x35476d);
      row.swatch.setFillStyle(detail.affinityColor);
      row.label.setText(entries[i] ?? '');
      row.label.setColor(hex(detail.knockedOut ? 0xf87171 : BLUE_STEEL.textPrimary));
    }
    for (let i = 0; i < MAX_DETAIL_LINES; i += 1) {
      detailTexts[i]!.setText(lines[i] ?? '');
    }
  }

  return {
    open(world: GameWorld): void {
      open = true;
      cursor = 0;
      root.setVisible(true);
      sync(world);
    },
    close(): void {
      open = false;
      root.setVisible(false);
    },
    isOpen: () => open,
    moveCursor(world: GameWorld, delta: number): void {
      const count = resolveRosterEntries(world).length;
      if (count === 0) return;
      cursor = wrapRosterIndex(cursor + delta, count);
      sync(world);
    },
    sync(world: GameWorld): void {
      if (!open) return;
      sync(world);
    },
    getState: (): Floor3RosterState => ({ open, cursor, entries, detailLines: lines }),
    destroy(): void {
      detachCrispText();
      root.destroy(true);
    },
  };
}
