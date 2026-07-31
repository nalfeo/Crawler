import Phaser from 'phaser';
import { GAME } from '../shared/constants.js';
import { getAbilityIconEntry } from './ability-icon.js';
import { BLUE_STEEL, MIN_TEXT_RESOLUTION, hex } from './ui-theme.js';
import { fitScaleForBox, fitUiScale, type ScreenBounds } from './ui-scale.js';
import { getRenderScale } from './render-scale.js';

export interface AbilityLoadoutEntry {
  readonly id: string;
  readonly name: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly category: string;
  readonly details: string;
  readonly equipped: boolean;
  readonly canToggle?: boolean;
}

export interface AbilityLoadoutToggleResult {
  readonly entries: readonly AbilityLoadoutEntry[];
  readonly feedback: string;
  readonly tone: 'success' | 'warning';
}

export interface AbilityLoadoutConfig {
  readonly entries: readonly AbilityLoadoutEntry[];
  readonly slotLimit: number;
  readonly onToggle: (abilityId: string) => AbilityLoadoutToggleResult;
  readonly onClose?: () => void;
}

const PANEL_WIDTH = 760;
const PANEL_HEIGHT = 544;
const PANEL_PADDING = 22;
const HEADER_HEIGHT = 126;
const FOOTER_HEIGHT = 64;
const ROW_HEIGHT = 102;
const ROW_GAP = 8;
const VISIBLE_ROWS = 3;
const DEPTH = 5000;

const COLORS = {
  ...BLUE_STEEL,
  backdrop: 0x060913,
  panelBg: 0x263553,
  panelInner: 0x172139,
  rowBg: 0x1e2a44,
  rowHover: 0x283b61,
  selected: 0x355180,
  equipped: 0x23846b,
  equippedDark: 0x154f45,
  warning: 0xf0ad4e,
  textMuted: 0x8092ae,
  combat: 0xc65353,
  defense: 0x4f83c2,
  utility: 0x8f68b5,
} as const;

function categoryColor(category: string): number {
  if (category === 'combat') return COLORS.combat;
  if (category === 'defense') return COLORS.defense;
  return COLORS.utility;
}

function countEquipped(entries: readonly AbilityLoadoutEntry[]): number {
  return entries.reduce((count, entry) => count + Number(entry.equipped), 0);
}

