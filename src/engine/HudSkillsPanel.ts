/**
 * HudSkillsPanel — compact panel showing active weapon's class and type skill levels.
 *
 * Reads world.activeWeaponId to determine which skills to display:
 *   - Weapon CLASS skill (damage bonus, levels slowly)
 *   - Weapon TYPE skill (accuracy bonus, levels faster)
 *
 * Positioned in the bottom-right corner. Hidden when no data-driven weapon is active.
 */
import Phaser from 'phaser';
import type { GameWorld } from '../core/world.js';
import { GAME } from '../shared/constants.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { SKILL_HARD_CAP } from '../shared/skills.js';
import { PIXEL_UI, PIXEL_UI_DEPTH, createBeveledPanel } from './pixel-ui.js';

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

const DEPTH = PIXEL_UI_DEPTH.content;
const PANEL_W = 180;
const BAR_H = 8;
const BAR_W = PANEL_W - 36;
const ROW_H = 26;
const PANEL_H = 16 + ROW_H * 2 + 8;
const PANEL_X = GAME.WIDTH - PANEL_W - 12;
const PANEL_Y = GAME.HEIGHT - PANEL_H - 152; // above ability bar

const LABEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Arial, sans-serif',
  fontSize: '10px',
  color: '#94a3b8',
};
const LEVEL_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Arial, sans-serif',
  fontSize: '10px',
  fontStyle: 'bold',
  color: '#f0f0f0',
};
const TITLE_STYLE: Phaser.Types.GameObjects.Text.TextStyle = {
  fontFamily: 'Arial, sans-serif',
  fontSize: '9px',
  fontStyle: 'bold',
  color: '#64748b',
};

// ---------------------------------------------------------------------------
// Bar colors
// ---------------------------------------------------------------------------
const CLASS_BAR_COLOR = 0xe2543b; // warm red — damage class
const TYPE_BAR_COLOR = 0x4ea8ff; // blue — accuracy type

export interface HudSkillsPanelOptions {
  parent?: Phaser.GameObjects.Container;
  x?: number;
  y?: number;
}

interface SkillRow {
  label: Phaser.GameObjects.Text;
  level: Phaser.GameObjects.Text;
  track: Phaser.GameObjects.Rectangle;
  fill: Phaser.GameObjects.Rectangle;
}

function makeRow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  barColor: number,
  parent: Phaser.GameObjects.Container | undefined,
): SkillRow {
  const label = scene.add
    .text(x, y, '', LABEL_STYLE)
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setOrigin(0, 0);
  parent?.add(label);

  const barY = y + 13;

  const track = scene.add
    .rectangle(x, barY + BAR_H / 2, BAR_W, BAR_H, PIXEL_UI.trackFill)
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setOrigin(0, 0.5)
    .setStrokeStyle(1, PIXEL_UI.bevelDark);
  parent?.add(track);

  const fill = scene.add
    .rectangle(x, barY + BAR_H / 2, 0, BAR_H - 2, barColor)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1)
    .setOrigin(0, 0.5);
  parent?.add(fill);

  const level = scene.add
    .text(x + BAR_W + 4, barY + BAR_H / 2, '', LEVEL_STYLE)
    .setScrollFactor(0)
    .setDepth(DEPTH + 1)
    .setOrigin(0, 0.5);
  parent?.add(level);

  return { label, level, track, fill };
}

export function createHudSkillsPanel(
  scene: Phaser.Scene,
  options: HudSkillsPanelOptions = {},
): {
  sync(world: GameWorld, playerEid: number): void;
  destroy(): void;
} {
  const panelX = options.x ?? PANEL_X;
  const panelY = options.y ?? PANEL_Y;
  const parent = options.parent;

  const panel = createBeveledPanel(scene, panelX, panelY, PANEL_W, PANEL_H, { parent });

  const title = scene.add
    .text(panelX + 8, panelY + 5, 'SKILLS', TITLE_STYLE)
    .setScrollFactor(0)
    .setDepth(DEPTH)
    .setOrigin(0, 0);
  parent?.add(title);

  const innerX = panelX + 8;
  const classRow = makeRow(scene, innerX, panelY + 16, CLASS_BAR_COLOR, parent);
  const typeRow = makeRow(scene, innerX, panelY + 16 + ROW_H, TYPE_BAR_COLOR, parent);

  function setRowData(row: SkillRow, name: string, level: number, cap: number): void {
    row.label.setText(name.toUpperCase());
    row.level.setText(`${level}`);
    const pct = cap > 0 ? Math.min(1, level / cap) : 0;
    row.fill.setDisplaySize(Math.max(0, Math.round((BAR_W - 2) * pct)), BAR_H - 2);
  }

  function hideRow(row: SkillRow): void {
    row.label.setText('');
    row.level.setText('');
    row.fill.setDisplaySize(0, BAR_H - 2);
  }

  function setVisible(visible: boolean): void {
    panel.setVisible(visible);
    title.setVisible(visible);
    classRow.label.setVisible(visible);
    classRow.level.setVisible(visible);
    classRow.track.setVisible(visible);
    classRow.fill.setVisible(visible);
    typeRow.label.setVisible(visible);
    typeRow.level.setVisible(visible);
    typeRow.track.setVisible(visible);
    typeRow.fill.setVisible(visible);
  }

  function sync(world: GameWorld, playerEid: number): void {
    const weaponId = world.activeWeaponId;

    if (weaponId === null) {
      setVisible(false);
      return;
    }

    setVisible(true);

    const def = getWeaponDef(weaponId);
    const entitySkills = world.skillStatesByEntity.get(playerEid);

    // Class skill row
    if (def?.classSkillId) {
      const state = entitySkills?.get(def.classSkillId) ?? world.playerSkills.get(def.classSkillId);
      const level = state?.level ?? 0;
      setRowData(classRow, def.classSkillId, level, SKILL_HARD_CAP);
    } else {
      hideRow(classRow);
    }

    // Type skill row
    if (def?.typeSkillId) {
      const state = entitySkills?.get(def.typeSkillId) ?? world.playerSkills.get(def.typeSkillId);
      const level = state?.level ?? 0;
      setRowData(typeRow, def.typeSkillId, level, SKILL_HARD_CAP);
    } else {
      hideRow(typeRow);
    }
  }

  function destroy(): void {
    panel.destroy();
    title.destroy();
    classRow.label.destroy();
    classRow.level.destroy();
    classRow.track.destroy();
    classRow.fill.destroy();
    typeRow.label.destroy();
    typeRow.level.destroy();
    typeRow.track.destroy();
    typeRow.fill.destroy();
  }

  // Start hidden until sync is called
  setVisible(false);

  return { sync, destroy };
}
