/**
 * HudSkillTracker — compact weapon + spell skills readout in the bottom-left
 * HUD column.
 *
 * Shows the active weapon's class skill (broad style, slow-levelling, damage bonus)
 * and type skill (specific family, fast-levelling, accuracy bonus) with their
 * current level and a small progress bar toward the next level threshold.
 *
 * Also appends up to `SPELL_ROW_CAP` rows for the player's currently equipped
 * spells (in equip order) that have a matching spell skill, so spell-skill
 * progress — otherwise invisible anywhere in the game — is visible in the
 * same always-on combat HUD widget (see `hud-spell-skill-rows.ts` for the
 * pure row-selection logic). When more trackable spell skills are equipped
 * than there are rows, a "+N" overflow indicator appears in the title strip
 * rather than silently dropping the rest.
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
import { SPELL_SKILL_THRESHOLDS } from '../shared/spell-skills.js';
import { getAbilityPresentation } from '../shared/ability-presentation.js';
import { PIXEL_UI, PIXEL_UI_DEPTH, createBeveledPanel } from './pixel-ui.js';
import { SKILL_HARD_CAP, SKILL_NATURAL_CAP } from '../shared/skills.js';
import { applyCrispText } from './ui-scale.js';
import { BLUE_STEEL, hex } from './ui-theme.js';
import { countMatchingSpellSkills, selectSpellSkillRows } from './hud-spell-skill-rows.js';

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

/** Max additional rows reserved for the player's equipped spells' skills. */
const SPELL_ROW_CAP = 2;
/** Total rows: weapon class + weapon type + up to SPELL_ROW_CAP spell rows. */
const ROW_COUNT = 2 + SPELL_ROW_CAP;

const PANEL_W = PAD + NAME_W + 4 + LV_W + 4 + BAR_W + PAD;
const PANEL_H = PAD + TITLE_H + ROW_GAP + ROW_COUNT * (ROW_H + ROW_GAP) + PAD - ROW_GAP;

const PANEL_X = 16;
/** Sits 8px above the loot counter panel (which starts at GAME.HEIGHT - 124). */
const PANEL_Y = GAME.HEIGHT - 124 - 8 - PANEL_H;

const COLORS = {
  title: hex(BLUE_STEEL.accent),
  titleStrip: BLUE_STEEL.sectionHeader,
  classSkill: '#86efac',
  typeSkill: '#93c5fd',
  spellSkill: '#c084fc',
  barBg: PIXEL_UI.trackFill,
  barClass: 0x46d369,
  barType: 0x60a5fa,
  barSpell: 0xa855f7,
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
    .text(PANEL_X + PAD, PANEL_Y + 2 + TITLE_H / 2, 'SKILLS', {
      fontFamily: 'monospace',
      fontSize: '10px',
      fontStyle: 'bold',
      color: COLORS.title,
    })
    .setName('hud-skill-title-text')
    .setOrigin(0, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);

  // Overflow indicator ("+N") shown when the player has equipped more
  // trackable spell skills than there are spell rows to display, so the row
  // cap is visible instead of silently hiding skills.
  const overflowText = scene.add
    .text(PANEL_X + PANEL_W - PAD, PANEL_Y + 2 + TITLE_H / 2, '', {
      fontFamily: 'monospace',
      fontSize: '9px',
      fontStyle: 'bold',
      color: COLORS.spellSkill,
    })
    .setName('hud-skill-overflow-text')
    .setOrigin(1, 0.5)
    .setScrollFactor(0)
    .setDepth(PIXEL_UI_DEPTH.content);
  parent?.add([titleStrip, titleText, overflowText]);

  // Row factory: returns text nodes + bar fill for one skill row
  function makeSkillRow(
    rowIndex: number,
    barColor: number,
    labelColor: string,
    debugName: string,
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
      .setName(`hud-skill-${debugName}-name-text`)
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
      .setName(`hud-skill-${debugName}-level`)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content);

    const barX = PANEL_X + PAD + NAME_W + 4 + LV_W + 4;
    const barBgRect = scene.add
      .rectangle(barX, cy, BAR_W, BAR_H, COLORS.barBg, 1)
      .setName(`hud-skill-${debugName}-bar-bg`)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content);

    const barFillRect = scene.add
      .rectangle(barX, cy, 1, BAR_H, barColor, 1)
      .setName(`hud-skill-${debugName}-bar-fill`)
      .setOrigin(0, 0.5)
      .setScrollFactor(0)
      .setDepth(PIXEL_UI_DEPTH.content + 1);

    parent?.add([nameText, levelText, barBgRect, barFillRect]);

    return { nameText, levelText, barFill: barFillRect, barBg: barBgRect };
  }

  const classRow = makeSkillRow(0, COLORS.barClass, COLORS.classSkill, 'class');
  const typeRow = makeSkillRow(1, COLORS.barType, COLORS.typeSkill, 'type');
  const spellRows = Array.from({ length: SPELL_ROW_CAP }, (_, i) =>
    makeSkillRow(2 + i, COLORS.barSpell, COLORS.spellSkill, `spell-${i}`),
  );
  const detachCrispText = applyCrispText(scene, [
    titleText,
    overflowText,
    classRow.nameText,
    classRow.levelText,
    typeRow.nameText,
    typeRow.levelText,
    ...spellRows.map((row) => row.nameText),
    ...spellRows.map((row) => row.levelText),
  ]);

  function setRowVisible(row: ReturnType<typeof makeSkillRow>, visible: boolean): void {
    row.nameText.setVisible(visible);
    row.levelText.setVisible(visible);
    row.barBg.setVisible(visible);
    row.barFill.setVisible(visible);
  }

  function setAllVisible(visible: boolean): void {
    panel.setVisible(visible);
    titleStrip.setVisible(visible);
    titleText.setVisible(visible);
    overflowText.setVisible(visible);
    for (const row of [classRow, typeRow, ...spellRows]) {
      setRowVisible(row, visible);
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

    // Spell skills — up to SPELL_ROW_CAP of the player's currently equipped
    // spells (in equip order) that have a matching spell skill. When more
    // trackable spells are equipped than there are rows, show a "+N" overflow
    // indicator rather than silently dropping them.
    const equippedActiveAbilityIds =
      world.abilityStatesByEntity.get(playerEid)?.equippedActiveAbilityIds ?? [];
    const spellSkillEntries = selectSpellSkillRows(equippedActiveAbilityIds, spellRows.length);
    for (let i = 0; i < spellRows.length; i++) {
      const row = spellRows[i]!;
      const entry = spellSkillEntries[i];
      if (entry === undefined) {
        setRowVisible(row, false);
        continue;
      }
      setRowVisible(row, true);
      const presentation = getAbilityPresentation(entry.spellId);
      updateRow(
        row,
        entry.skillId,
        presentation?.name ?? entry.spellId,
        SPELL_SKILL_THRESHOLDS,
        world,
        playerEid,
      );
    }

    const overflowCount = countMatchingSpellSkills(equippedActiveAbilityIds) - spellRows.length;
    overflowText.setText(overflowCount > 0 ? `+${overflowCount}` : '');
  }

  function destroy(): void {
    detachCrispText();
    panel.destroy();
    panelBounds.destroy();
    titleStrip.destroy();
    titleText.destroy();
    overflowText.destroy();
    for (const row of [classRow, typeRow, ...spellRows]) {
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