export function createAbilityLoadoutUI(scene: Phaser.Scene): {
  open(config: AbilityLoadoutConfig): void;
  close(): void;
  isOpen(): boolean;
  getPanelScreenBounds(): ScreenBounds;
  getListViewportScreenBounds(): ScreenBounds;
  getVisibleRowScreenBounds(): ScreenBounds[];
  getVisibleAbilityIds(): string[];
  getVisibleEntries(): readonly AbilityLoadoutEntry[];
  getFooterScreenBounds(): ScreenBounds;
  getSelectedAbilityId(): string | null;
  scrollRows(delta: number): boolean;
  destroy(): void;
} {
  scene.cameras.main.roundPixels = true;

  let uiScale = fitUiScale(scene, PANEL_WIDTH, PANEL_HEIGHT);
  let effectiveResolution = Math.max(
    MIN_TEXT_RESOLUTION,
    Math.round(getRenderScale(scene) * uiScale),
  );
  let panelX = 0;
  let panelY = 0;
  let visible = false;
  let config: AbilityLoadoutConfig | null = null;
  let entries: readonly AbilityLoadoutEntry[] = [];
  let selectedIndex = 0;
  let rememberedAbilityId: string | null = null;
  let scrollIndex = 0;
  let feedback = '';
  let feedbackTone: AbilityLoadoutToggleResult['tone'] = 'success';
  let rowBounds: ScreenBounds[] = [];

  const overlay = scene.add.container(0, 0).setDepth(DEPTH).setScrollFactor(0).setVisible(false);
  const persistent: Phaser.GameObjects.GameObject[] = [];
  const dynamic: Phaser.GameObjects.GameObject[] = [];

  const backdrop = scene.add.rectangle(0, 0, GAME.WIDTH, GAME.HEIGHT, COLORS.backdrop, 0.82);
  backdrop.setOrigin(0, 0);
  const panel = scene.add
    .rectangle(0, 0, PANEL_WIDTH, PANEL_HEIGHT, COLORS.panelBg, 0.99)
    .setOrigin(0, 0)
    .setStrokeStyle(2, COLORS.panelBorder);
  const topBevel = scene.add.rectangle(0, 0, PANEL_WIDTH, 2, COLORS.accent, 0.75).setOrigin(0, 0);
  const leftBevel = scene.add.rectangle(0, 0, 2, PANEL_HEIGHT, COLORS.accent, 0.55).setOrigin(0, 0);
  const bottomBevel = scene.add.rectangle(0, 0, PANEL_WIDTH, 2, 0x10182a, 1).setOrigin(0, 0);
  const rightBevel = scene.add.rectangle(0, 0, 2, PANEL_HEIGHT, 0x10182a, 1).setOrigin(0, 0);
  const headerBg = scene.add
    .rectangle(0, 0, PANEL_WIDTH - 4, HEADER_HEIGHT, COLORS.panelInner, 1)
    .setOrigin(0, 0);
  const headerRule = scene.add
    .rectangle(0, 0, PANEL_WIDTH - 4, 2, COLORS.accent, 0.9)
    .setOrigin(0, 0);
  const footerBg = scene.add
    .rectangle(0, 0, PANEL_WIDTH - 4, FOOTER_HEIGHT, COLORS.panelInner, 1)
    .setOrigin(0, 0);
  const footerRule = scene.add
    .rectangle(0, 0, PANEL_WIDTH - 4, 1, COLORS.panelBorder, 1)
    .setOrigin(0, 0);

  persistent.push(
    backdrop,
    panel,
    topBevel,
    leftBevel,
    bottomBevel,
    rightBevel,
    headerBg,
    headerRule,
    footerBg,
    footerRule,
  );
  overlay.add(persistent);

  const text = (
    x: number,
    y: number,
    value: string,
    style: Phaser.Types.GameObjects.Text.TextStyle,
  ): Phaser.GameObjects.Text =>
    scene.add.text(Math.round(x), Math.round(y), value, style).setResolution(effectiveResolution);

  const clearDynamic = (): void => {
    for (const object of dynamic) object.destroy();
    dynamic.length = 0;
    rowBounds = [];
  };

  const scaledBounds = (box: ScreenBounds): ScreenBounds => ({
    x: box.x * uiScale,
    y: box.y * uiScale,
    width: box.width * uiScale,
    height: box.height * uiScale,
  });

  const listViewportBounds = (): ScreenBounds => ({
    x: panelX + PANEL_PADDING,
    y: panelY + HEADER_HEIGHT + 10,
    width: PANEL_WIDTH - PANEL_PADDING * 2,
    height: VISIBLE_ROWS * ROW_HEIGHT + (VISIBLE_ROWS - 1) * ROW_GAP,
  });

  const footerBounds = (): ScreenBounds => ({
    x: panelX + 2,
    y: panelY + PANEL_HEIGHT - FOOTER_HEIGHT - 2,
    width: PANEL_WIDTH - 4,
    height: FOOTER_HEIGHT,
  });

  const clampSelectionIntoView = (): void => {
    if (selectedIndex < scrollIndex) scrollIndex = selectedIndex;
    if (selectedIndex >= scrollIndex + VISIBLE_ROWS) {
      scrollIndex = selectedIndex - VISIBLE_ROWS + 1;
    }
    scrollIndex = Phaser.Math.Clamp(scrollIndex, 0, Math.max(0, entries.length - VISIBLE_ROWS));
  };

  const applyToggle = (abilityId: string): void => {
    if (!config) return;
    const entry = entries.find((candidate) => candidate.id === abilityId);
    if (entry?.canToggle === false) {
      feedback = `${entry.name} is passive and always on when requirements are met.`;
      feedbackTone = 'warning';
      render();
      return;
    }
    const result = config.onToggle(abilityId);
    entries = result.entries;
    feedback = result.feedback;
    feedbackTone = result.tone;
    selectedIndex = Math.max(
      0,
      entries.findIndex((entry) => entry.id === abilityId),
    );
    clampSelectionIntoView();
    render();
  };

  const render = (): void => {
    clearDynamic();
    if (!visible || !config) return;

    uiScale = fitUiScale(scene, PANEL_WIDTH, PANEL_HEIGHT);
    effectiveResolution = Math.max(
      MIN_TEXT_RESOLUTION,
      Math.round(getRenderScale(scene) * uiScale),
    );
    overlay.setScale(uiScale);
    const viewWidth = GAME.WIDTH / uiScale;
    const viewHeight = GAME.HEIGHT / uiScale;
    panelX = Math.round((viewWidth - PANEL_WIDTH) / 2);
    panelY = Math.round((viewHeight - PANEL_HEIGHT) / 2);

    backdrop.setSize(viewWidth, viewHeight);
    panel.setPosition(panelX, panelY);
    topBevel.setPosition(panelX, panelY);
    leftBevel.setPosition(panelX, panelY);
    bottomBevel.setPosition(panelX, panelY + PANEL_HEIGHT - 2);
    rightBevel.setPosition(panelX + PANEL_WIDTH - 2, panelY);
    headerBg.setPosition(panelX + 2, panelY + 2);
    headerRule.setPosition(panelX + 2, panelY + HEADER_HEIGHT);
    footerBg.setPosition(panelX + 2, panelY + PANEL_HEIGHT - FOOTER_HEIGHT - 2);
    footerRule.setPosition(panelX + 2, panelY + PANEL_HEIGHT - FOOTER_HEIGHT - 2);

    const equippedCount = countEquipped(entries);
    const title = text(panelX + PANEL_PADDING, panelY + 18, 'ABILITIES', {
      fontFamily: 'monospace',
      fontSize: '24px',
      fontStyle: 'bold',
      color: hex(COLORS.textPrimary),
    });
    const counterBg = scene.add
      .rectangle(panelX + PANEL_WIDTH - 158, panelY + 18, 136, 30, COLORS.equippedDark, 1)
      .setOrigin(0, 0)
      .setStrokeStyle(1, COLORS.equipped);
    const counter = text(
      panelX + PANEL_WIDTH - 90,
      panelY + 33,
      `${equippedCount} / ${config.slotLimit} SLOTTED`,
      {
        fontFamily: 'monospace',
        fontSize: '13px',
        fontStyle: 'bold',
        color: '#d8fff4',
      },
    ).setOrigin(0.5);
    const subtitle = text(panelX + PANEL_PADDING, panelY + 56, 'Build your auto-cast bar', {
      fontFamily: 'monospace',
      fontSize: '15px',
      fontStyle: 'bold',
      color: hex(COLORS.accent),
    });
    const body = text(
      panelX + PANEL_PADDING,
      panelY + 80,
      'Choose an ability, then equip or remove it. Changes apply immediately.',
      {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: hex(COLORS.textSecondary),
        wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 },
      },
    );
    dynamic.push(title, counterBg, counter, subtitle, body);
    overlay.add([title, counterBg, counter, subtitle, body]);

    const viewport = listViewportBounds();
    const visibleEntries = entries.slice(scrollIndex, scrollIndex + VISIBLE_ROWS);
    for (let localIndex = 0; localIndex < visibleEntries.length; localIndex += 1) {
      const entry = visibleEntries[localIndex]!;
      const entryIndex = scrollIndex + localIndex;
      const selected = entryIndex === selectedIndex;
      const rowY = viewport.y + localIndex * (ROW_HEIGHT + ROW_GAP);
      const row = scene.add
        .rectangle(
          viewport.x,
          rowY,
          viewport.width,
          ROW_HEIGHT,
          selected ? COLORS.selected : COLORS.rowBg,
          1,
        )
        .setOrigin(0, 0)
        .setStrokeStyle(selected ? 2 : 1, selected ? COLORS.accent : COLORS.panelBorder)
        .setInteractive({ useHandCursor: true });
      row.on('pointerover', () => {
        if (entryIndex !== selectedIndex) row.setFillStyle(COLORS.rowHover);
      });
      row.on('pointerout', () => {
        if (entryIndex !== selectedIndex) row.setFillStyle(COLORS.rowBg);
      });
      row.on('pointerdown', () => {
        selectedIndex = entryIndex;
        clampSelectionIntoView();
        render();
      });

      const tile = scene.add
        .rectangle(viewport.x + 12, rowY + 20, 62, 62, categoryColor(entry.category), 0.95)
        .setOrigin(0, 0)
        .setStrokeStyle(2, selected ? COLORS.accent : COLORS.panelBorder);
      const iconEntry = getAbilityIconEntry(scene, entry.id);
      let identity: Phaser.GameObjects.GameObject;
      if (iconEntry) {
        const icon = scene.add.image(viewport.x + 43, rowY + 51, iconEntry.textureKey);
        icon.setScale(fitScaleForBox(icon.width, icon.height, 54));
        identity = icon;
      } else {
        identity = text(viewport.x + 43, rowY + 51, entry.shortLabel.slice(0, 5), {
          fontFamily: 'monospace',
          fontSize: '14px',
          fontStyle: 'bold',
          color: '#ffffff',
        }).setOrigin(0.5);
      }
      const name = text(viewport.x + 90, rowY + 12, entry.name, {
        fontFamily: 'monospace',
        fontSize: '18px',
        fontStyle: 'bold',
        color: hex(COLORS.textPrimary),
      });
      const details = text(viewport.x + 90, rowY + 41, entry.details, {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: hex(COLORS.accent),
        wordWrap: { width: viewport.width - 250 },
      });
      const description = text(viewport.x + 90, rowY + 76, entry.description, {
        fontFamily: 'monospace',
        fontSize: '12px',
        color: hex(COLORS.textPrimary),
        wordWrap: { width: viewport.width - 250 },
      });
      const actionWidth = 112;
      const canToggle = entry.canToggle !== false;
      const action = scene.add
        .rectangle(
          viewport.x + viewport.width - actionWidth - 12,
          rowY + 32,
          actionWidth,
          38,
          canToggle ? (entry.equipped ? COLORS.equippedDark : COLORS.sectionHeader) : COLORS.rowBg,
          1,
        )
        .setOrigin(0, 0)
        .setStrokeStyle(
          2,
          canToggle ? (entry.equipped ? COLORS.equipped : COLORS.accent) : COLORS.panelBorder,
        );
      if (canToggle) {
        action.setInteractive({ useHandCursor: true });
      }
      const actionLabel = text(
        viewport.x + viewport.width - actionWidth / 2 - 12,
        rowY + 51,
        canToggle ? (entry.equipped ? 'REMOVE' : 'EQUIP') : 'PASSIVE',
        {
          fontFamily: 'monospace',
          fontSize: '14px',
          fontStyle: 'bold',
          color: canToggle
            ? entry.equipped
              ? '#bff7e8'
              : hex(COLORS.textPrimary)
            : hex(COLORS.textMuted),
        },
      ).setOrigin(0.5);
      if (canToggle) {
        action.on(
          'pointerdown',
          (
            _pointer: Phaser.Input.Pointer,
            _localX: number,
            _localY: number,
            event: Phaser.Types.Input.EventData,
          ) => {
            event.stopPropagation();
            selectedIndex = entryIndex;
            applyToggle(entry.id);
          },
        );
      }

      const box = { x: viewport.x, y: rowY, width: viewport.width, height: ROW_HEIGHT };
      rowBounds.push(scaledBounds(box));
      dynamic.push(row, tile, identity, name, details, description, action, actionLabel);
      overlay.add([row, tile, identity, name, details, description, action, actionLabel]);
    }

    if (entries.length > VISIBLE_ROWS) {
      const scrollText = text(
        panelX + PANEL_WIDTH - PANEL_PADDING,
        panelY + HEADER_HEIGHT - 16,
        `${scrollIndex + 1}-${Math.min(entries.length, scrollIndex + VISIBLE_ROWS)} / ${entries.length}`,
        {
          fontFamily: 'monospace',
          fontSize: '11px',
          color: hex(COLORS.textMuted),
        },
      ).setOrigin(1, 0);
      dynamic.push(scrollText);
      overlay.add(scrollText);
    }

    const footer = footerBounds();
    const controls = text(
      footer.x + PANEL_PADDING,
      footer.y + 12,
      '↑↓ / D-Pad  Select     Enter / A  Equip or remove     Esc / B  Close',
      {
        fontFamily: 'monospace',
        fontSize: '13px',
        color: hex(COLORS.textSecondary),
      },
    );
    const feedbackText = text(
      footer.x + PANEL_PADDING,
      footer.y + 36,
      feedback || 'Tip: the bar auto-casts equipped abilities when their trigger is ready.',
      {
        fontFamily: 'monospace',
        fontSize: '13px',
        fontStyle: feedback ? 'bold' : 'normal',
        color: feedback
          ? feedbackTone === 'success'
            ? '#8de3ca'
            : hex(COLORS.warning)
          : hex(COLORS.textSecondary),
        wordWrap: { width: PANEL_WIDTH - PANEL_PADDING * 2 },
      },
    );
    dynamic.push(controls, feedbackText);
    overlay.add([controls, feedbackText]);
  };

  const moveSelection = (delta: number): void => {
    if (!visible || entries.length === 0) return;
    selectedIndex = Phaser.Math.Wrap(selectedIndex + delta, 0, entries.length);
    feedback = '';
    clampSelectionIntoView();
    render();
  };

  const scrollRows = (delta: number): boolean => {
    if (!visible || entries.length <= VISIBLE_ROWS || delta === 0) return false;
    const next = Phaser.Math.Clamp(
      scrollIndex + Math.sign(delta),
      0,
      Math.max(0, entries.length - VISIBLE_ROWS),
    );
    if (next === scrollIndex) return false;
    scrollIndex = next;
    selectedIndex = Phaser.Math.Clamp(selectedIndex, scrollIndex, scrollIndex + VISIBLE_ROWS - 1);
    render();
    return true;
  };

  const close = (): void => {
    if (!visible) return;
    visible = false;
    overlay.setVisible(false);
    rememberedAbilityId = entries[selectedIndex]?.id ?? rememberedAbilityId;
    config?.onClose?.();
    config = null;
    entries = [];
    feedback = '';
    clearDynamic();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!visible) return;
    if (event.code === 'ArrowUp' || event.code === 'KeyW') {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.code === 'ArrowDown' || event.code === 'KeyS') {
      event.preventDefault();
      moveSelection(1);
    } else if (event.code === 'Enter' || event.code === 'Space') {
      event.preventDefault();
      const selected = entries[selectedIndex];
      if (selected) applyToggle(selected.id);
    } else if (event.code === 'Escape' || event.code === 'KeyB') {
      event.preventDefault();
      close();
    }
  };

  const onWheel = (
    pointer: Phaser.Input.Pointer,
    _objects: Phaser.GameObjects.GameObject[],
    _deltaX: number,
    deltaY: number,
  ): void => {
    if (!visible) return;
    const viewport = scaledBounds(listViewportBounds());
    const renderScale = getRenderScale(scene);
    const pointerX = pointer.x / renderScale;
    const pointerY = pointer.y / renderScale;
    if (
      pointerX >= viewport.x &&
      pointerX <= viewport.x + viewport.width &&
      pointerY >= viewport.y &&
      pointerY <= viewport.y + viewport.height
    ) {
      scrollRows(deltaY);
    }
  };

  const onGamepadDown = (
    _pad: Phaser.Input.Gamepad.Gamepad,
    button: Phaser.Input.Gamepad.Button,
  ): void => {
    if (!visible) return;
    if (button.index === 12) moveSelection(-1);
    else if (button.index === 13) moveSelection(1);
    else if (button.index === 0) {
      const selected = entries[selectedIndex];
      if (selected) applyToggle(selected.id);
    } else if (button.index === 1) close();
  };

  scene.input.keyboard?.on('keydown', onKeyDown);
  scene.input.on('wheel', onWheel);
  scene.input.gamepad?.on('down', onGamepadDown);
  const onResize = (): void => render();
  scene.scale.on(Phaser.Scale.Events.RESIZE, onResize);

  return {
    open(nextConfig: AbilityLoadoutConfig): void {
      config = nextConfig;
      entries = nextConfig.entries;
      const rememberedIndex = rememberedAbilityId
        ? entries.findIndex((entry) => entry.id === rememberedAbilityId)
        : -1;
      selectedIndex =
        rememberedIndex >= 0
          ? rememberedIndex
          : Math.max(0, Math.min(selectedIndex, entries.length - 1));
      scrollIndex = 0;
      clampSelectionIntoView();
      feedback = '';
      visible = true;
      overlay.setVisible(true);
      render();
    },
    close,
    isOpen: () => visible,
    getPanelScreenBounds: () =>
      scaledBounds({ x: panelX, y: panelY, width: PANEL_WIDTH, height: PANEL_HEIGHT }),
    getListViewportScreenBounds: () => scaledBounds(listViewportBounds()),
    getVisibleRowScreenBounds: () => [...rowBounds],
    getVisibleAbilityIds: () =>
      entries.slice(scrollIndex, scrollIndex + VISIBLE_ROWS).map((entry) => entry.id),
    getVisibleEntries: () => entries.slice(scrollIndex, scrollIndex + VISIBLE_ROWS),
    getFooterScreenBounds: () => scaledBounds(footerBounds()),
    getSelectedAbilityId: () => entries[selectedIndex]?.id ?? null,
    scrollRows,
    destroy(): void {
      scene.input.keyboard?.off('keydown', onKeyDown);
      scene.input.off('wheel', onWheel);
      scene.input.gamepad?.off('down', onGamepadDown);
      scene.scale.off(Phaser.Scale.Events.RESIZE, onResize);
      clearDynamic();
      overlay.destroy(true);
    },
  };
}
