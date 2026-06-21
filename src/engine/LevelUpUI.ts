/**
 * LevelUpUI — the level-up stat-allocation overlay.
 *
 * Shown by `MainGameScene` when `world.state === 'level_up'` and the player has
 * unspent points. The player distributes points across the gameplay stats with
 * per-row −/+ controls (or keyboard), previews the resulting value, and confirms
 * to spend them. Any points left unspent are banked toward the next level.
 *
 * All allocation/clamp/navigation rules live in the pure
 * `shared/level-up-allocation` module; this file only renders that state and
 * forwards transitions, mirroring how `ModalPickerUI` pairs with `modal-picker`.
 *
 * Engine layer only (Phaser allowed). No imports from game/labs.
 */
import Phaser from 'phaser';
import { PIXEL_UI } from './pixel-ui.js';
import { fitUiScale } from './ui-scale.js';
import { STAT_KEYS, STAT_POINT_INCREMENT, type StatKey } from '../shared/stats.js';
import { STAT_DISPLAY, formatStatValue, formatStatIncrement } from '../shared/stat-display.js';
import {
  cancel,
  confirm,
  createLevelUpAllocationState,
  decrementStat,
  incrementStat,
  moveSelection,
  remainingPoints,
  resetDraft,
  selectStat,
  selectedStat,
  toAllocations,
  type LevelUpAllocationState,
} from '../shared/level-up-allocation.js';

export interface LevelUpUIParams {
  /** Player level being celebrated (for the title). */
  readonly level: number;
  /** Unspent points available to allocate this opening. */
  readonly available: number;
  /** Current gameplay stat values, keyed by StatKey. */
  readonly currentStats: Readonly<Record<StatKey, number>>;
}

export interface LevelUpUIHooks {
  /** Called once when the player confirms; receives the points to spend. */
  readonly onConfirm: (allocations: Partial<Record<StatKey, number>>) => void;
}

export interface LevelUpUI {
  open(params: LevelUpUIParams): void;
  /**
   * Programmatically apply `allocations` and confirm the screen, driving the
   * real allocation state machine (the same transitions a clicking player would
   * trigger) before firing `onConfirm`. Used by AI playthroughs so the in-browser
   * AI exercises the actual level-up UX instead of bypassing it. No-op unless the
   * screen is currently open.
   */
  autoResolve(allocations: Partial<Record<StatKey, number>>): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
}

const PANEL_WIDTH = 560;
const PANEL_PADDING = 18;
const ROW_HEIGHT = 38;
const ROW_GAP = 4;
const HEADER_HEIGHT = 70;
const FOOTER_HEIGHT = 64;
const PANEL_HEIGHT =
  HEADER_HEIGHT + STAT_KEYS.length * (ROW_HEIGHT + ROW_GAP) + FOOTER_HEIGHT + PANEL_PADDING;

const TITLE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '22px',
  fontStyle: 'bold',
  color: '#fcd34d',
};
const POINTS_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '15px',
  color: '#cbd5e1',
};
const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '15px',
  fontStyle: 'bold',
  color: '#f8fafc',
};
const VALUE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '13px',
  color: '#94a3b8',
};
const PREVIEW_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '13px',
  color: '#46d369',
};
const BUTTON_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '18px',
  fontStyle: 'bold',
  color: '#f8fafc',
};
const BUTTON_DISABLED_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  ...BUTTON_STYLE,
  color: '#475569',
};
const DESCRIPTION_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '12px',
  color: '#94a3b8',
  wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 },
};
const FOOTER_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '12px',
  color: '#94a3b8',
};

