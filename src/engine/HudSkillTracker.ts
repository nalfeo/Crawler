/**
 * HudSkillTracker — compact weapon-skills readout in the bottom-left HUD column.
 *
 * Shows the active weapon's class skill (broad style, slow-levelling, damage bonus)
 * and type skill (specific family, fast-levelling, accuracy bonus) with their
 * current level and a small progress bar toward the next level threshold.
 *
 * Reads the active weapon from core active-weapon state, looks up its WeaponDef
 * for the skill IDs, then reads SkillState from
 * `world.skillStatesByEntity` (v2 path) falling back to `world.playerSkills`.
 *
 * Hidden when no weapon is selected or no skill state exists.
 * Engine layer only (Phaser allowed). No imports from game/labs.
 */
import Phaser from 'phaser';
import { getActiveWeaponDef } from '../core/active-weapon.js';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { CLASS_SKILL_THRESHOLDS, TYPE_SKILL_THRESHOLDS } from '../shared/weapon-skills.js';
import { PIXEL_UI, PIXEL_UI_DEPTH, createBeveledPanel } from './pixel-ui.js';
import { SKILL_HARD_CAP, SKILL_NATURAL_CAP } from '../shared/skills.js';
import { applyCrispText } from './ui-scale.js';
import { BLUE_STEEL, hex } from './ui-theme.js';

// ---------------------------------------------------------------------------
// Layout constants
// ---------------------------------------------------------------------------

const PAD = 6;
const ROW_H = 14;
const ROW_GAP = 4;
const TITLE_H = 16;
/** Width for skill name label (truncated). */
const NAME_W = 78;
/** Width for "Lv XX" text. */
const LV_W = 34;
/** Width for progress bar. */
const BAR_W = 64;
const BAR_H = 6;

const PANEL_W = PAD + NAME_W + 4 + LV_W + 4 + BAR_W + PAD;
const PANEL_H = PAD + TITLE_H + ROW_GAP + ROW_H + ROW_GAP + ROW_H + PAD;

const PANEL_X = 16;
/** Sits 8px above the loot counter panel (which starts at GAME.HEIGHT - 124). */
const PANEL_Y = GAME.HEIGHT - 124 - 8 - PANEL_H;

const COLORS = {
  title: hex(BLUE_STEEL.accent),
  titleStrip: BLUE_STEEL.sectionHeader,
  classSkill: '#86efac',
  typeSkill: '#93c5fd',
  barBg: PIXEL_UI.trackFill,
  barClass: 0x46d369,
  barType: 0x60a5fa,
  inactive: '#64748b',
} as const;

const truncateCache = new Map<string, string>();

function setTextWithinWidth(
  textObject: Phaser.GameObjects.Text,
  value: string,
  maxWidth: number,
): void {
  const cacheKey = `${value}|${maxWidth}`;
  const cached = truncateCache.get(cacheKey);
  if (cached !== undefined) {
    if (textObject.text !== cached) textObject.setText(cached);
    return;
  }

  textObject.setText(value);
  if (textObject.width <= maxWidth) {
    truncateCache.set(cacheKey, value);
    return;
  }

  const glyphs = Array.from(value);
  do {
    glyphs.pop();
    textObject.setText(`${glyphs.join('')}…`);
  } while (glyphs.length > 0 && textObject.width > maxWidth);

  truncateCache.set(cacheKey, textObject.text);
}

