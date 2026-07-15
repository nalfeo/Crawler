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
import { BLUE_STEEL, MIN_TEXT_RESOLUTION, hex } from './ui-theme.js';
import {
  resolveFamilyRows,
  shouldShowFamilyRelationships,
  displayNameForRow,
  type FamilyRow,
} from './family-relationships-state.js';

const PANEL_WIDTH = 244;
const TITLE_H = 24;
const ROW_H = 42;
const ROW_GAP = 2;
const MAX_ROWS = 4;
const PANEL_PAD = 8;

const SWATCH_SIZE = 12;
const BAR_WIDTH = 112;
const BAR_HEIGHT = 8;
const CLEARANCE = 8;
const FONT_FAMILY = '"Press Start 2P", "Courier New", monospace';

/** Panel anchored bottom-right so it doesn't collide with the top-right radar. */
const PANEL_MARGIN_RIGHT = 12;
const PANEL_MARGIN_BOTTOM = 160;

export interface FamilyRelationshipRowLayout {
  readonly row: ScreenBounds;
  readonly name: ScreenBounds;
  readonly bar: ScreenBounds;
  readonly value: ScreenBounds;
  readonly bossIcon: ScreenBounds;
  readonly status: ScreenBounds;
  readonly displayedName: string;
  readonly relation: number;
  readonly band: FamilyRow['band'];
  readonly bossDefeated: boolean;
}

export interface FamilyRelationshipsLayout {
  readonly visible: boolean;
  readonly panel: ScreenBounds | null;
  readonly rows: readonly FamilyRelationshipRowLayout[];
}