export function createLevelUpUI(scene: Phaser.Scene, hooks: LevelUpUIHooks): LevelUpUI {
  // Responsive UI: on small screens the FIT-scaled canvas shrinks this overlay
  // until the text and −/+ buttons are unreadable/untappable. We lay the panel
  // out in a "virtual" viewport (real size ÷ uiScale) and scale the whole
  // overlay container back up by uiScale, so the panel stays centred while its
  // text and controls grow with the device. Text resolution is bumped by the
  // same factor to keep the upscaled glyphs crisp.
  let uiScale = fitUiScale(scene, PANEL_WIDTH, PANEL_HEIGHT);
  const baseResolution = Math.max(1, Math.round(window.devicePixelRatio || 1));
  let textResolution = Math.max(1, Math.round(baseResolution * uiScale));
  const snap = (value: number): number => Math.round(value);
  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(snap(x), snap(y), text, style).setResolution(textResolution);

  /** Virtual viewport width the panel is centred within (real width ÷ uiScale). */
  const viewWidth = (): number => scene.scale.width / uiScale;
  /** Virtual viewport height the panel is centred within (real height ÷ uiScale). */
  const viewHeight = (): number => scene.scale.height / uiScale;

  const overlay = scene.add.container(0, 0).setDepth(5000).setVisible(false).setScrollFactor(0);
  const backdrop = scene.add
    .rectangle(0, 0, viewWidth(), viewHeight(), 0x020617, 0.78)
    .setOrigin(0, 0);
  const panel = scene.add.rectangle(0, 0, PANEL_WIDTH, PANEL_HEIGHT, PIXEL_UI.panelFill, 0.98);
  panel.setOrigin(0, 0);
  panel.setStrokeStyle(2, PIXEL_UI.border, 1);
  const titleStrip = scene.add
    .rectangle(0, 0, PANEL_WIDTH - 4, 38, PIXEL_UI.trackFill, 1)
    .setOrigin(0, 0);
  const titleRule = scene.add.rectangle(0, 0, PANEL_WIDTH - 4, 2, PIXEL_UI.gold, 1).setOrigin(0, 0);
  overlay.add([backdrop, panel, titleStrip, titleRule]);

  let state: LevelUpAllocationState | null = null;
  let params: LevelUpUIParams | null = null;
  let dynamicNodes: Phaser.GameObjects.GameObject[] = [];
  let keyListener: ((event: KeyboardEvent) => void) | undefined;

  const clearDynamic = (): void => {
    for (const node of dynamicNodes) {
      node.destroy();
    }
    dynamicNodes = [];
  };

  const previewValue = (stat: StatKey, draftPoints: number): number =>
    (params?.currentStats[stat] ?? 0) + draftPoints * STAT_POINT_INCREMENT[stat];

  const layoutPanel = (): void => {
    backdrop.setSize(viewWidth(), viewHeight());
    panel.x = Math.round((viewWidth() - PANEL_WIDTH) / 2);
    panel.y = Math.round((viewHeight() - PANEL_HEIGHT) / 2);
    titleStrip.setPosition(panel.x + 2, panel.y + 2);
    titleRule.setPosition(panel.x + 2, panel.y + 40);
  };

  const dispatch = (next: LevelUpAllocationState): void => {
    if (next === state) {
      return;
    }
    state = next;
    if (state.status === 'confirmed') {
      const allocations = toAllocations(state);
      close();
      hooks.onConfirm(allocations);
      return;
    }
    if (state.status === 'cancelled') {
      close();
      hooks.onConfirm({});
      return;
    }
    rerender();
  };

  const addButton = (
    x: number,
    y: number,
    label: string,
    enabled: boolean,
    onClick: () => void,
  ): void => {
    const size = ROW_HEIGHT - 12;
    const box = scene.add
      .rectangle(x, y, size, size, enabled ? 0x1d4ed8 : PIXEL_UI.panelFill, enabled ? 0.9 : 0.5)
      .setOrigin(0, 0)
      .setStrokeStyle(1, enabled ? PIXEL_UI.gold : PIXEL_UI.bevelDark);
    if (enabled) {
      box.setInteractive({ useHandCursor: true });
      box.on('pointerdown', onClick);
    }
    const text = crispText(
      x + size / 2,
      y + size / 2,
      label,
      enabled ? BUTTON_STYLE : BUTTON_DISABLED_STYLE,
    ).setOrigin(0.5, 0.5);
    dynamicNodes.push(box, text);
    overlay.add([box, text]);
  };

  const rerender = (): void => {
    clearDynamic();
    if (!state || !params) {
      overlay.setVisible(false);
      return;
    }
    // Refresh responsive scale before laying out (handles resize/rotation).
    uiScale = fitUiScale(scene, PANEL_WIDTH, PANEL_HEIGHT);
    textResolution = Math.max(1, Math.round(baseResolution * uiScale));
    overlay.setScale(uiScale);
    layoutPanel();
    const panelX = panel.x;
    const panelY = panel.y;
    const left = panelX + PANEL_PADDING;

    const title = crispText(left, panelY + 10, `Level Up!  —  Level ${params.level}`, TITLE_STYLE);
    const remaining = remainingPoints(state);
    const points = crispText(
      left,
      panelY + HEADER_HEIGHT - 24,
      `Points to spend: ${remaining} / ${state.available}`,
      POINTS_STYLE,
    );
    dynamicNodes.push(title, points);
    overlay.add([title, points]);

    const rowsTop = panelY + HEADER_HEIGHT;
    const active = selectedStat(state);
    for (let index = 0; index < STAT_KEYS.length; index += 1) {
      const stat = STAT_KEYS[index]!;
      const rowY = rowsTop + index * (ROW_HEIGHT + ROW_GAP);
      const isSelected = stat === active;
      const draftPoints = state.draft[stat];

      const row = scene.add
        .rectangle(
          left,
          rowY,
          PANEL_WIDTH - PANEL_PADDING * 2,
          ROW_HEIGHT,
          isSelected ? 0x1e293b : PIXEL_UI.panelFill,
          isSelected ? 0.95 : 0.6,
        )
        .setOrigin(0, 0)
        .setStrokeStyle(isSelected ? 2 : 1, isSelected ? PIXEL_UI.gold : PIXEL_UI.bevelDark);
      row.setInteractive({ useHandCursor: true });
      row.on('pointerdown', () => dispatch(selectStat(state!, stat)));
      dynamicNodes.push(row);
      overlay.add(row);

      const marker = isSelected ? '▶ ' : '  ';
      const label = crispText(
        left + 10,
        rowY + 4,
        `${marker}${STAT_DISPLAY[stat].label}`,
        LABEL_STYLE,
      );
      const value = crispText(
        left + 10,
        rowY + 21,
        `${formatStatValue(stat, params.currentStats[stat] ?? 0)}  (${formatStatIncrement(stat)}/pt)`,
        VALUE_STYLE,
      );
      dynamicNodes.push(label, value);
      overlay.add([label, value]);

      if (draftPoints > 0) {
        const preview = crispText(
          left + 220,
          rowY + 12,
          `→ ${formatStatValue(stat, previewValue(stat, draftPoints))}  (+${draftPoints})`,
          PREVIEW_STYLE,
        );
        dynamicNodes.push(preview);
        overlay.add(preview);
      }

      const rowRight = left + (PANEL_WIDTH - PANEL_PADDING * 2);
      const plusX = rowRight - (ROW_HEIGHT - 12) - 8;
      const countX = plusX - 34;
      const minusX = countX - (ROW_HEIGHT - 12) - 6;
      const btnY = rowY + 6;

      addButton(minusX, btnY, '−', draftPoints > 0, () => dispatch(decrementStat(state!, stat)));
      const count = crispText(
        countX,
        rowY + ROW_HEIGHT / 2,
        String(draftPoints),
        LABEL_STYLE,
      ).setOrigin(0.5, 0.5);
      dynamicNodes.push(count);
      overlay.add(count);
      addButton(plusX, btnY, '+', remaining > 0, () => dispatch(incrementStat(state!, stat)));
    }

    const footerTop = rowsTop + STAT_KEYS.length * (ROW_HEIGHT + ROW_GAP) + 4;
    const desc = crispText(left, footerTop, STAT_DISPLAY[active].description, DESCRIPTION_STYLE);
    dynamicNodes.push(desc);
    overlay.add(desc);

    // Confirm button (bottom-right) and Reset button (bottom-left).
    const confirmW = 150;
    const confirmH = 30;
    const confirmX = left + (PANEL_WIDTH - PANEL_PADDING * 2) - confirmW;
    const confirmY = panelY + PANEL_HEIGHT - PANEL_PADDING - confirmH;
    const confirmBox = scene.add
      .rectangle(confirmX, confirmY, confirmW, confirmH, 0x16a34a, 0.95)
      .setOrigin(0, 0)
      .setStrokeStyle(2, PIXEL_UI.gold)
      .setInteractive({ useHandCursor: true });
    confirmBox.on('pointerdown', () => dispatch(confirm(state!)));
    const confirmLabel = crispText(
      confirmX + confirmW / 2,
      confirmY + confirmH / 2,
      remaining > 0 ? `Confirm (bank ${remaining})` : 'Confirm',
      LABEL_STYLE,
    ).setOrigin(0.5, 0.5);
    dynamicNodes.push(confirmBox, confirmLabel);
    overlay.add([confirmBox, confirmLabel]);

    const resetEnabled = state.available - remaining > 0;
    const resetBox = scene.add
      .rectangle(left, confirmY, 90, confirmH, PIXEL_UI.panelFill, resetEnabled ? 0.9 : 0.5)
      .setOrigin(0, 0)
      .setStrokeStyle(1, resetEnabled ? PIXEL_UI.gold : PIXEL_UI.bevelDark);
    if (resetEnabled) {
      resetBox.setInteractive({ useHandCursor: true });
      resetBox.on('pointerdown', () => dispatch(resetDraft(state!)));
    }
    const resetLabel = crispText(
      left + 45,
      confirmY + confirmH / 2,
      'Reset',
      resetEnabled ? VALUE_STYLE : BUTTON_DISABLED_STYLE,
    ).setOrigin(0.5, 0.5);
    dynamicNodes.push(resetBox, resetLabel);
    overlay.add([resetBox, resetLabel]);

    const hint = crispText(
      left,
      confirmY - 18,
      '↑/↓ Select · ←/→ Adjust · Enter Confirm',
      FOOTER_STYLE,
    );
    dynamicNodes.push(hint);
    overlay.add(hint);

    overlay.setVisible(true);
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!state || state.status !== 'open') {
      return;
    }
    switch (event.code) {
      case 'ArrowUp':
      case 'KeyW':
        event.preventDefault();
        dispatch(moveSelection(state, -1));
        break;
      case 'ArrowDown':
      case 'KeyS':
        event.preventDefault();
        dispatch(moveSelection(state, 1));
        break;
      case 'ArrowRight':
      case 'KeyD':
      case 'Equal':
      case 'NumpadAdd':
        event.preventDefault();
        dispatch(incrementStat(state, selectedStat(state)));
        break;
      case 'ArrowLeft':
      case 'KeyA':
      case 'Minus':
      case 'NumpadSubtract':
        event.preventDefault();
        dispatch(decrementStat(state, selectedStat(state)));
        break;
      case 'Enter':
      case 'Space':
        event.preventDefault();
        dispatch(confirm(state));
        break;
      case 'Escape':
        event.preventDefault();
        dispatch(cancel(state));
        break;
      default:
        break;
    }
  };

  keyListener = onKeyDown;
  scene.input.keyboard?.on('keydown', keyListener);

  const resizeHandler = (): void => {
    rerender();
  };
  scene.scale.on(Phaser.Scale.Events.RESIZE, resizeHandler);

  function close(): void {
    state = null;
    params = null;
    clearDynamic();
    overlay.setVisible(false);
  }

  return {
    open(nextParams: LevelUpUIParams): void {
      params = nextParams;
      state = createLevelUpAllocationState(nextParams.available);
      rerender();
    },
    autoResolve(allocations: Partial<Record<StatKey, number>>): void {
      if (!state || state.status !== 'open') {
        return;
      }
      // Drive the real reducers point-by-point so the same clamp/selection rules
      // a human's clicks go through are exercised, then confirm (which closes the
      // overlay and fires onConfirm with the resulting draft).
      for (const stat of STAT_KEYS) {
        const points = allocations[stat] ?? 0;
        for (let i = 0; i < points; i += 1) {
          dispatch(incrementStat(state, stat));
        }
      }
      if (state && state.status === 'open') {
        dispatch(confirm(state));
      }
    },
    close,
    isOpen(): boolean {
      return state !== null && state.status === 'open';
    },
    destroy(): void {
      if (keyListener) {
        scene.input.keyboard?.off('keydown', keyListener);
        keyListener = undefined;
      }
      scene.scale.off(Phaser.Scale.Events.RESIZE, resizeHandler);
      close();
      overlay.destroy(true);
    },
  };
}
