import { describe, expect, it } from 'vitest';
import { syncCatalog } from '../../scripts/sprites/sync-catalog.js';
import { parseSpriteCatalog } from '../../src/shared/sprite-catalog.js';

describe('sprite catalog sync', () => {
  const sheets = [
    {
      key: 'sheet-a',
      path: '/assets/sheet-a.png',
      frameWidth: 16,
      frameHeight: 16,
      margin: 0,
      spacing: 1,
      cols: 8,
      description: 'Sheet A description',
    },
  ] as const;

  const sprites = [
    {
      id: 'player',
      sheetKey: 'sheet-a',
      frame: 17,
      note: 'Player note',
    },
  ] as const;

  it('creates deterministic sheet and sprite entries with computed coordinates', () => {
    const next = syncCatalog([], sheets, sprites);
    expect(next.map((entry) => entry.id)).toEqual(['sheet:sheet-a', 'sprite:player']);

    const sprite = next.find((entry) => entry.id === 'sprite:player');
    expect(sprite).toBeDefined();
    expect(sprite!.kind).toBe('sprite');
    if (sprite?.kind !== 'sprite') {
      throw new Error('Expected sprite entry');
    }
    expect(sprite.col).toBe(1);
    expect(sprite.row).toBe(2);
    expect(sprite.description).toBe('Player note.');
  });

  it('preserves editable metadata when registry-generated fields change', () => {
    const existing = [
      {
        id: 'sheet:sheet-a',
        kind: 'sheet',
        label: 'sheet-a',
        description: 'Custom sheet sentence.',
        tags: ['pack-a'],
        sheetKey: 'sheet-a',
        path: '/old/path.png',
        frameWidth: 16,
        frameHeight: 16,
        margin: 0,
        spacing: 1,
        cols: 4,
      },
      {
        id: 'sprite:player',
        kind: 'sprite',
        label: 'player',
        description: 'Custom player sentence.',
        tags: ['hero'],
        spriteId: 'player',
        sheetKey: 'sheet-a',
        frame: 0,
        col: 0,
        row: 0,
        note: 'old note',
        tile: { connectsTo: ['sprite:wall'] },
        animation: { clips: ['idle'] },
      },
    ];

    const next = syncCatalog(existing, sheets, sprites);
    const sheet = next.find((entry) => entry.id === 'sheet:sheet-a');
    const sprite = next.find((entry) => entry.id === 'sprite:player');
    expect(sheet).toBeDefined();
    expect(sprite).toBeDefined();
    expect(sheet?.description).toBe('Custom sheet sentence.');
    expect(sheet?.tags).toEqual(['pack-a']);
    if (sprite?.kind !== 'sprite') {
      throw new Error('Expected sprite entry');
    }
    expect(sprite.description).toBe('Custom player sentence.');
    expect(sprite.tags).toEqual(['hero']);
    expect(sprite.tile).toEqual({ connectsTo: ['sprite:wall'] });
    expect(sprite.animation).toEqual({ clips: ['idle'] });
    expect(sprite.frame).toBe(17);
    expect(sprite.col).toBe(1);
    expect(sprite.row).toBe(2);
    expect(sprite.note).toBe('Player note');
  });

  it('keeps unknown entries unless prune is enabled', () => {
    const existing = [
      {
        id: 'sprite:legacy',
        kind: 'sprite',
        label: 'legacy',
        description: 'Legacy sprite sentence.',
        tags: [],
        spriteId: 'legacy',
        sheetKey: 'sheet-a',
        frame: 1,
        col: 1,
        row: 0,
      },
    ];

    const kept = syncCatalog(existing, sheets, sprites);
    expect(kept.some((entry) => entry.id === 'sprite:legacy')).toBe(true);

    const pruned = syncCatalog(existing, sheets, sprites, { prune: true });
    expect(pruned.some((entry) => entry.id === 'sprite:legacy')).toBe(false);
  });
});

describe('sprite catalog schema', () => {
  it('rejects descriptions that are not sentence-like', () => {
    expect(() =>
      parseSpriteCatalog([
        {
          id: 'sheet:sheet-a',
          kind: 'sheet',
          label: 'sheet-a',
          description: 'missing punctuation',
          tags: [],
          sheetKey: 'sheet-a',
          path: '/assets/sheet-a.png',
          frameWidth: 16,
          frameHeight: 16,
          margin: 0,
          spacing: 1,
          cols: 8,
        },
      ]),
    ).toThrowError();
  });
});
