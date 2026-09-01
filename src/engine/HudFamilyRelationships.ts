/**
 * HudFamilyRelationships — Floor-2 HUD widget (ADR 0040 · D8, FR20).
 *
 * Renders one row per present family (color swatch, name, 0–100 band-colored
 * bar, boss-alive/dead icon, status tag). Hidden until family reputation is
 * activated by the Floor 2 Broker introduction.
 *
 * Reactive: uses a snapshot fingerprint (per-family relation + band + boss
 * flag) as a dirty flag, so a full row re-render only happens when something
 * actually changed. Cheap enough to call every frame from HudUI.sync.
 *
 * Engine layer only (Phaser allowed). No imports from game/labs.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { PIXEL_UI, PIXEL_UI_DEPTH, createBeveledPanel } from './pixel-ui.js';
import { applyCrispText, type ScreenBounds } from './ui-scale.js';
import { loadFamilies, type FamilyDef } from '../shared/data/families.js';
import { BLUE_STEEL, HUD_FONT_FAMILY, MIN_TEXT_RESOLUTION, hex } from './ui-theme.js';
import {
  resolveFamilyRows,
  shouldShowFamilyRelationships,
  type FamilyRow,
} from './family-relationships-state.js';

const MIN_PANEL_WIDTH = 264;
const TITLE_H = 30;
const ROW_H = 42;
const ROW_GAP = 2;
const MAX_ROWS = 4;
const PANEL_PAD = 8;

const SWATCH_SIZE = 12;
const NAME_X = 22;
const MIN_NAME_COLUMN_WIDTH = 96;
const NAME_STATUS_GAP = 12;
const BAR_WIDTH = 110;
const BAR_HEIGHT = 8;
const VALUE_COLUMN_WIDTH = 24;
const VALUE_RIGHT_X = NAME_X + BAR_WIDTH + 5 + VALUE_COLUMN_WIDTH;
const STATUS_PILL_WIDTH = 76;
const STATUS_BOSS_GAP = 10;
const BOSS_TILE_WIDTH = 28;
const CLEARANCE = 8;
const IDENTITY_CENTER_Y = 11;
const METRIC_CENTER_Y = 33;
const FAMILY_BODY_FONT = '"Aptos", "Segoe UI", sans-serif';
const COLLAPSE_STORAGE_KEY = 'crawler:family-relationships-collapsed';

/** Panel anchored bottom-right so it doesn't collide with the top-right radar. */
const PANEL_MARGIN_RIGHT = 12;
const PANEL_MARGIN_BOTTOM = 160;

