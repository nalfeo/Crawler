import Phaser from 'phaser';
import { PIXEL_UI } from './pixel-ui.js';
import { getSafeAreaInsets } from './safe-area.js';
import { fitUiScale, type ScreenBounds } from './ui-scale.js';
import { getRenderScale } from './render-scale.js';
import { GAME } from '../shared/constants.js';
import {
  cancelModalPickerSelection,
  confirmModalPickerSelection,
  createModalPickerState,
  getModalPickerSelectedOption,
  moveModalPickerSelection,
  setModalPickerSelectedId,
  type ModalPickerConfig,
  type ModalPickerOption,
  type ModalPickerState,
} from '../shared/modal-picker.js';

type InputSource = 'keyboard' | 'pointer';

export interface ModalPickerConfirmEvent<TId extends string = string> {
  readonly option: ModalPickerOption<TId>;
  readonly optionIndex: number;
  readonly source: InputSource;
}

export interface ModalPickerCancelEvent {
  readonly source: InputSource;
}

export interface ModalPickerSelectionChangeEvent<TId extends string = string> {
  readonly option: ModalPickerOption<TId>;
  readonly optionIndex: number;
}

export interface ModalPickerOpenHooks<TId extends string = string> {
  readonly onConfirm?: (event: ModalPickerConfirmEvent<TId>) => void;
  readonly onCancel?: (event: ModalPickerCancelEvent) => void;
  readonly onSelectionChange?: (event: ModalPickerSelectionChangeEvent<TId>) => void;
}

export interface ModalPickerLayoutSnapshot {
  readonly panel: ScreenBounds;
  readonly title: ScreenBounds;
  readonly subtitle: ScreenBounds | null;
  readonly body: ScreenBounds | null;
  readonly rows: ReadonlyArray<{
    readonly row: ScreenBounds;
    readonly label: ScreenBounds;
    readonly description: ScreenBounds;
  }>;
  readonly footer: ScreenBounds;
}

interface RenderEntry<TId extends string = string> {
  readonly option: ModalPickerOption<TId>;
  readonly row: Phaser.GameObjects.Rectangle;
  readonly label: Phaser.GameObjects.Text;
  readonly description: Phaser.GameObjects.Text;
}

const PANEL_WIDTH = 500;
const PANEL_HEIGHT = 400;
const PANEL_PADDING = 18;
/** Minimum gap between the panel and the canvas edge, before safe-area insets. */
const PANEL_SCREEN_MARGIN = 16;
const TITLE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '22px',
  fontStyle: 'bold',
  color: '#fcd34d',
};
const SUBTITLE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '15px',
  color: '#cbd5e1',
  wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 },
};
const BODY_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '14px',
  color: '#cbd5e1',
  lineSpacing: 4,
  wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 },
};
const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '17px',
  fontStyle: 'bold',
  color: '#f8fafc',
};
const LABEL_DISABLED_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  ...LABEL_STYLE,
  color: '#64748b',
};
const DESCRIPTION_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '13px',
  color: '#cbd5e1',
  wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 - 24 },
};
const FOOTER_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'monospace',
  fontSize: '13px',
  color: '#cbd5e1',
  wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 },
};
const MIN_ROW_HEIGHT = 52;
const ROW_GAP = 8;
const LABEL_TOP = 8;
const DESCRIPTION_TOP = 30;
const ROW_TEXT_BOTTOM_PADDING = 8;

