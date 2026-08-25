/**
 * HudFloor3Party — Floor-3 party HUD (game-design §15 surfaces 4, 6, 7, 8).
 *
 * One row per party Companion: slot chip, form name + level, HP bar, KO tag,
 * affinity swatch, fighting-style glyph, engagement matchup chevron, and the
 * command-charge pip. Below the rows a transient notice strip announces
 * level-ups, evolutions, and newly learned abilities.
 *
 * All view state comes from the pure resolvers in `floor3-*-state.ts`; this
 * module only draws them and owns the UI-side command bookkeeping, so mounting
 * the HUD can never perturb the simulation.
 *
 * Reactive: a snapshot fingerprint acts as a dirty flag, so a full row
 * re-render only happens when something actually changed.
 *
 * Engine layer only (Phaser allowed). No imports from game/labs.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { PIXEL_UI, PIXEL_UI_DEPTH, createBeveledPanel } from './pixel-ui.js';
import { applyCrispText, type ScreenBounds } from './ui-scale.js';
import { BLUE_STEEL, MIN_TEXT_RESOLUTION, hex } from './ui-theme.js';
import {
  resolveFloor3PartyRows,
  shouldShowFloor3Party,
  type Floor3PartyRow,
  type PartyMemberKey,
} from './floor3-party-state.js';
import {
  MATCHUP_COLORS,
  resolvePartyMatchups,
  type Floor3Matchup,
  type MatchupTag,
} from './floor3-matchup-state.js';
import {
  captureFloor3PartyProgress,
  diffFloor3PartyProgress,
  snapshotFromRows,
  type Floor3ProgressNotice,
  type Floor3ProgressSnapshot,
} from './floor3-level-up-notice-state.js';
import {
  commandCapacity,
  chargesInUse,
  createFloor3CommandState,
  issueCompanionCommand,
  resolveCommandSlots,
  type CommandResult,
  type CommandSlotState,
  type Floor3CommandState,
} from './floor3-ability-command-state.js';

const PANEL_WIDTH = 236;
const TITLE_H = 22;
const ROW_H = 26;
const ROW_GAP = 2;
const MAX_ROWS = 6;
const PANEL_PAD = 8;
const NOTICE_H = 13;
const MAX_NOTICES = 3;

const SWATCH_SIZE = 10;
const BAR_WIDTH = 64;
const BAR_HEIGHT = 6;
const PIP_WIDTH = 22;
const PIP_HEIGHT = 6;
const FONT_FAMILY = '"Press Start 2P", "Courier New", monospace';

/** Panel anchored on the left edge, below the Floor-2+ quest tracker. */
const PANEL_MARGIN_LEFT = 12;
const PANEL_MARGIN_TOP = 290;

/** Frames a progress notice stays on screen (≈4s at 60fps). */
export const NOTICE_TTL_FRAMES = 240;

const MATCHUP_GLYPHS: Readonly<Record<MatchupTag, string>> = Object.freeze({
  strong: '^',
  weak: 'v',
  neutral: '-',
});

interface RowVisuals {
  container: Phaser.GameObjects.Container;
  background: Phaser.GameObjects.Rectangle;
  swatch: Phaser.GameObjects.Rectangle;
  name: Phaser.GameObjects.Text;
  hpTrack: Phaser.GameObjects.Rectangle;
  hpFill: Phaser.GameObjects.Rectangle;
  statusText: Phaser.GameObjects.Text;
  matchupText: Phaser.GameObjects.Text;
  pipTrack: Phaser.GameObjects.Rectangle;
  pipFill: Phaser.GameObjects.Rectangle;
}

/** Per-row read-back used by labs and deterministic tests. */
export interface Floor3PartyRowView {
  readonly slot: number;
  readonly name: string;
  readonly hpFraction: number;
  readonly knockedOut: boolean;
  readonly affinityColor: number;
  readonly styleGlyph: string;
  readonly matchup: MatchupTag | null;
  readonly commandReady: boolean;
  readonly cooldownFraction: number;
}

export interface HudFloor3PartyState {
  readonly visible: boolean;
  readonly bounds: ScreenBounds | null;
  readonly rows: readonly Floor3PartyRowView[];
  readonly notices: readonly string[];
  readonly commandCapacity: number;
  readonly commandsInUse: number;
}

export interface HudFloor3PartyOptions {
  parent?: Phaser.GameObjects.Container;
  /** Test/lab hook — share command bookkeeping with a lab surface. */
  commandState?: Floor3CommandState;
}

function hpColor(fraction: number): number {
  if (fraction <= 0.25) return PIXEL_UI.hpLow;
  if (fraction <= 0.6) return PIXEL_UI.hpMid;
  return PIXEL_UI.hpHigh;
}