function readCollapsedPref(): boolean {
  try {
    return globalThis.localStorage?.getItem(COLLAPSE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeCollapsedPref(collapsed: boolean): void {
  try {
    globalThis.localStorage?.setItem(COLLAPSE_STORAGE_KEY, collapsed ? '1' : '0');
  } catch {
    // Storage may be unavailable in private or headless contexts.
  }
}

export interface FamilyRelationshipRowLayout {
  readonly row: ScreenBounds;
  readonly swatch: ScreenBounds;
  readonly name: ScreenBounds;
  readonly bar: ScreenBounds;
  readonly relationTicks: readonly ScreenBounds[];
  readonly value: ScreenBounds;
  readonly bossTile: ScreenBounds;
  readonly bossLabel: ScreenBounds;
  readonly statusPill: ScreenBounds;
  readonly status: ScreenBounds;
  readonly statusLabel: string;
  readonly displayedName: string;
  readonly relation: number;
  readonly band: FamilyRow['band'];
  readonly bossDefeated: boolean;
  readonly bossStateLabel: '♥' | '☠️';
}

export interface FamilyRelationshipsLayout {
  readonly visible: boolean;
  readonly panel: ScreenBounds | null;
  readonly title: ScreenBounds | null;
  readonly columnHeader: null;
  readonly columnLabels: null;
  readonly collapsed: boolean;
  readonly collapseToggle: ScreenBounds | null;
  readonly rows: readonly FamilyRelationshipRowLayout[];
}

interface RowVisuals {
  container: Phaser.GameObjects.Container;
  background: Phaser.GameObjects.Rectangle;
  swatch: Phaser.GameObjects.Rectangle;
  name: Phaser.GameObjects.Text;
  barTrack: Phaser.GameObjects.Rectangle;
  barFill: Phaser.GameObjects.Rectangle;
  relationTicks: Phaser.GameObjects.Rectangle[];
  relationText: Phaser.GameObjects.Text;
  bossTile: Phaser.GameObjects.Rectangle;
  bossIcon: Phaser.GameObjects.Text;
  statusPill: Phaser.GameObjects.Rectangle;
  statusText: Phaser.GameObjects.Text;
  row: FamilyRow | null;
}

export interface HudFamilyRelationshipsOptions {
  parent?: Phaser.GameObjects.Container;
  /** Test/lab hook — override the roster instead of loading families.json. */
  families?: readonly FamilyDef[];
  /** Screen-space regions the panel must not overlap (minimap and adjacent HUD). */
  getAvoidBounds?: () => readonly ScreenBounds[];
}

export interface HudFamilyRelationshipsState {
  readonly visible: boolean;
  readonly bounds: ScreenBounds | null;
  /** Raw Phaser display-object visibility for the backing panel (not the logical gate). */
  readonly panelVisible: boolean;
}

export function createHudFamilyRelationships(
  scene: Phaser.Scene,
  options: HudFamilyRelationshipsOptions = {},
): {
  sync(world: GameWorld): void;
  setVisible(visible: boolean): void;
  setCollapsed(collapsed: boolean): void;
  getState(): HudFamilyRelationshipsState;
  getLayout(): FamilyRelationshipsLayout;
  destroy(): void;
} {
  const parent = options.parent;
  const families = options.families ?? loadFamilies();

  const totalRows = MAX_ROWS;
  const expandedPanelHeight = (): number =>
    PANEL_PAD +
    TITLE_H +
    rowVisuals.filter((row) => row.row !== null).length * (ROW_H + ROW_GAP) +
    PANEL_PAD;
  const collapsedPanelHeight = PANEL_PAD + TITLE_H;
  let collapsed = readCollapsedPref();
  let panelWidth = MIN_PANEL_WIDTH;
  let panelHeight = collapsed
    ? collapsedPanelHeight
    : PANEL_PAD + TITLE_H + totalRows * (ROW_H + ROW_GAP) + PANEL_PAD;

  const root = scene.add
    .container(
      GAME.WIDTH - panelWidth - PANEL_MARGIN_RIGHT,
      GAME.HEIGHT - panelHeight - PANEL_MARGIN_BOTTOM,
    )
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.panel);
  parent?.add(root);
  const panel = createBeveledPanel(scene, 0, 0, panelWidth, panelHeight, {
    parent: root,
    fill: BLUE_STEEL.panelBg,
    highlight: BLUE_STEEL.panelBorder,
    shadow: PIXEL_UI.bevelDark,
    border: PIXEL_UI.border,
    fillAlpha: 0.97,
  });

  const titleFrame = scene.add
    .rectangle(PANEL_PAD - 2, 4, panelWidth - PANEL_PAD * 2 + 4, 17, BLUE_STEEL.sectionHeader)
    .setOrigin(0, 0)
    .setStrokeStyle(1, BLUE_STEEL.panelBorder)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add(titleFrame);

  const title = scene.add
    .text(PANEL_PAD + 3, 7, 'FAMILY RELATIONS', {
      fontFamily: HUD_FONT_FAMILY,
      fontSize: '10px',
      fontStyle: 'bold',
      color: hex(PIXEL_UI.gold),
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add(title);

  // Thin gold accent rule under the title bar — matches the Wave-1
  // gold-accent-as-emphasis vocabulary (IntroScene divider, HudMinimap
  // compass band) without adding per-row chrome that would fight fast
  // row-to-row scanning.
  const titleAccent = scene.add
    .rectangle(PANEL_PAD - 2, 4 + 17, panelWidth - PANEL_PAD * 2 + 4, 2, PIXEL_UI.gold, 0.85)
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add(titleAccent);

  const chevron = scene.add
    .text(panelWidth - PANEL_PAD - 2, 12, collapsed ? '▸' : '▾', {
      fontFamily: FAMILY_BODY_FONT,
      fontSize: '17px',
      fontStyle: 'bold',
      color: hex(PIXEL_UI.gold),
    })
    .setOrigin(1, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add(chevron);

  const rowStartY = PANEL_PAD + TITLE_H;
  const rowVisuals: RowVisuals[] = [];

  for (let i = 0; i < totalRows; i += 1) {
    const rowY = rowStartY + i * (ROW_H + ROW_GAP);
    const container = scene.add
      .container(PANEL_PAD, rowY)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content);

    const background = scene.add
      .rectangle(0, 0, panelWidth - PANEL_PAD * 2, ROW_H, i % 2 === 0 ? 0x394c74 : 0x35476d)
      .setOrigin(0, 0)
      .setStrokeStyle(1, BLUE_STEEL.panelBorder);
    const swatch = scene.add
      .rectangle(4, IDENTITY_CENTER_Y, SWATCH_SIZE, SWATCH_SIZE, 0x64748b)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, PIXEL_UI.border);

    const name = scene.add
      .text(NAME_X, IDENTITY_CENTER_Y, '', {
        fontFamily: FAMILY_BODY_FONT,
        fontSize: '13px',
        fontStyle: 'bold',
        color: hex(BLUE_STEEL.textPrimary),
        stroke: '#02040a',
        strokeThickness: 1,
      })
      .setOrigin(0, 0.5);

    const barX = NAME_X;
    const barY = METRIC_CENTER_Y - BAR_HEIGHT / 2;
    const barTrack = scene.add
      .rectangle(barX, barY, BAR_WIDTH, BAR_HEIGHT, PIXEL_UI.trackFill)
      .setOrigin(0, 0)
      .setStrokeStyle(1, PIXEL_UI.border);
    const barFill = scene.add
      .rectangle(barX + 1, barY + 1, BAR_WIDTH - 2, BAR_HEIGHT - 2, PIXEL_UI.hpHigh)
      .setOrigin(0, 0);
    const relationTicks = [0.25, 0.5, 0.75].map((fraction) =>
      scene.add
        .rectangle(
          Math.round(barX + BAR_WIDTH * fraction),
          barY + 1,
          1,
          BAR_HEIGHT - 2,
          0xd9e2ef,
          0.5,
        )
        .setOrigin(0, 0),
    );

    const relationText = scene.add
      .text(VALUE_RIGHT_X, METRIC_CENTER_Y, '', {
        fontFamily: FAMILY_BODY_FONT,
        fontSize: '13px',
        fontStyle: 'bold',
        color: hex(BLUE_STEEL.textSecondary),
        stroke: '#02040a',
        strokeThickness: 1,
      })
      .setOrigin(1, 0.5);

    const bossTileX = panelWidth - PANEL_PAD * 2 - BOSS_TILE_WIDTH / 2 - 2;
    const bossTileY = IDENTITY_CENTER_Y;
    const bossTile = scene.add
      .rectangle(bossTileX, bossTileY, BOSS_TILE_WIDTH, 18, 0x2b3c61)
      .setOrigin(0.5, 0.5)
      .setStrokeStyle(1, BLUE_STEEL.panelBorder);
    const bossIcon = scene.add
      .text(bossTileX, bossTileY, '♥', {
        fontFamily: FAMILY_BODY_FONT,
        fontSize: '14px',
        fontStyle: 'bold',
        color: '#f87171',
      })
      .setOrigin(0.5, 0.5);

    const statusPillX = NAME_X + MIN_NAME_COLUMN_WIDTH + NAME_STATUS_GAP;
    const statusPillY = IDENTITY_CENTER_Y - 9;
    const statusPill = scene.add
      .rectangle(statusPillX, statusPillY, STATUS_PILL_WIDTH, 18, PIXEL_UI.trackFill)
      .setOrigin(0, 0)
      .setStrokeStyle(1, BLUE_STEEL.panelBorder);

    const statusText = scene.add
      .text(statusPillX + STATUS_PILL_WIDTH / 2, IDENTITY_CENTER_Y, '', {
        fontFamily: FAMILY_BODY_FONT,
        fontSize: '12px',
        fontStyle: 'bold',
        color: hex(BLUE_STEEL.textSecondary),
        stroke: '#02040a',
        strokeThickness: 1,
      })
      .setOrigin(0.5, 0.5);

    container.add([
      background,
      swatch,
      name,
      barTrack,
      barFill,
      ...relationTicks,
      relationText,
      bossTile,
      bossIcon,
      statusPill,
      statusText,
    ]);
    root.add(container);
    rowVisuals.push({
      container,
      background,
      swatch,
      name,
      barTrack,
      barFill,
      relationTicks,
      relationText,
      bossTile,
      bossIcon,
      statusPill,
      statusText,
      row: null,
    });
  }

  const allTexts = [
    title,
    chevron,
    ...rowVisuals.flatMap((r) => [r.name, r.relationText, r.bossIcon, r.statusText]),
  ];
  const detachCrispText = applyCrispText(scene, allTexts, MIN_TEXT_RESOLUTION + 2);

  let lastFingerprint = '';
  let lastVisible = true;
  let masterVisible = true;
  let destroyed = false;

  if (typeof document !== 'undefined' && document.fonts) {
    void document.fonts.ready.then(() => {
      if (destroyed) return;
      for (const text of allTexts) text.updateText();
      lastFingerprint = '';
    });
  }

  function setPanelVisible(visible: boolean): void {
    const effectiveVisible = visible && masterVisible;
    panel.setVisible(effectiveVisible);
    titleFrame.setVisible(effectiveVisible);
    titleAccent.setVisible(effectiveVisible);
    title.setVisible(effectiveVisible);
    chevron.setVisible(effectiveVisible);
    for (const r of rowVisuals) {
      r.container.setVisible(effectiveVisible && !collapsed && r.row !== null);
    }
  }

  function fingerprintFor(rows: FamilyRow[]): string {
    const parts = rows.map(
      (r) => `${r.familyId}:${Math.round(r.relation)}:${r.band}:${r.bossDefeated ? '1' : '0'}`,
    );
    return parts.join('|');
  }

  function renderRow(rv: RowVisuals, row: FamilyRow | null): void {
    rv.row = row;
    if (row === null) {
      rv.container.setVisible(false);
      return;
    }
    rv.container.setVisible(masterVisible && lastVisible && !collapsed);
    rv.swatch.setFillStyle(row.hudColor);
    rv.name.setText(row.name);

    const inner = BAR_WIDTH - 2;
    const pct = Math.max(0, Math.min(1, row.relation / 100));
    const w = Math.max(1, Math.round(inner * pct));
    rv.barFill.setSize(w, BAR_HEIGHT - 2);
    rv.barFill.setFillStyle(row.barColor);
    rv.relationText.setText(String(Math.round(row.relation)));

    if (row.bossDefeated) {
      rv.bossIcon.setText('☠️');
      rv.bossIcon.setColor('#94a3b8');
      rv.bossTile.setStrokeStyle(1, 0x94a3b8);
    } else {
      rv.bossIcon.setText('♥');
      rv.bossIcon.setColor('#f87171');
      rv.bossTile.setStrokeStyle(1, 0xf87171);
    }

    const bandLabel =
      row.band === 'friendly'
        ? 'ALLY'
        : row.band === 'neutral'
          ? 'NEUTRAL'
          : row.band === 'hostile'
            ? 'HOSTILE'
            : 'HATE';
    rv.statusText.setText(bandLabel);
    if (row.band === 'friendly') {
      rv.statusText.setColor('#86efac');
      rv.statusPill.setStrokeStyle(1, 0x2f6e46);
    } else if (row.band === 'neutral') {
      rv.statusText.setColor('#d9e2ef');
      rv.statusPill.setStrokeStyle(1, BLUE_STEEL.panelBorder);
    } else if (row.band === 'hostile') {
      rv.statusText.setColor('#fdba74');
      rv.statusPill.setStrokeStyle(1, 0x8a5222);
    } else {
      rv.statusText.setColor('#fca5a5');
      rv.statusPill.setStrokeStyle(1, 0x8a2f2f);
    }
  }

  function applyDynamicLayout(): void {
    const widestName = rowVisuals.reduce(
      (width, rv) => (rv.row ? Math.max(width, Math.ceil(rv.name.width)) : width),
      MIN_NAME_COLUMN_WIDTH,
    );
    const statusPillX = Math.max(
      NAME_X + widestName + NAME_STATUS_GAP,
      VALUE_RIGHT_X + NAME_STATUS_GAP,
    );
    const bossTileX = statusPillX + STATUS_PILL_WIDTH + STATUS_BOSS_GAP + BOSS_TILE_WIDTH / 2;
    const contentRight = bossTileX + BOSS_TILE_WIDTH / 2 + 2;

    panelWidth = Math.max(MIN_PANEL_WIDTH, contentRight + PANEL_PAD * 2);
    panelHeight = collapsed ? collapsedPanelHeight : expandedPanelHeight();
    panel.setSize(panelWidth, panelHeight);
    titleFrame.setSize(panelWidth - PANEL_PAD * 2 + 4, 17);
    titleAccent.setSize(panelWidth - PANEL_PAD * 2 + 4, 2);
    chevron.setX(panelWidth - PANEL_PAD - 2);

    const rowWidth = panelWidth - PANEL_PAD * 2;
    for (const rv of rowVisuals) {
      rv.background.setSize(rowWidth, ROW_H);
      rv.statusPill.setX(statusPillX);
      rv.statusText.setX(statusPillX + STATUS_PILL_WIDTH / 2);
      rv.bossTile.setX(bossTileX);
      rv.bossIcon.setX(bossTileX);
    }
  }

  function overlaps(a: ScreenBounds, b: ScreenBounds): boolean {
    return (
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    );
  }

  function panelScreenBounds(): ScreenBounds {
    const titleBounds = screenBounds(titleFrame);
    const titleFrameWidth = panelWidth - PANEL_PAD * 2 + 4;
    const scaleX = titleBounds.width / titleFrameWidth;
    const scaleY = titleBounds.height / 17;
    return {
      x: titleBounds.x - (PANEL_PAD - 2) * scaleX,
      y: titleBounds.y - 4 * scaleY,
      width: panelWidth * scaleX,
      height: panelHeight * scaleY,
    };
  }

  function updateAvoidance(): void {
    root.setPosition(
      GAME.WIDTH - panelWidth - PANEL_MARGIN_RIGHT,
      GAME.HEIGHT - panelHeight - PANEL_MARGIN_BOTTOM,
    );
    const avoid = options
      .getAvoidBounds?.()
      .filter((bounds) => bounds.width > 0 && bounds.height > 0);
    if (!avoid || avoid.length === 0) return;
    const bounds = panelScreenBounds();
    if (!avoid.some((region) => overlaps(bounds, region))) return;

    const candidates = [{ dx: 0, dy: 0 }];
    for (const region of avoid) {
      candidates.push(
        { dx: region.x - CLEARANCE - (bounds.x + bounds.width), dy: 0 },
        { dx: region.x + region.width + CLEARANCE - bounds.x, dy: 0 },
        { dx: 0, dy: region.y - CLEARANCE - (bounds.y + bounds.height) },
        { dx: 0, dy: region.y + region.height + CLEARANCE - bounds.y },
      );
    }

    const best = candidates
      .filter(({ dx, dy }) => {
        const moved = {
          x: bounds.x + dx,
          y: bounds.y + dy,
          width: bounds.width,
          height: bounds.height,
        };
        const onScreen =
          moved.x >= PANEL_MARGIN_RIGHT &&
          moved.y >= PANEL_MARGIN_RIGHT &&
          moved.x + moved.width <= GAME.WIDTH - PANEL_MARGIN_RIGHT &&
          moved.y + moved.height <= GAME.HEIGHT - PANEL_MARGIN_RIGHT;
        return onScreen && avoid.every((region) => !overlaps(moved, region));
      })
      .sort((a, b) => Math.abs(a.dx) + Math.abs(a.dy) - (Math.abs(b.dx) + Math.abs(b.dy)))[0];
    if (!best) return;

    const parentScaleX = Math.abs(parent?.scaleX ?? 1) || 1;
    const parentScaleY = Math.abs(parent?.scaleY ?? 1) || 1;
    root.x += best.dx / parentScaleX;
    root.y += best.dy / parentScaleY;
  }

  function sync(world: GameWorld): void {
    const shouldShow = shouldShowFamilyRelationships(world);
    if (shouldShow !== lastVisible) {
      lastVisible = shouldShow;
      setPanelVisible(shouldShow);
      if (!shouldShow) {
        lastFingerprint = '';
        return;
      }
    }
    if (!shouldShow || !masterVisible) return;

    const rows = resolveFamilyRows(world, families).slice(0, MAX_ROWS);
    const fp = fingerprintFor(rows);
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      for (let i = 0; i < rowVisuals.length; i += 1) {
        renderRow(rowVisuals[i]!, i < rows.length ? rows[i]! : null);
      }
    }
    applyDynamicLayout();
    updateAvoidance();
  }

  // Hidden by default until sync sees Floor 2.
  setPanelVisible(false);
  lastVisible = false;

  function setVisible(visible: boolean): void {
    if (visible === masterVisible) {
      return;
    }
    masterVisible = visible;
    if (visible) {
      lastFingerprint = '';
    }
    setPanelVisible(lastVisible);
  }

  function setCollapsed(nextCollapsed: boolean): void {
    if (nextCollapsed === collapsed) return;
    collapsed = nextCollapsed;
    writeCollapsedPref(collapsed);
    chevron.setText(collapsed ? '▸' : '▾');
    applyDynamicLayout();
    setPanelVisible(lastVisible);
    if (lastVisible && masterVisible) updateAvoidance();
  }

  const onTitlePointerUp = (): void => {
    if (!lastVisible || !masterVisible) return;
    setCollapsed(!collapsed);
  };
  titleFrame.setInteractive({ useHandCursor: true }).on('pointerup', onTitlePointerUp);

  function getState(): HudFamilyRelationshipsState {
    const parentVisible = parent?.visible ?? true;
    const visible =
      parentVisible &&
      (panel.visible ||
        titleFrame.visible ||
        title.visible ||
        rowVisuals.some((row) => row.container.visible));
    if (!visible) {
      return { visible: false, bounds: null, panelVisible: parentVisible && panel.visible };
    }
    return {
      visible: true,
      panelVisible: parentVisible && panel.visible,
      bounds: panelScreenBounds(),
    };
  }

  function screenBounds(
    object: Phaser.GameObjects.GameObject & { getBounds(): Phaser.Geom.Rectangle },
  ): ScreenBounds {
    const b = object.getBounds();
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }

  function getLayout(): FamilyRelationshipsLayout {
    const parentVisible = parent?.visible ?? true;
    if (!lastVisible || !masterVisible || !parentVisible || !root.visible) {
      return {
        visible: false,
        panel: null,
        title: null,
        columnHeader: null,
        columnLabels: null,
        collapsed,
        collapseToggle: null,
        rows: [],
      };
    }
    return {
      visible: true,
      panel: panelScreenBounds(),
      title: screenBounds(title),
      columnHeader: null,
      columnLabels: null,
      collapsed,
      collapseToggle: screenBounds(chevron),
      rows: rowVisuals.flatMap((rv) => {
        if (!rv.container.visible || !rv.row) return [];
        return [
          {
            row: screenBounds(rv.background),
            swatch: screenBounds(rv.swatch),
            name: screenBounds(rv.name),
            bar: screenBounds(rv.barTrack),
            relationTicks: rv.relationTicks.map(screenBounds),
            value: screenBounds(rv.relationText),
            bossTile: screenBounds(rv.bossTile),
            bossLabel: screenBounds(rv.bossIcon),
            statusPill: screenBounds(rv.statusPill),
            status: screenBounds(rv.statusText),
            statusLabel: rv.statusText.text,
            displayedName: rv.name.text,
            relation: rv.row.relation,
            band: rv.row.band,
            bossDefeated: rv.row.bossDefeated,
            bossStateLabel: rv.row.bossDefeated ? '☠️' : '♥',
          },
        ];
      }),
    };
  }

  function destroy(): void {
    destroyed = true;
    detachCrispText();
    for (const r of rowVisuals) r.container.destroy();
    title.destroy();
    titleFrame.off('pointerup', onTitlePointerUp);
    chevron.destroy();
    titleFrame.destroy();
    titleAccent.destroy();
    panel.destroy();
    root.destroy();
  }

  return { sync, setVisible, setCollapsed, getState, getLayout, destroy };
}