export function createModalPickerUI(scene: Phaser.Scene): {
  open<TId extends string>(config: ModalPickerConfig<TId>, hooks?: ModalPickerOpenHooks<TId>): void;
  close(): void;
  isOpen(): boolean;
  getLayoutSnapshot(): ModalPickerLayoutSnapshot | null;
  destroy(): void;
} {
  // Responsive UI: lay the panel out in a "virtual" viewport (real size ÷
  // uiScale) and scale the whole overlay container back up by uiScale, so the
  // menu stays centred while its text and rows grow on small screens. Text
  // resolution is bumped by the same factor to keep upscaled glyphs crisp.
  const textResolution = getRenderScale(scene);
  /**
   * Panel margin that also clears the display cutout / home-indicator bands.
   * `fitUiScale` takes a single symmetric margin, so the largest inset is used
   * on every side — conservative, and zero-cost on devices with no cutout.
   */
  const safeMargin = (): number => {
    const safe = getSafeAreaInsets(scene);
    return PANEL_SCREEN_MARGIN + Math.max(safe.top, safe.right, safe.bottom, safe.left);
  };
  let uiScale = fitUiScale(scene, PANEL_WIDTH, PANEL_HEIGHT, safeMargin());
  let effectiveResolution = Math.max(1, Math.round(textResolution * uiScale));
  const viewWidth = (): number => GAME.WIDTH / uiScale;
  const viewHeight = (): number => GAME.HEIGHT / uiScale;

  const snap = (value: number): number => Math.round(value);
  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(snap(x), snap(y), text, style).setResolution(effectiveResolution);

  const overlay = scene.add.container(0, 0).setDepth(5000).setVisible(false).setScrollFactor(0);
  const backdrop = scene.add
    .rectangle(0, 0, viewWidth(), viewHeight(), 0x020617, 0.78)
    .setOrigin(0, 0);
  const panel = scene.add.rectangle(0, 0, PANEL_WIDTH, PANEL_HEIGHT, PIXEL_UI.panelFill, 0.98);
  panel.setOrigin(0, 0);
  panel.setStrokeStyle(2, PIXEL_UI.border, 1);
  const bevelTop = scene.add
    .rectangle(0, 0, PANEL_WIDTH, 2, PIXEL_UI.bevelLight, 1)
    .setOrigin(0, 0);
  const bevelLeft = scene.add
    .rectangle(0, 0, 2, PANEL_HEIGHT, PIXEL_UI.bevelLight, 1)
    .setOrigin(0, 0);
  const bevelBottom = scene.add
    .rectangle(0, 0, PANEL_WIDTH, 2, PIXEL_UI.bevelDark, 1)
    .setOrigin(0, 0);
  const bevelRight = scene.add
    .rectangle(0, 0, 2, PANEL_HEIGHT, PIXEL_UI.bevelDark, 1)
    .setOrigin(0, 0);
  const titleStrip = scene.add
    .rectangle(0, 0, PANEL_WIDTH - 4, 38, PIXEL_UI.trackFill, 1)
    .setOrigin(0, 0);
  const titleRule = scene.add.rectangle(0, 0, PANEL_WIDTH - 4, 2, PIXEL_UI.gold, 1).setOrigin(0, 0);
  overlay.add([
    backdrop,
    panel,
    bevelTop,
    bevelLeft,
    bevelBottom,
    bevelRight,
    titleStrip,
    titleRule,
  ]);

  let state: ModalPickerState<string> | null = null;
  let hooks: ModalPickerOpenHooks<string> | undefined;
  const entries: RenderEntry<string>[] = [];
  const textNodes: Phaser.GameObjects.Text[] = [];
  let titleNode: Phaser.GameObjects.Text | undefined;
  let subtitleNode: Phaser.GameObjects.Text | undefined;
  let bodyNode: Phaser.GameObjects.Text | undefined;
  let footerNode: Phaser.GameObjects.Text | undefined;
  let keyListener: ((event: KeyboardEvent) => void) | undefined;

  const clearEntries = (): void => {
    for (const entry of entries) {
      entry.row.destroy();
      entry.label.destroy();
      entry.description.destroy();
    }
    entries.length = 0;
  };

  const clearTextNodes = (): void => {
    for (const node of textNodes) {
      node.destroy();
    }
    textNodes.length = 0;
    titleNode = undefined;
    subtitleNode = undefined;
    bodyNode = undefined;
    footerNode = undefined;
  };

  const screenBounds = (
    object: Phaser.GameObjects.Components.Transform & { width: number; height: number },
  ): ScreenBounds => ({
    x: object.x * uiScale,
    y: object.y * uiScale,
    width: object.width * uiScale,
    height: object.height * uiScale,
  });

  const layoutPanel = (): void => {
    backdrop.setSize(viewWidth(), viewHeight());
    panel.setSize(PANEL_WIDTH, PANEL_HEIGHT);
    // Centre inside the safe rect rather than the raw canvas. The overlay is
    // laid out in virtual space (design ÷ uiScale), so the design-space insets
    // are converted to the same space before use.
    const safe = getSafeAreaInsets(scene);
    const inset = {
      top: safe.top / uiScale,
      right: safe.right / uiScale,
      bottom: safe.bottom / uiScale,
      left: safe.left / uiScale,
    };
    const safeWidth = viewWidth() - inset.left - inset.right;
    const safeHeight = viewHeight() - inset.top - inset.bottom;
    panel.x = Math.round(Math.max(inset.left, inset.left + (safeWidth - PANEL_WIDTH) / 2));
    panel.y = Math.round(Math.max(inset.top, inset.top + (safeHeight - PANEL_HEIGHT) / 2));
    bevelTop.setPosition(panel.x, panel.y).setSize(PANEL_WIDTH, 2);
    bevelLeft.setPosition(panel.x, panel.y).setSize(2, PANEL_HEIGHT);
    bevelBottom.setPosition(panel.x, panel.y + PANEL_HEIGHT - 2).setSize(PANEL_WIDTH, 2);
    bevelRight.setPosition(panel.x + PANEL_WIDTH - 2, panel.y).setSize(2, PANEL_HEIGHT);
    titleStrip.setPosition(panel.x + 2, panel.y + 2).setSize(PANEL_WIDTH - 4, 38);
    titleRule.setPosition(panel.x + 2, panel.y + 40).setSize(PANEL_WIDTH - 4, 2);
  };

  const rerender = (): void => {
    if (!state) {
      overlay.setVisible(false);
      clearEntries();
      clearTextNodes();
      return;
    }

    clearEntries();
    clearTextNodes();

    // Refresh responsive scale before laying out (handles resize/rotation).
    uiScale = fitUiScale(scene, PANEL_WIDTH, PANEL_HEIGHT, safeMargin());
    effectiveResolution = Math.max(1, Math.round(textResolution * uiScale));
    overlay.setScale(uiScale);

    layoutPanel();
    const panelX = panel.x;
    const panelY = panel.y;
    let cursorY = panelY + PANEL_PADDING;

    const title = crispText(panelX + PANEL_PADDING, cursorY, state.title, TITLE_STYLE);
    titleNode = title;
    textNodes.push(title);
    overlay.add(title);
    cursorY += title.height + 6;

    if (state.subtitle) {
      const subtitle = crispText(panelX + PANEL_PADDING, cursorY, state.subtitle, SUBTITLE_STYLE);
      subtitleNode = subtitle;
      textNodes.push(subtitle);
      overlay.add(subtitle);
      cursorY += subtitle.height + 6;
    }

    if (state.body) {
      const body = crispText(panelX + PANEL_PADDING, cursorY, state.body, BODY_STYLE);
      bodyNode = body;
      textNodes.push(body);
      overlay.add(body);
      cursorY += body.height + 10;
    }

    for (let index = 0; index < state.options.length; index += 1) {
      const option = state.options[index]!;
      const isSelected = state.selectedIndex === index;
      const isDisabled = Boolean(option.disabled);
      const rowY = cursorY;
      const label = crispText(
        panelX + PANEL_PADDING + 10,
        rowY + LABEL_TOP,
        `${isSelected ? '▶ ' : '  '}${option.label}`,
        isDisabled ? LABEL_DISABLED_STYLE : LABEL_STYLE,
      );
      const description = crispText(
        panelX + PANEL_PADDING + 26,
        rowY + DESCRIPTION_TOP,
        option.description ?? (isDisabled ? 'Unavailable' : ''),
        DESCRIPTION_STYLE,
      );
      const textContentHeight = Math.max(
        LABEL_TOP + label.height,
        DESCRIPTION_TOP + description.height,
      );
      const rowHeight = Math.max(
        MIN_ROW_HEIGHT,
        Math.ceil(textContentHeight + ROW_TEXT_BOTTOM_PADDING),
      );
      const bgColor = isSelected ? 0x1d4ed8 : PIXEL_UI.panelFill;
      const bgAlpha = isDisabled ? 0.4 : isSelected ? 0.95 : 0.85;
      const row = scene.add
        .rectangle(
          panelX + PANEL_PADDING,
          rowY,
          PANEL_WIDTH - PANEL_PADDING * 2,
          rowHeight,
          bgColor,
          bgAlpha,
        )
        .setOrigin(0, 0);
      row.setStrokeStyle(isSelected ? 2 : 1, isSelected ? PIXEL_UI.gold : PIXEL_UI.bevelDark);
      row.setInteractive({ useHandCursor: !isDisabled });
      row.on('pointerdown', () => {
        if (!state || option.disabled) {
          return;
        }
        const next = setModalPickerSelectedId(state, option.id);
        if (next.selectedIndex !== state.selectedIndex) {
          state = next;
          const selectedOption = getModalPickerSelectedOption(state);
          if (selectedOption && state.selectedIndex !== null) {
            hooks?.onSelectionChange?.({
              option: selectedOption,
              optionIndex: state.selectedIndex,
            });
          }
        }
        const confirmed = confirmModalPickerSelection(next);
        if (confirmed.status === 'confirmed' && confirmed.selectedIndex !== null) {
          const selectedOption = confirmed.options[confirmed.selectedIndex];
          if (selectedOption) {
            hooks?.onConfirm?.({
              option: selectedOption,
              optionIndex: confirmed.selectedIndex,
              source: 'pointer',
            });
          }
          close();
          return;
        }
        rerender();
      });

      description.setAlpha(isDisabled ? 0.5 : 0.8);

      entries.push({ option, row, label, description });
      overlay.add([row, label, description]);
      cursorY += rowHeight + ROW_GAP;
    }

    const footerY = cursorY + 4;
    const footer = crispText(
      panelX + PANEL_PADDING,
      footerY,
      state.allowCancel
        ? 'Tap to select  ·  Up/Down: Navigate  ·  Enter: Confirm  ·  Esc: Cancel'
        : 'Tap to select  ·  Up/Down: Navigate  ·  Enter: Confirm',
      FOOTER_STYLE,
    );
    footerNode = footer;
    textNodes.push(footer);
    overlay.add(footer);

    overlay.setVisible(true);
  };

  const close = (): void => {
    state = null;
    hooks = undefined;
    rerender();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!state || state.status !== 'open') {
      return;
    }

    switch (event.code) {
      case 'ArrowUp':
      case 'KeyW': {
        event.preventDefault();
        const previous = state;
        state = moveModalPickerSelection(state, -1);
        if (state.selectedIndex !== previous.selectedIndex) {
          const selectedOption = getModalPickerSelectedOption(state);
          if (selectedOption && state.selectedIndex !== null) {
            hooks?.onSelectionChange?.({
              option: selectedOption,
              optionIndex: state.selectedIndex,
            });
          }
          rerender();
        }
        break;
      }
      case 'ArrowDown':
      case 'KeyS': {
        event.preventDefault();
        const previous = state;
        state = moveModalPickerSelection(state, 1);
        if (state.selectedIndex !== previous.selectedIndex) {
          const selectedOption = getModalPickerSelectedOption(state);
          if (selectedOption && state.selectedIndex !== null) {
            hooks?.onSelectionChange?.({
              option: selectedOption,
              optionIndex: state.selectedIndex,
            });
          }
          rerender();
        }
        break;
      }
      case 'Enter':
      case 'Space': {
        event.preventDefault();
        const next = confirmModalPickerSelection(state);
        if (next.status === 'confirmed' && next.selectedIndex !== null) {
          const option = next.options[next.selectedIndex];
          if (option) {
            hooks?.onConfirm?.({
              option,
              optionIndex: next.selectedIndex,
              source: 'keyboard',
            });
          }
          close();
        }
        break;
      }
      case 'Escape': {
        event.preventDefault();
        const next = cancelModalPickerSelection(state);
        if (next.status === 'cancelled') {
          hooks?.onCancel?.({ source: 'keyboard' });
          close();
        }
        break;
      }
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

  return {
    open<TId extends string>(
      config: ModalPickerConfig<TId>,
      nextHooks?: ModalPickerOpenHooks<TId>,
    ): void {
      state = createModalPickerState(config) as ModalPickerState<string>;
      hooks = nextHooks as ModalPickerOpenHooks<string> | undefined;
      rerender();
    },
    close,
    isOpen(): boolean {
      return state !== null && state.status === 'open';
    },
    getLayoutSnapshot(): ModalPickerLayoutSnapshot | null {
      if (!state || !titleNode || !footerNode) {
        return null;
      }
      return {
        panel: screenBounds(panel),
        title: screenBounds(titleNode),
        subtitle: subtitleNode ? screenBounds(subtitleNode) : null,
        body: bodyNode ? screenBounds(bodyNode) : null,
        rows: entries.map((entry) => ({
          row: screenBounds(entry.row),
          label: screenBounds(entry.label),
          description: screenBounds(entry.description),
        })),
        footer: screenBounds(footerNode),
      };
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