export function createHudSkillTracker(
  scene: Phaser.Scene,
  options: { parent?: Phaser.GameObjects.Container } = {},
): {
  sync(world: GameWorld, playerEid: number): void;
  destroy(): void;
} {
  const parent = options.parent;
  const panel = createBeveledPanel(scene, PANEL_X, PANEL_Y, PANEL_W, PANEL_H, { parent });
  const panelBounds = scene.add
    .zone(PANEL_X, PANEL_Y, PANEL_W, PANEL_H)
    .setOrigin(0, 0)
    .setName('hud-skill-panel-bounds');
  parent?.add(panelBounds);

  // Title strip
  const titleStrip = scene.add
    .rectangle(PANEL_X + 2, PANEL_Y + 2, PANEL_W - 4, TITLE_H, COLORS.titleStrip, 1)
    .setName('hud-skill-title-strip')
    .setOrigin(0, 0)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.panel + 1);

  const titleText = scene.add
    .text(PANEL_X + PAD, PANEL_Y + 2 + TITLE_H / 2, 'WEAPON SKILLS', {
      fontFamily: 'monospace',
      fontSize: '10px',
      fontStyle: 'bold',
      color: COLORS.title,
    })
    .setName('hud-skill-title-text')
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  parent?.add([titleStrip, titleText]);

  // Row factory: returns text nodes + bar fill for one skill row
  function makeSkillRow(
    rowIndex: number,
    barColor: number,
    labelColor: string,
  ): {
    nameText: Phaser.GameObjects.Text;
    levelText: Phaser.GameObjects.Text;
    barFill: Phaser.GameObjects.Rectangle;
    barBg: Phaser.GameObjects.Rectangle;
  } {
    const rowY = PANEL_Y + PAD + TITLE_H + ROW_GAP + rowIndex * (ROW_H + ROW_GAP);
    const cy = rowY + ROW_H / 2;

    const nameText = scene.add
      .text(PANEL_X + PAD, cy, '', {
        fontFamily: 'monospace',
        fontSize: '10px',
        color: labelColor,
      })
      .setName(`hud-skill-${rowIndex === 0 ? 'class' : 'type'}-name-text`)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content);

    const levelText = scene.add
      .text(PANEL_X + PAD + NAME_W + 4, cy, '', {
        fontFamily: 'monospace',
        fontSize: '10px',
        fontStyle: 'bold',
        color: labelColor,
      })
      .setName(`hud-skill-${rowIndex === 0 ? 'class' : 'type'}-level`)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content);

    const barX = PANEL_X + PAD + NAME_W + 4 + LV_W + 4;
    const barBgRect = scene.add
      .rectangle(barX, cy, BAR_W, BAR_H, COLORS.barBg, 1)
      .setName(`hud-skill-${rowIndex === 0 ? 'class' : 'type'}-bar-bg`)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content);

    const barFillRect = scene.add
      .rectangle(barX, cy, 1, BAR_H, barColor, 1)
      .setName(`hud-skill-${rowIndex === 0 ? 'class' : 'type'}-bar-fill`)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content + 1);

    parent?.add([nameText, levelText, barBgRect, barFillRect]);

    return { nameText, levelText, barFill: barFillRect, barBg: barBgRect };
  }

  const classRow = makeSkillRow(0, COLORS.barClass, COLORS.classSkill);
  const typeRow = makeSkillRow(1, COLORS.barType, COLORS.typeSkill);
  const detachCrispText = applyCrispText(scene, [
    titleText,
    classRow.nameText,
    classRow.levelText,
    typeRow.nameText,
    typeRow.levelText,
  ]);

  function setAllVisible(visible: boolean): void {
    panel.setVisible(visible);
    titleStrip.setVisible(visible);
    titleText.setVisible(visible);
    for (const row of [classRow, typeRow]) {
      row.nameText.setVisible(visible);
      row.levelText.setVisible(visible);
      row.barBg.setVisible(visible);
      row.barFill.setVisible(visible);
    }
  }

  function updateRow(
    row: ReturnType<typeof makeSkillRow>,
    skillId: string,
    skillName: string,
    thresholds: readonly number[],
    world: GameWorld,
    playerEid: number,
  ): void {
    const holderSkills = world.skillStatesByEntity.get(playerEid);
    const state = holderSkills?.get(skillId) ?? world.playerSkills.get(skillId);
    if (state === undefined) {
      setTextWithinWidth(row.nameText, skillName, NAME_W);
      row.levelText.setText('Lv 0');
      row.barFill.setSize(1, BAR_H);
      return;
    }

    const cap = Math.min(SKILL_NATURAL_CAP + state.itemBonus, SKILL_HARD_CAP);
    const level = state.level;

    setTextWithinWidth(row.nameText, skillName, NAME_W);
    row.levelText.setText(`Lv ${level}`);

    // Progress toward next level — 0 when at cap.
    if (level >= cap) {
      row.barFill.setSize(BAR_W, BAR_H);
    } else {
      const previousThreshold = level > 0 ? (thresholds[level - 1] ?? 0) : 0;
      const nextThreshold = thresholds[level];
      const progress =
        nextThreshold === undefined || nextThreshold <= previousThreshold
          ? 0
          : Math.min(
              1,
              Math.max(0, (state.usage - previousThreshold) / (nextThreshold - previousThreshold)),
            );
      row.barFill.setSize(Math.max(2, Math.round(BAR_W * progress)), BAR_H);
    }
  }

  function sync(world: GameWorld, playerEid: number): void {
    const def = getActiveWeaponDef(world);
    if (!def) {
      setAllVisible(false);
      return;
    }

    setAllVisible(true);

    // Class skill (damage focus)
    updateRow(
      classRow,
      def.weaponClassSkillId,
      def.weaponClassSkillId,
      CLASS_SKILL_THRESHOLDS,
      world,
      playerEid,
    );
    // Type skill (accuracy focus)
    updateRow(
      typeRow,
      def.weaponTypeSkillId,
      def.weaponTypeSkillId,
      TYPE_SKILL_THRESHOLDS,
      world,
      playerEid,
    );
  }

  function destroy(): void {
    detachCrispText();
    panel.destroy();
    panelBounds.destroy();
    titleStrip.destroy();
    titleText.destroy();
    for (const row of [classRow, typeRow]) {
      row.nameText.destroy();
      row.levelText.destroy();
      row.barBg.destroy();
      row.barFill.destroy();
    }
  }

  // Initially hidden until sync is called.
  setAllVisible(false);

  return { sync, destroy };
}
