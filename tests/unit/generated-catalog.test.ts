import { describe, expect, it } from 'vitest';

import type { GeneratedManifest, ManifestEntry } from '../../src/shared/generated-assets.js';
import {
  composeFullCatalog,
  defaultGeneratedDescription,
  deriveGeneratedCatalogRow,
  deriveGeneratedCatalogRows,
  deriveGeneratedDescription,
  deriveGeneratedTags,
  GENERATED_ID_PREFIX,
  GENERATED_SHEET_KEY,
  isGeneratedCatalogId,
  isPlaceholderManifestEntry,
  stripGeneratedRows,
} from '../../src/shared/generated-catalog.js';
import type { SpriteCatalogRecord } from '../../src/shared/sprite-catalog.js';

function entry(overrides: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    assetPath: 'generated/foo.png',
    briefId: 'foo-brief',
    spriteName: 'foo',
    ...overrides,
  } as ManifestEntry;
}

function manifest(entries: Record<string, ManifestEntry>): GeneratedManifest {
  return { version: 1, entries } as GeneratedManifest;
}

describe('generated-catalog composer', () => {
  describe('isPlaceholderManifestEntry', () => {
    it('is true when explicit placeholder metadata is set', () => {
      expect(isPlaceholderManifestEntry(entry({ placeholder: true }))).toBe(true);
    });

    it('falls back to the asset path (catches the 2 hidden normal-key placeholders)', () => {
      // crescent-glaive / meteor-hammer carry a normal key + spriteName but a
      // -placeholder.png asset path.
      expect(
        isPlaceholderManifestEntry(
          entry({ assetPath: 'generated/equipment/weapon/crescent-glaive-placeholder.png' }),
        ),
      ).toBe(true);
    });

    it('is false for real generated art', () => {
      expect(isPlaceholderManifestEntry(entry())).toBe(false);
    });

    it('explicit false metadata is authoritative and overrides the path heuristic', () => {
      // Explicit placeholder metadata is the deliberate per-asset declaration;
      // the `-placeholder.png` path is only a fallback used when the flag is
      // absent. So an entry marked placeholder:false is NOT a placeholder even
      // if its path looks like one.
      expect(
        isPlaceholderManifestEntry(
          entry({ placeholder: false, assetPath: 'generated/x-placeholder.png' }),
        ),
      ).toBe(false);
    });
  });

  describe('deriveGeneratedTags', () => {
    it('leads with the semantic type, then the base tags — NOT alphabetical', () => {
      expect(deriveGeneratedTags(entry({ type: 'weapon' }))).toEqual([
        'weapon',
        'generated',
        'pipeline-approved',
      ]);
    });

    it('omits the type segment when the entry has no type', () => {
      expect(deriveGeneratedTags(entry({ type: undefined }))).toEqual([
        'generated',
        'pipeline-approved',
      ]);
    });

    it('an explicit catalog.tags override wins verbatim (order preserved)', () => {
      const override = ['item', 'generated', 'manual-authored'];
      expect(
        deriveGeneratedTags(entry({ type: 'equipment', catalog: { tags: override } })),
      ).toEqual(override);
    });

    it('returns a copy so callers cannot mutate the override array', () => {
      const override = ['weapon', 'generated', 'hand-authored'];
      const result = deriveGeneratedTags(entry({ catalog: { tags: override } }));
      result.push('mutated');
      expect(override).toEqual(['weapon', 'generated', 'hand-authored']);
    });

    it('ignores an empty override array and falls back to derived tags', () => {
      expect(deriveGeneratedTags(entry({ type: 'prop', catalog: { tags: [] } }))).toEqual([
        'prop',
        'generated',
        'pipeline-approved',
      ]);
    });
  });

  describe('deriveGeneratedDescription', () => {
    it('defaults to the brief-based description', () => {
      expect(deriveGeneratedDescription(entry({ briefId: 'my-brief' }))).toBe(
        'Generated sprite from brief: my-brief.',
      );
      expect(defaultGeneratedDescription('my-brief')).toBe(
        'Generated sprite from brief: my-brief.',
      );
    });

    it('a hand-authored catalog.description override wins', () => {
      expect(
        deriveGeneratedDescription(
          entry({ catalog: { description: 'Don Honkrado design copy.' } }),
        ),
      ).toBe('Don Honkrado design copy.');
    });
  });

  describe('deriveGeneratedCatalogRow', () => {
    it('derives id/spriteId/label from the manifest MAP KEY, never spriteName', () => {
      // spriteName is deliberately a brief-wide collider here.
      const row = deriveGeneratedCatalogRow(
        'equipment/weapon/bone-saw',
        entry({ spriteName: 'brief-wide-name', type: 'weapon' }),
      );
      expect(row.id).toBe(`${GENERATED_ID_PREFIX}equipment/weapon/bone-saw`);
      expect(row.label).toBe('equipment/weapon/bone-saw');
      expect(row.kind).toBe('sprite');
      // Narrow to the sprite variant to read spriteId/sheetKey.
      if (row.kind !== 'sprite') throw new Error('expected a sprite row');
      expect(row.spriteId).toBe('equipment/weapon/bone-saw');
      expect(row.sheetKey).toBe(GENERATED_SHEET_KEY);
      expect(row).toMatchObject({ frame: 0, col: 0, row: 0, kind: 'sprite' });
    });
  });

  describe('deriveGeneratedCatalogRows', () => {
    it('excludes placeholder entries and sorts by id', () => {
      const rows = deriveGeneratedCatalogRows(
        manifest({
          'b-key': entry({ type: 'weapon' }),
          'a-key': entry({ type: 'item' }),
          'z-placeholder-key': entry({ placeholder: true }),
          'path-placeholder': entry({ assetPath: 'generated/y-placeholder.png' }),
        }),
      );
      expect(rows.map((r) => r.id)).toEqual([
        `${GENERATED_ID_PREFIX}a-key`,
        `${GENERATED_ID_PREFIX}b-key`,
      ]);
    });
  });

  describe('composeFullCatalog', () => {
    const sheetRow = {
      id: 'sheet:tiles',
      kind: 'sheet',
      label: 'tiles',
      description: 'A sheet',
      tags: ['sheet'],
      sheetKey: 'tiles',
      path: 'tiles.png',
      frameWidth: 16,
      frameHeight: 16,
      margin: 0,
      spacing: 0,
      cols: 4,
    } as unknown as SpriteCatalogRecord;
    const handRow = {
      id: 'hand:thing',
      kind: 'sprite',
      label: 'thing',
      description: 'Hand row',
      tags: ['manual'],
      spriteId: 'thing',
      sheetKey: 'tiles',
      assetPath: 'thing.png',
      frame: 1,
      col: 1,
      row: 0,
    } as unknown as SpriteCatalogRecord;

    it('keeps committed non-generated rows and appends derived rows, sheets first', () => {
      const full = composeFullCatalog(
        [handRow, sheetRow],
        manifest({ 'gen-a': entry({ type: 'weapon' }) }),
      );
      expect(full[0]!.kind).toBe('sheet');
      const ids = full.map((r) => r.id);
      expect(ids).toContain('hand:thing');
      expect(ids).toContain(`${GENERATED_ID_PREFIX}gen-a`);
    });

    it('drops any stray committed generated: row and replaces it from the manifest (idempotent)', () => {
      const stray = {
        ...handRow,
        id: `${GENERATED_ID_PREFIX}gen-a`,
        label: 'STALE',
      } as unknown as SpriteCatalogRecord;
      const full = composeFullCatalog([stray], manifest({ 'gen-a': entry({ type: 'item' }) }));
      const derived = full.filter((r) => r.id === `${GENERATED_ID_PREFIX}gen-a`);
      expect(derived).toHaveLength(1);
      expect(derived[0]!.label).toBe('gen-a'); // derived from key, not the stale committed label
    });
  });

  describe('id helpers', () => {
    it('isGeneratedCatalogId matches only the generated: prefix', () => {
      expect(isGeneratedCatalogId('generated:foo')).toBe(true);
      expect(isGeneratedCatalogId('sheet:foo')).toBe(false);
    });

    it('stripGeneratedRows removes every derived row', () => {
      const rows = [
        { id: 'sheet:a' } as unknown as SpriteCatalogRecord,
        { id: 'generated:b' } as unknown as SpriteCatalogRecord,
      ];
      expect(stripGeneratedRows(rows).map((r) => r.id)).toEqual(['sheet:a']);
    });
  });
});
