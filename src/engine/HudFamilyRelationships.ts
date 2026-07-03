/**
 * HudFamilyRelationships — Floor-2 HUD widget (ADR 0040 · D8, FR20).
 *
 * Renders one row per present family (color swatch, name, 0–100 band-colored
 * bar, boss-alive/dead icon, status tag). Hidden on floors where
 * `world.floor2State === null`.
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
import { applyCrispText } from './ui-scale.js';
import { loadFamilies, type FamilyDef } from '../shared/data/families.js';
import { resolveFamilyRows, type FamilyRow } from './family-relationships-state.js';

const PANEL_WIDTH = 232;
const TITLE_H = 22;
const ROW_H = 30;
const ROW_GAP = 4;
const MAX_ROWS = 4;
const PANEL_PAD = 8;

const SWATCH_SIZE = 12;
const BAR_WIDTH = 92;
const BAR_HEIGHT = 8;

/** Panel anchored bottom-right so it doesn't collide with the top-right radar. */
const PANEL_MARGIN_RIGHT = 12;
const PANEL_MARGIN_BOTTOM = 160;

interface RowVisuals {
  container: Phaser.GameObjects.Container;
  swatch: Phaser.GameObjects.Rectangle;
  name: Phaser.GameObjects.Text;
  barTrack: Phaser.GameObjects.Rectangle;
  barFill: Phaser.GameObjects.Rectangle;
  bossIcon: Phaser.GameObjects.Text;
  statusText: Phaser.GameObjects.Text;
}

export interface HudFamilyRelationshipsOptions {
  parent?: Phaser.GameObjects.Container;
  /** Test/lab hook — override the roster instead of loading families.json. */
  families?: readonly FamilyDef[];
}

export function createHudFamilyRelationships(
  scene: Phaser.Scene,
  options: HudFamilyRelationshipsOptions = {},
): {
  sync(world: GameWorld): void;
  destroy(): void;
} {
  const parent = options.parent;
  const families = options.families ?? loadFamilies();

  const totalRows = MAX_ROWS;
  const panelHeight = PANEL_PAD + TITLE_H + totalRows * (ROW_H + ROW_GAP) + PANEL_PAD;
  const panelX = GAME.WIDTH - PANEL_WIDTH - PANEL_MARGIN_RIGHT;
  const panelY = GAME.HEIGHT - panelHeight - PANEL_MARGIN_BOTTOM;

  const panel = createBeveledPanel(scene, panelX, panelY, PANEL_WIDTH, panelHeight, { parent });

  const title = scene.add
    .text(panelX + PANEL_PAD, panelY + 4, 'FAMILIES', {
      fontFamily: 'monospace',
      fontSize: '11px',
      fontStyle: 'bold',
      color: '#fcd34d',
      stroke: '#02040a',
      strokeThickness: 3,
    })
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  parent?.add(title);

  const rowStartY = panelY + PANEL_PAD + TITLE_H;
  const rowVisuals: RowVisuals[] = [];

  for (let i = 0; i < totalRows; i += 1) {
    const rowY = rowStartY + i * (ROW_H + ROW_GAP);
    const container = scene.add
      .container(panelX + PANEL_PAD, rowY)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content);

    const swatch = scene.add
      .rectangle(0, ROW_H / 2, SWATCH_SIZE, SWATCH_SIZE, 0x64748b)
      .setOrigin(0, 0.5)
      .setStrokeStyle(1, PIXEL_UI.border);

    const nameX = SWATCH_SIZE + 6;
    const name = scene.add
      .text(nameX, 2, '', {
        fontFamily: 'monospace',
        fontSize: '11px',
        fontStyle: 'bold',
        color: '#e5e7eb',
        stroke: '#02040a',
        strokeThickness: 2,
      })
      .setOrigin(0, 0);

    const barX = nameX;
    const barY = 16;
    const barTrack = scene.add
      .rectangle(barX, barY, BAR_WIDTH, BAR_HEIGHT, PIXEL_UI.trackFill)
      .setOrigin(0, 0)
      .setStrokeStyle(1, PIXEL_UI.border);
    const barFill = scene.add
      .rectangle(barX + 1, barY + 1, BAR_WIDTH - 2, BAR_HEIGHT - 2, PIXEL_UI.hpHigh)
      .setOrigin(0, 0);

    const bossIcon = scene.add
      .text(barX + BAR_WIDTH + 6, barY - 3, '♥', {
        fontFamily: 'monospace',
        fontSize: '13px',
        fontStyle: 'bold',
        color: '#f87171',
        stroke: '#02040a',
        strokeThickness: 2,
      })
      .setOrigin(0, 0);

    const statusText = scene.add
      .text(barX + BAR_WIDTH + 22, barY - 2, '', {
        fontFamily: 'monospace',
        fontSize: '10px',
        fontStyle: 'bold',
        color: '#cbd5e1',
        stroke: '#02040a',
        strokeThickness: 2,
      })
      .setOrigin(0, 0);

    container.add([swatch, name, barTrack, barFill, bossIcon, statusText]);
    parent?.add(container);
    rowVisuals.push({ container, swatch, name, barTrack, barFill, bossIcon, statusText });
  }

  const allTexts = [title, ...rowVisuals.flatMap((r) => [r.name, r.bossIcon, r.statusText])];
  const detachCrispText = applyCrispText(scene, allTexts);

  let lastFingerprint = '';
  let lastVisible = true;

  function setPanelVisible(visible: boolean): void {
    panel.setVisible(visible);
    title.setVisible(visible);
    for (const r of rowVisuals) r.container.setVisible(visible);
  }

  function fingerprintFor(rows: FamilyRow[]): string {
    const parts = rows.map(
      (r) => `${r.familyId}:${Math.round(r.relation)}:${r.band}:${r.bossDefeated ? '1' : '0'}`,
    );
    return parts.join('|');
  }

  function renderRow(rv: RowVisuals, row: FamilyRow | null): void {
    if (row === null) {
      rv.container.setVisible(false);
      return;
    }
    rv.container.setVisible(true);
    rv.swatch.setFillStyle(row.hudColor);
    // Truncate long names to keep the row compact.
    const displayName = row.name.length > 18 ? row.name.slice(0, 17) + '…' : row.name;
    rv.name.setText(displayName);

    const inner = BAR_WIDTH - 2;
    const pct = Math.max(0, Math.min(1, row.relation / 100));
    const w = Math.max(1, Math.round(inner * pct));
    rv.barFill.setSize(w, BAR_HEIGHT - 2);
    rv.barFill.setFillStyle(row.barColor);

    if (row.bossDefeated) {
      rv.bossIcon.setText('☠');
      rv.bossIcon.setColor('#94a3b8');
    } else {
      rv.bossIcon.setText('♥');
      rv.bossIcon.setColor('#f87171');
    }

    rv.statusText.setText(row.statusTag);
    if (row.statusTag === 'Allied') rv.statusText.setColor('#86efac');
    else if (row.statusTag === 'At War') rv.statusText.setColor('#fca5a5');
    else rv.statusText.setColor('#cbd5e1');
  }

  function sync(world: GameWorld): void {
    const shouldShow = world.floor2State !== null;
    if (shouldShow !== lastVisible) {
      setPanelVisible(shouldShow);
      lastVisible = shouldShow;
      if (!shouldShow) {
        lastFingerprint = '';
        return;
      }
    }
    if (!shouldShow) return;

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

  function destroy(): void {
    detachCrispText();
    for (const r of rowVisuals) r.container.destroy();
    title.destroy();
    panel.destroy();
  }

  return { sync, destroy };
}