function rowLabel(row: Floor3PartyRow): string {
  const name = row.formName.length > 11 ? `${row.formName.slice(0, 10)}.` : row.formName;
  return `${row.slot + 1} ${name} L${row.level}`;
}

export function createHudFloor3Party(
  scene: Phaser.Scene,
  options: HudFloor3PartyOptions = {},
): {
  sync(world: GameWorld, playerEid: number): void;
  setVisible(visible: boolean): void;
  getState(): HudFloor3PartyState;
  issueCommand(world: GameWorld, playerEid: number, slot?: number): CommandResult;
  destroy(): void;
} {
  const commandState = options.commandState ?? createFloor3CommandState();

  const panelHeight =
    PANEL_PAD + TITLE_H + MAX_ROWS * (ROW_H + ROW_GAP) + MAX_NOTICES * NOTICE_H + PANEL_PAD;
  const root = scene.add
    .container(PANEL_MARGIN_LEFT, PANEL_MARGIN_TOP)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.panel);
  options.parent?.add(root);

  const panel = createBeveledPanel(scene, 0, 0, PANEL_WIDTH, panelHeight, {
    parent: root,
    fill: BLUE_STEEL.panelBg,
    highlight: BLUE_STEEL.panelBorder,
    shadow: PIXEL_UI.bevelDark,
    border: PIXEL_UI.border,
    fillAlpha: 0.97,
  });

  const titleFrame = scene.add
    .rectangle(PANEL_PAD - 2, 4, PANEL_WIDTH - PANEL_PAD * 2 + 4, 16, BLUE_STEEL.sectionHeader)
    .setOrigin(0, 0)
    .setStrokeStyle(1, BLUE_STEEL.panelBorder)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add(titleFrame);

  const title = scene.add
    .text(PANEL_PAD + 2, 7, 'PARTY', {
      fontFamily: FONT_FAMILY,
      fontSize: '9px',
      fontStyle: 'bold',
      color: hex(BLUE_STEEL.textPrimary),
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(0, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add(title);

  const capacityText = scene.add
    .text(PANEL_WIDTH - PANEL_PAD - 2, 7, '', {
      fontFamily: FONT_FAMILY,
      fontSize: '8px',
      color: hex(BLUE_STEEL.textSecondary),
      stroke: '#02040a',
      strokeThickness: 2,
      padding: { top: 3, bottom: 3 },
    })
    .setOrigin(1, 0)
    .setDepth(PIXEL_UI_DEPTH.content);
  root.add(capacityText);

  const rowStartY = PANEL_PAD + TITLE_H;
  const rowVisuals: RowVisuals[] = [];

  for (let i = 0; i < MAX_ROWS; i += 1) {
    const container = scene.add
      .container(PANEL_PAD, rowStartY + i * (ROW_H + ROW_GAP))
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content);

    const background = scene.add
      .rectangle(0, 0, PANEL_WIDTH - PANEL_PAD * 2, ROW_H, i % 2 === 0 ? 0x394c74 : 0x35476d)
      .setOrigin(0, 0)
      .setStrokeStyle(1, BLUE_STEEL.panelBorder);
    const swatch = scene.add
      .rectangle(3, 4, SWATCH_SIZE, SWATCH_SIZE, 0x64748b)
      .setOrigin(0, 0)
      .setStrokeStyle(1, PIXEL_UI.border);

    const name = scene.add
      .text(SWATCH_SIZE + 8, 2, '', {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        fontStyle: 'bold',
        color: hex(BLUE_STEEL.textPrimary),
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 3, bottom: 3 },
      })
      .setOrigin(0, 0);

    const hpTrack = scene.add
      .rectangle(SWATCH_SIZE + 8, ROW_H - 9, BAR_WIDTH, BAR_HEIGHT, PIXEL_UI.trackFill)
      .setOrigin(0, 0)
      .setStrokeStyle(1, PIXEL_UI.border);
    const hpFill = scene.add
      .rectangle(SWATCH_SIZE + 9, ROW_H - 8, BAR_WIDTH - 2, BAR_HEIGHT - 2, PIXEL_UI.hpHigh)
      .setOrigin(0, 0);

    const statusText = scene.add
      .text(SWATCH_SIZE + BAR_WIDTH + 14, ROW_H - 11, '', {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: hex(BLUE_STEEL.textSecondary),
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 2, bottom: 2 },
      })
      .setOrigin(0, 0);

    const matchupText = scene.add
      .text(PANEL_WIDTH - PANEL_PAD * 2 - 6, 2, '', {
        fontFamily: FONT_FAMILY,
        fontSize: '9px',
        fontStyle: 'bold',
        color: hex(BLUE_STEEL.textSecondary),
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 3, bottom: 3 },
      })
      .setOrigin(1, 0);

    const pipX = PANEL_WIDTH - PANEL_PAD * 2 - PIP_WIDTH - 4;
    const pipTrack = scene.add
      .rectangle(pipX, ROW_H - 9, PIP_WIDTH, PIP_HEIGHT, PIXEL_UI.trackFill)
      .setOrigin(0, 0)
      .setStrokeStyle(1, PIXEL_UI.border);
    const pipFill = scene.add
      .rectangle(pipX + 1, ROW_H - 8, PIP_WIDTH - 2, PIP_HEIGHT - 2, BLUE_STEEL.accent)
      .setOrigin(0, 0);

    container.add([
      background,
      swatch,
      name,
      hpTrack,
      hpFill,
      statusText,
      matchupText,
      pipTrack,
      pipFill,
    ]);
    root.add(container);
    rowVisuals.push({
      container,
      background,
      swatch,
      name,
      hpTrack,
      hpFill,
      statusText,
      matchupText,
      pipTrack,
      pipFill,
    });
  }

  const noticeStartY = rowStartY + MAX_ROWS * (ROW_H + ROW_GAP) + 2;
  const noticeTexts: Phaser.GameObjects.Text[] = [];
  for (let i = 0; i < MAX_NOTICES; i += 1) {
    const text = scene.add
      .text(PANEL_PAD, noticeStartY + i * NOTICE_H, '', {
        fontFamily: FONT_FAMILY,
        fontSize: '8px',
        color: hex(BLUE_STEEL.accent),
        stroke: '#02040a',
        strokeThickness: 2,
        padding: { top: 2, bottom: 2 },
      })
      .setOrigin(0, 0)
      .setDepth(PIXEL_UI_DEPTH.content);
    root.add(text);
    noticeTexts.push(text);
  }

  const detachCrispText = applyCrispText(
    scene,
    [
      title,
      capacityText,
      ...noticeTexts,
      ...rowVisuals.flatMap((r) => [r.name, r.statusText, r.matchupText]),
    ],
    MIN_TEXT_RESOLUTION + 2,
  );

  let masterVisible = true;
  let logicallyVisible = false;
  let lastFingerprint = '';
  let progressSnapshot: Floor3ProgressSnapshot = new Map();
  let activeNotices: { notice: Floor3ProgressNotice; expiresAtFrame: number }[] = [];
  let viewRows: Floor3PartyRowView[] = [];
  let capacity = 0;
  let inUse = 0;

  function setPanelVisible(visible: boolean): void {
    const effective = visible && masterVisible;
    panel.setVisible(effective);
    titleFrame.setVisible(effective);
    title.setVisible(effective);
    capacityText.setVisible(effective);
    for (const r of rowVisuals)
      r.container.setVisible(effective && r.container.getData('used') === true);
    for (const t of noticeTexts) t.setVisible(effective && t.text !== '');
  }

  function fingerprintFor(
    rows: readonly Floor3PartyRow[],
    slots: readonly CommandSlotState[],
    matchups: ReadonlyMap<PartyMemberKey, Floor3Matchup>,
    noticeLines: readonly string[],
  ): string {
    const rowParts = rows.map((row, index) => {
      const slot = slots[index];
      const matchup = matchups.get(row.key);
      return [
        row.key,
        row.formName,
        row.level,
        Math.round(row.hpFraction * 100),
        row.knockedOut ? '1' : '0',
        matchup?.tag ?? '-',
        slot === undefined
          ? '-'
          : `${slot.ready ? '1' : '0'}:${Math.round(slot.cooldownFraction * 20)}`,
      ].join(':');
    });
    return `${capacity}/${inUse}|${rowParts.join('|')}|${noticeLines.join('~')}`;
  }

  function renderRow(
    rv: RowVisuals,
    row: Floor3PartyRow | undefined,
    slot: CommandSlotState | undefined,
    matchup: Floor3Matchup | undefined,
  ): Floor3PartyRowView | null {
    if (row === undefined) {
      rv.container.setData('used', false);
      rv.container.setVisible(false);
      return null;
    }
    rv.container.setData('used', true);
    rv.container.setVisible(masterVisible && logicallyVisible);
    rv.swatch.setFillStyle(row.affinityColor);
    rv.name.setText(rowLabel(row));

    const inner = BAR_WIDTH - 2;
    const width = Math.max(1, Math.round(inner * Math.max(0, Math.min(1, row.hpFraction))));
    rv.hpFill.setSize(width, BAR_HEIGHT - 2);
    rv.hpFill.setFillStyle(row.knockedOut ? PIXEL_UI.hpLow : hpColor(row.hpFraction));
    rv.statusText.setText(row.knockedOut ? 'KO' : row.styleGlyph);
    rv.statusText.setColor(row.knockedOut ? '#f87171' : hex(BLUE_STEEL.textSecondary));

    if (matchup === undefined) {
      rv.matchupText.setText('');
    } else {
      rv.matchupText.setText(MATCHUP_GLYPHS[matchup.tag]);
      rv.matchupText.setColor(hex(MATCHUP_COLORS[matchup.tag]));
    }

    const fraction = slot?.cooldownFraction ?? 1;
    const pipWidth = Math.max(1, Math.round((PIP_WIDTH - 2) * Math.max(0, Math.min(1, fraction))));
    rv.pipFill.setSize(pipWidth, PIP_HEIGHT - 2);
    rv.pipFill.setFillStyle(slot?.ready === true ? BLUE_STEEL.accent : PIXEL_UI.bevelDark);

    return {
      slot: row.slot,
      name: rowLabel(row),
      hpFraction: row.hpFraction,
      knockedOut: row.knockedOut,
      affinityColor: row.affinityColor,
      styleGlyph: row.styleGlyph,
      matchup: matchup?.tag ?? null,
      commandReady: slot?.ready ?? false,
      cooldownFraction: fraction,
    };
  }

  function sync(world: GameWorld, playerEid: number): void {
    logicallyVisible = shouldShowFloor3Party(world);
    if (!logicallyVisible || !masterVisible) {
      setPanelVisible(false);
      if (!logicallyVisible) {
        viewRows = [];
      }
      return;
    }

    const rows = resolveFloor3PartyRows(world);
    const frame = world.frameCount;

    const fresh = diffFloor3PartyProgress(progressSnapshot, snapshotFromRows(rows));
    progressSnapshot = captureFloor3PartyProgress(world);
    if (fresh.length > 0) {
      activeNotices = [
        ...activeNotices,
        ...fresh.map((notice) => ({ notice, expiresAtFrame: frame + NOTICE_TTL_FRAMES })),
      ].slice(-MAX_NOTICES);
    }
    // A rewound frame counter (new floor / restarted lab) must not strand a notice.
    activeNotices = activeNotices.filter(
      (entry) => frame < entry.expiresAtFrame && entry.expiresAtFrame - frame <= NOTICE_TTL_FRAMES,
    );

    const playerLevel = world.playerLevel.level;
    const slots = resolveCommandSlots(commandState, rows, frame, playerLevel);
    const matchups = resolvePartyMatchups(world, rows);
    capacity = commandCapacity(playerLevel);
    inUse = chargesInUse(commandState, rows, frame);
    const noticeLines = activeNotices.map((entry) => entry.notice.text);

    setPanelVisible(true);

    const fingerprint = fingerprintFor(rows, slots, matchups, noticeLines);
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;

    capacityText.setText(`CMD ${capacity - inUse}/${capacity}`);
    viewRows = [];
    for (let i = 0; i < MAX_ROWS; i += 1) {
      const row = rows[i];
      const view = renderRow(
        rowVisuals[i]!,
        row,
        slots[i],
        row === undefined ? undefined : matchups.get(row.key),
      );
      if (view !== null) viewRows.push(view);
    }
    for (let i = 0; i < MAX_NOTICES; i += 1) {
      const text = noticeTexts[i]!;
      text.setText(noticeLines[i] ?? '');
      text.setVisible(noticeLines[i] !== undefined);
    }
    void playerEid;
  }

  function issueCommand(world: GameWorld, playerEid: number, slot?: number): CommandResult {
    void playerEid;
    if (!shouldShowFloor3Party(world)) {
      return { accepted: false, rejection: 'empty-party' };
    }
    const rows = resolveFloor3PartyRows(world);
    const result = issueCompanionCommand(
      commandState,
      rows,
      world.frameCount,
      world.playerLevel.level,
      slot,
    );
    // Force the next sync to redraw the pips even if nothing else changed.
    lastFingerprint = '';
    return result;
  }

  function setVisible(visible: boolean): void {
    masterVisible = visible;
    setPanelVisible(logicallyVisible);
  }

  function getState(): HudFloor3PartyState {
    const bounds: ScreenBounds | null =
      logicallyVisible && masterVisible
        ? {
            x: PANEL_MARGIN_LEFT,
            y: PANEL_MARGIN_TOP,
            width: PANEL_WIDTH,
            height: panelHeight,
          }
        : null;
    return {
      visible: logicallyVisible && masterVisible,
      bounds,
      rows: viewRows,
      notices: activeNotices.map((entry) => entry.notice.text),
      commandCapacity: capacity,
      commandsInUse: inUse,
    };
  }

  function destroy(): void {
    detachCrispText();
    root.destroy(true);
  }

  setPanelVisible(false);

  return { sync, setVisible, getState, issueCommand, destroy };
}