interface RowVisuals {
  container: Phaser.GameObjects.Container;
  background: Phaser.GameObjects.Rectangle;
  swatch: Phaser.GameObjects.Rectangle;
  name: Phaser.GameObjects.Text;
  barTrack: Phaser.GameObjects.Rectangle;
  barFill: Phaser.GameObjects.Rectangle;
  relationText: Phaser.GameObjects.Text;
  bossTile: Phaser.GameObjects.Rectangle;
  bossIcon: Phaser.GameObjects.Text;
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
  getState(): HudFamilyRelationshipsState;
  getLayout(): FamilyRelationshipsLayout;
  destroy(): void;
} {
  const parent = options.parent;
  const families = options.families ?? loadFamilies();

  const totalRows = MAX_ROWS;
  const panelHeight = PANEL_PAD + TITLE_H + totalRows * (ROW_H + ROW_GAP) + PANEL_PAD;
  const panelX = GAME.WIDTH - PANEL_WIDTH - PANEL_MARGIN_RIGHT;
  const panelY = GAME.HEIGHT - panelHeight - PANEL_MARGIN_BOTTOM;

  const root = scene.add
    .container(panelX, panelY)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.panel);
  parent?.add(root);
  const panel = createBeveledPanel(scene, 0, 0, PANEL_WIDTH, panelHeight, {
    parent: root,
    fill: BLUE_STEEL.panelBg,
    highlight: BLUE_STEEL.panelBorder,
    shadow: PIXEL_UI.bevelDark,
    border: PIXEL_UI.border,
    fillAlpha: 0.97,
  });

  const titleFrame = scene.add
    .rectangle(PANEL_PAD - 2, 4, PANEL_WIDTH - PANEL_PAD * 2 + 4, 17, BLUE_STEEL.sectionHeader)
    .setOrigin(0, 0)
    .setStrokeStyle(1, BLUE_STEEL.panelBorder)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add(titleFrame);

  const title = scene.add
    .text(PANEL_PAD + 3, 7, 'FAMILY RELATIONS', {
      fontFamily: FONT_FAMILY,
      fontSize: '10px',
      fontStyle: 'bold',
      color: hex(BLUE_STEEL.textPrimary),
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add(title);

  const rowStartY = PANEL_PAD + TITLE_H;
  const rowVisuals: RowVisuals[] = [];

  for (let i = 0; i < totalRows; i += 1) {
    const rowY = rowStartY + i * (ROW_H + ROW_GAP);
    const container = scene.add
      .container(PANEL_PAD, rowY)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content);

    const background = scene.add
      .rectangle(0, 0, PANEL_WIDTH - PANEL_PAD * 2, ROW_H, i % 2 === 0 ? 0x394c74 : 0x35476d)
      .setOrigin(0, 0)
      .setStrokeStyle(1, BLUE_STEEL.panelBorder);
    const swatch = scene.add
      .rectangle(0, ROW_H / 2, SWATCH_SIZE, SWATCH_SIZE, 0x64748b)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, PIXEL_UI.border);

    const nameX = SWATCH_SIZE + 6;
    const name = scene.add
      .text(nameX, 1, '', {
        fontFamily: FONT_FAMILY,
        fontSize: '9px',
        fontStyle: 'bold',
        color: hex(BLUE_STEEL.textPrimary),
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 4, bottom: 4 },
      })
      .setOrigin(0, 0);

    const barX = nameX;
    const barY = 30;
    const barTrack = scene.add
      .rectangle(barX, barY, BAR_WIDTH, BAR_HEIGHT, PIXEL_UI.trackFill)
      .setOrigin(0, 0)
      .setStrokeStyle(1, PIXEL_UI.border);
    const barFill = scene.add
      .rectangle(barX + 1, barY + 1, BAR_WIDTH - 2, BAR_HEIGHT - 2, PIXEL_UI.hpHigh)
      .setOrigin(0, 0);

    const relationText = scene.add
      .text(barX + BAR_WIDTH + 3, barY - 3, '', {
        fontFamily: FONT_FAMILY,
        fontSize: '9px',
        color: hex(BLUE_STEEL.textSecondary),
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 1, bottom: 1 },
      })
      .setOrigin(0, 0);

    const bossTileX = 220;
    const bossTileY = 12;
    const bossTile = scene.add
      .rectangle(bossTileX, bossTileY, 16, 16, 0x2b3c61)
      .setOrigin(0.5, 0.5)
      .setStrokeStyle(1, BLUE_STEEL.panelBorder);
    const bossIcon = scene.add
      .text(bossTileX, bossTileY - 1, '♥', {
        fontFamily: 'monospace',
        fontSize: '12px',
        fontStyle: 'bold',
        color: '#f87171',
        stroke: '#02040a',
        strokeThickness: 2,
      })
      .setOrigin(0.5, 0.5);

    const statusText = scene.add
      .text(142, 1, '', {
        fontFamily: FONT_FAMILY,
        fontSize: '9px',
        fontStyle: 'bold',
        color: hex(BLUE_STEEL.textSecondary),
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 5, bottom: 5 },
      })
      .setOrigin(0, 0);

    container.add([
      background,
      swatch,
      name,
      barTrack,
      barFill,
      relationText,
      bossTile,
      bossIcon,
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
      relationText,
      bossTile,
      bossIcon,
      statusText,
      row: null,
    });
  }

  const allTexts = [
    title,
    ...rowVisuals.flatMap((r) => [r.name, r.relationText, r.bossIcon, r.statusText]),
  ];
  const detachCrispText = applyCrispText(scene, allTexts, MIN_TEXT_RESOLUTION + 2);

  let lastFingerprint = '';
  let lastVisible = true;
  let masterVisible = true;

  function setPanelVisible(visible: boolean): void {
    const effectiveVisible = visible && masterVisible;
    panel.setVisible(effectiveVisible);
    titleFrame.setVisible(effectiveVisible);
    title.setVisible(effectiveVisible);
    for (const r of rowVisuals) r.container.setVisible(effectiveVisible);
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
    rv.container.setVisible(true);
    rv.swatch.setFillStyle(row.hudColor);
    // Prefer the full name; fall back to the short species label when it's too wide.
    rv.name.setText(displayNameForRow(row));

    const inner = BAR_WIDTH - 2;
    const pct = Math.max(0, Math.min(1, row.relation / 100));
    const w = Math.max(1, Math.round(inner * pct));
    rv.barFill.setSize(w, BAR_HEIGHT - 2);
    rv.barFill.setFillStyle(row.barColor);
    rv.relationText.setText(String(Math.round(row.relation)).padStart(3, ' '));

    if (row.bossDefeated) {
      rv.bossIcon.setText('☠');
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
    if (row.band === 'friendly') rv.statusText.setColor('#86efac');
    else if (row.band === 'neutral') rv.statusText.setColor('#d9e2ef');
    else if (row.band === 'hostile') rv.statusText.setColor('#fdba74');
    else rv.statusText.setColor('#fca5a5');
  }

  function overlaps(a: ScreenBounds, b: ScreenBounds): boolean {
    return (
      a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
    );
  }

  function panelScreenBounds(): ScreenBounds {
    return screenBounds(root);
  }

  function updateAvoidance(): void {
    root.setPosition(panelX, panelY);
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
    updateAvoidance();

    const rows = resolveFamilyRows(world, families).slice(0, MAX_ROWS);
    const fp = fingerprintFor(rows);
    if (fp === lastFingerprint) return;
    lastFingerprint = fp;

    for (let i = 0; i < rowVisuals.length; i += 1) {
      renderRow(rowVisuals[i]!, i < rows.length ? rows[i]! : null);
    }
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
      return { visible: false, panel: null, rows: [] };
    }
    return {
      visible: true,
      panel: panelScreenBounds(),
      rows: rowVisuals.flatMap((rv) => {
        if (!rv.container.visible || !rv.row) return [];
        return [
          {
            row: screenBounds(rv.background),
            name: screenBounds(rv.name),
            bar: screenBounds(rv.barTrack),
            value: screenBounds(rv.relationText),
            bossIcon: screenBounds(rv.bossTile),
            status: screenBounds(rv.statusText),
            displayedName: rv.name.text,
            relation: rv.row.relation,
            band: rv.row.band,
            bossDefeated: rv.row.bossDefeated,
          },
        ];
      }),
    };
  }

  function destroy(): void {
    detachCrispText();
    for (const r of rowVisuals) r.container.destroy();
    title.destroy();
    titleFrame.destroy();
    panel.destroy();
    root.destroy();
  }

  return { sync, setVisible, getState, getLayout, destroy };
}
