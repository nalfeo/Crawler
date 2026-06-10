import Phaser from 'phaser';
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

interface RenderEntry<TId extends string = string> {
  readonly option: ModalPickerOption<TId>;
  readonly row: Phaser.GameObjects.Rectangle;
  readonly label: Phaser.GameObjects.Text;
  readonly description: Phaser.GameObjects.Text;
}

const PANEL_WIDTH = 560;
const PANEL_HEIGHT = 420;
const PANEL_PADDING = 18;
const TITLE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Segoe UI, Arial, sans-serif',
  fontSize: '26px',
  color: '#f8fafc',
};
const SUBTITLE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Segoe UI, Arial, sans-serif',
  fontSize: '16px',
  color: '#cbd5e1',
  wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 },
};
const BODY_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Segoe UI, Arial, sans-serif',
  fontSize: '14px',
  color: '#94a3b8',
  wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 },
};
const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Segoe UI, Arial, sans-serif',
  fontSize: '18px',
  color: '#f8fafc',
};
const LABEL_DISABLED_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  ...LABEL_STYLE,
  color: '#64748b',
};
const DESCRIPTION_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Segoe UI, Arial, sans-serif',
  fontSize: '13px',
  color: '#94a3b8',
  wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 - 24 },
};

export function createModalPickerUI(scene: Phaser.Scene): {
  open<TId extends string>(config: ModalPickerConfig<TId>, hooks?: ModalPickerOpenHooks<TId>): void;
  close(): void;
  isOpen(): boolean;
  destroy(): void;
} {
  const textResolution = Math.max(1, Math.round(window.devicePixelRatio || 1));
  const snap = (value: number): number => Math.round(value);
  const crispText = (
    x: number,
    y: number,
    text: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(snap(x), snap(y), text, style).setResolution(textResolution);

  const overlay = scene.add.container(0, 0).setDepth(5000).setVisible(false).setScrollFactor(0);
  const backdrop = scene.add
    .rectangle(0, 0, scene.scale.width, scene.scale.height, 0x020617, 0.72)
    .setOrigin(0, 0);
  const panel = scene.add.rectangle(0, 0, PANEL_WIDTH, PANEL_HEIGHT, 0x0f172a, 0.98);
  panel.setOrigin(0, 0);
  panel.setStrokeStyle(2, 0x334155, 1);
  overlay.add([backdrop, panel]);

  let state: ModalPickerState<string> | null = null;
  let hooks: ModalPickerOpenHooks<string> | undefined;
  const entries: RenderEntry<string>[] = [];
  const textNodes: Phaser.GameObjects.Text[] = [];
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
  };

  const layoutPanel = (): void => {
    backdrop.setSize(scene.scale.width, scene.scale.height);
    panel.setSize(PANEL_WIDTH, PANEL_HEIGHT);
    panel.x = Math.round((scene.scale.width - PANEL_WIDTH) / 2);
    panel.y = Math.round((scene.scale.height - PANEL_HEIGHT) / 2);
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

    layoutPanel();
    const panelX = panel.x;
    const panelY = panel.y;
    let cursorY = panelY + PANEL_PADDING;

    const title = crispText(panelX + PANEL_PADDING, cursorY, state.title, TITLE_STYLE);
    textNodes.push(title);
    overlay.add(title);
    cursorY += title.height + 6;

    if (state.subtitle) {
      const subtitle = crispText(panelX + PANEL_PADDING, cursorY, state.subtitle, SUBTITLE_STYLE);
      textNodes.push(subtitle);
      overlay.add(subtitle);
      cursorY += subtitle.height + 6;
    }

    if (state.body) {
      const body = crispText(panelX + PANEL_PADDING, cursorY, state.body, BODY_STYLE);
      textNodes.push(body);
      overlay.add(body);
      cursorY += body.height + 10;
    }

    const rowHeight = 54;
    for (let index = 0; index < state.options.length; index += 1) {
      const option = state.options[index]!;
      const isSelected = state.selectedIndex === index;
      const isDisabled = Boolean(option.disabled);
      const rowY = cursorY + index * (rowHeight + 8);
      const bgColor = isSelected ? 0x1d4ed8 : 0x1e293b;
      const bgAlpha = isDisabled ? 0.35 : isSelected ? 0.9 : 0.75;
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
      row.setStrokeStyle(isSelected ? 2 : 1, isSelected ? 0x93c5fd : 0x334155);
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
          rerender();
        }
      });

      const marker = isSelected ? '▶ ' : '  ';
      const label = crispText(
        panelX + PANEL_PADDING + 10,
        rowY + 8,
        `${marker}${option.label}`,
        isDisabled ? LABEL_DISABLED_STYLE : LABEL_STYLE,
      );
      const description = crispText(
        panelX + PANEL_PADDING + 26,
        rowY + 30,
        option.description ?? (isDisabled ? 'Unavailable' : ''),
        DESCRIPTION_STYLE,
      );
      description.setAlpha(isDisabled ? 0.5 : 0.8);

      entries.push({ option, row, label, description });
      overlay.add([row, label, description]);
    }

    const footerY = cursorY + state.options.length * (rowHeight + 8) + 4;
    const footer = crispText(
      panelX + PANEL_PADDING,
      footerY,
      state.allowCancel
        ? 'Up/Down: Navigate   Enter: Confirm   Esc: Cancel'
        : 'Up/Down: Navigate   Enter: Confirm',
      BODY_STYLE,
    );
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
