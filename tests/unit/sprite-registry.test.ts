import { describe, expect, it } from 'vitest';
import { SHEETS, SPRITES, getSheet, getSprite } from '../../src/engine/sprites/index.js';
import { TILE_SPRITES } from '../../src/engine/sprites/tile-visuals.js';
import { isValidAnchor } from '../../src/shared/sprite-anchor.js';

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

  it('every sheet path lives under /assets/kenney/ or /assets/generated/', () => {
    for (const sheet of SHEETS) {
      expect(
        sheet.path.startsWith('/assets/kenney/') || sheet.path.startsWith('/assets/generated/'),
        sheet.key,
      ).toBe(true);
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

  it('every sheet declares a positive column and row count', () => {
    // Frame-index math (`frame % cols`, `frame / cols`) silently breaks
    // if cols is 0 or NaN. Pin it as an explicit invariant.
    // `rows` is required for bounds-checking TILE_SPRITES frame indices.
    for (const sheet of SHEETS) {
      expect(sheet.cols, `sheet ${sheet.key} cols`).toBeGreaterThan(0);
      expect(Number.isFinite(sheet.cols), `sheet ${sheet.key} cols finite`).toBe(true);
      expect(sheet.rows, `sheet ${sheet.key} rows`).toBeGreaterThan(0);
      expect(Number.isFinite(sheet.rows), `sheet ${sheet.key} rows finite`).toBe(true);
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

  it('every declared anchor lies inside its sprite sheet frame', () => {
    // Anchors are optional today (no equipped-item renderer consumes them yet),
    // but any sprite that DOES declare one must point at a real pixel inside
    // its sheet's frame — otherwise the future renderer would pin off-canvas.
    for (const sprite of SPRITES) {
      if (sprite.anchor === undefined) continue;
      const sheet = getSheet(sprite.sheetKey);
      expect(sheet, `sheet ${sprite.sheetKey}`).toBeDefined();
      expect(
        isValidAnchor(sprite.anchor, sheet!.frameWidth, sheet!.frameHeight),
        `sprite ${sprite.id} anchor ${JSON.stringify(sprite.anchor)} ` +
          `outside ${sheet!.frameWidth}x${sheet!.frameHeight}`,
      ).toBe(true);
    }
  });
});

describe('TILE_SPRITES', () => {
  it('every entry references a registered sheet key', () => {
    const sheetKeys = new Set(SHEETS.map((s) => s.key));
    for (const [terrain, visual] of Object.entries(TILE_SPRITES)) {
      if (!visual) continue;
      expect(
        sheetKeys.has(visual.sheetKey),
        `TerrainType ${terrain}: unknown sheetKey '${visual.sheetKey}'`,
      ).toBe(true);
    }
  });

  it('every entry has a non-negative frame index within sheet bounds', () => {
    for (const [terrain, visual] of Object.entries(TILE_SPRITES)) {
      if (!visual) continue;
      const sheet = getSheet(visual.sheetKey);
      expect(sheet, `TerrainType ${terrain}: sheet '${visual.sheetKey}' not found`).toBeDefined();
      const frameCount = sheet!.cols * sheet!.rows;
      expect(
        visual.frame,
        `TerrainType ${terrain}: frame ${visual.frame} is negative`,
      ).toBeGreaterThanOrEqual(0);
      expect(
        visual.frame,
        `TerrainType ${terrain}: frame ${visual.frame} >= frameCount ${frameCount} (${sheet!.cols}×${sheet!.rows})`,
      ).toBeLessThan(frameCount);
    }
  });

  it('every blob-tile frame entry stays within sheet bounds when present', () => {
    for (const [terrain, visual] of Object.entries(TILE_SPRITES)) {
      if (!visual?.frames) continue;
      const sheet = getSheet(visual.sheetKey);
      expect(sheet, `TerrainType ${terrain}: sheet '${visual.sheetKey}' not found`).toBeDefined();
      expect(visual.frames.length, `TerrainType ${terrain}: blob frame count`).toBe(16);

      const frameCount = sheet!.cols * sheet!.rows;
      for (const [mask, frame] of visual.frames.entries()) {
        expect(
          frame,
          `TerrainType ${terrain}: frames[${mask}] ${frame} is negative`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          frame,
          `TerrainType ${terrain}: frames[${mask}] ${frame} >= frameCount ${frameCount} (${sheet!.cols}×${sheet!.rows})`,
        ).toBeLessThan(frameCount);
      }
    }
  });
});
