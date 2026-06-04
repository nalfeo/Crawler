import { describe, expect, it } from 'vitest';
import { SHEETS, SPRITES, getSheet, getSprite } from '../../src/engine/sprites/index.js';

describe('sprite registry', () => {
  it('has unique sheet keys', () => {
    const keys = SHEETS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique sprite IDs', () => {
    const ids = SPRITES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every sprite references a registered sheet', () => {
    const sheetKeys = new Set(SHEETS.map((s) => s.key));
    for (const sprite of SPRITES) {
      expect(sheetKeys.has(sprite.sheetKey), `sprite ${sprite.id} sheet`).toBe(true);
    }
  });

  it('every sheet path lives under /assets/kenney/', () => {
    for (const sheet of SHEETS) {
      expect(sheet.path.startsWith('/assets/kenney/'), sheet.key).toBe(true);
    }
  });

  it('registers all 6 Kenney packs (characters + 4 Tiny packs + RPG pack)', () => {
    const expected = [
      'kenney-roguelike-characters',
      'kenney-tiny-dungeon',
      'kenney-tiny-town',
      'kenney-tiny-battle',
      'kenney-tiny-ski',
      'kenney-roguelike-rpg-pack',
    ];
    for (const key of expected) {
      const sheet = getSheet(key);
      expect(sheet, `missing sheet: ${key}`).toBeDefined();
      expect(sheet!.frameWidth).toBe(16);
      expect(sheet!.frameHeight).toBe(16);
      expect(sheet!.spacing).toBe(1);
    }
  });

  it('registers the tiny-dungeon sheet for weapon/item sprites', () => {
    const td = getSheet('kenney-tiny-dungeon');
    expect(td).toBeDefined();
    expect(td!.cols).toBe(12);
    expect(td!.path).toBe('/assets/kenney/tiny-dungeon/spritesheet.png');
  });

  it('every sheet declares a positive column count', () => {
    // Frame-index math (`frame % cols`, `frame / cols`) silently breaks
    // if cols is 0 or NaN. Pin it as an explicit invariant.
    for (const sheet of SHEETS) {
      expect(sheet.cols, `sheet ${sheet.key} cols`).toBeGreaterThan(0);
      expect(Number.isFinite(sheet.cols), `sheet ${sheet.key} cols finite`).toBe(true);
    }
  });

  it('every sprite frame index is non-negative', () => {
    for (const sprite of SPRITES) {
      const sheet = getSheet(sprite.sheetKey);
      expect(sheet, `sheet ${sprite.sheetKey}`).toBeDefined();
      expect(sprite.frame, `sprite ${sprite.id} frame`).toBeGreaterThanOrEqual(0);
    }
  });

  it('exposes a player and at least one enemy sprite', () => {
    expect(getSprite('player')).toBeDefined();
    const enemyIds = SPRITES.filter((s) => s.id.startsWith('enemy.')).map((s) => s.id);
    expect(enemyIds.length).toBeGreaterThan(0);
  });

  it('getSprite / getSheet return undefined for unknown ids', () => {
    expect(getSprite('does-not-exist')).toBeUndefined();
    expect(getSheet('does-not-exist')).toBeUndefined();
  });
});
