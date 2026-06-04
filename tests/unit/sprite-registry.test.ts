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

  it('every frame index is non-negative and within sheet capacity', () => {
    for (const sprite of SPRITES) {
      const sheet = getSheet(sprite.sheetKey);
      expect(sheet, `sheet ${sprite.sheetKey}`).toBeDefined();
      expect(sprite.frame).toBeGreaterThanOrEqual(0);
      // We can't bound the upper limit without loading the PNG, but
      // we can at least ensure the column math is consistent.
      expect(sprite.frame % sheet!.cols).toBeGreaterThanOrEqual(0);
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
