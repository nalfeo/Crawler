/**
 * Regression tests for the pure sort-order validators in check-sort-assets.ts.
 *
 * These feed deliberately unsorted / malformed fixtures through the validators
 * so the enforcement logic cannot silently regress (CI only exercises the
 * success path against the already-sorted repository files).
 */

import { describe, expect, it } from 'vitest';
import {
  validateCatalogEntries,
  type CatalogEntry,
} from '../../../scripts/sprites/check-sort-assets.js';

// ---------------------------------------------------------------------------
// validateCatalogEntries
// ---------------------------------------------------------------------------

function sheet(id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return { id, kind: 'sheet', ...extra };
}

function sprite(id: string, extra: Partial<CatalogEntry> = {}): CatalogEntry {
  return { id, kind: 'sprite', ...extra };
}

describe('validateCatalogEntries', () => {
  it('returns no errors for an empty catalog', () => {
    expect(validateCatalogEntries([])).toEqual([]);
  });

  it('returns no errors for a single entry', () => {
    expect(validateCatalogEntries([sprite('generated:alpha')])).toEqual([]);
  });

  it('returns no errors for correctly ordered catalog (sheets first, then by id)', () => {
    const catalog: CatalogEntry[] = [
      sheet('sheet:custom'),
      sheet('sheet:enemies'),
      sprite('generated:alpha'),
      sprite('generated:beta'),
      sprite('generated:gamma'),
    ];
    expect(validateCatalogEntries(catalog)).toEqual([]);
  });

  it('detects non-sheet entry before sheet entry (group ordering violation)', () => {
    const catalog: CatalogEntry[] = [sprite('generated:alpha'), sheet('sheet:custom')];
    const errors = validateCatalogEntries(catalog);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('generated:alpha');
    expect(errors[0]).toContain('sheet:custom');
  });

  it('detects out-of-order id within the non-sheet group', () => {
    const catalog: CatalogEntry[] = [
      sheet('sheet:custom'),
      sprite('generated:beta'),
      sprite('generated:alpha'), // out of order
    ];
    const errors = validateCatalogEntries(catalog);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"generated:beta"');
    expect(errors[0]).toContain('"generated:alpha"');
    expect(errors[0]).toContain('index 2');
  });

  it('detects out-of-order id within the sheet group', () => {
    const catalog: CatalogEntry[] = [
      sheet('sheet:z'),
      sheet('sheet:a'), // out of order within sheet group
      sprite('generated:alpha'),
    ];
    const errors = validateCatalogEntries(catalog);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('"sheet:z"');
    expect(errors[0]).toContain('"sheet:a"');
  });

  it('reports only the first violation', () => {
    const catalog: CatalogEntry[] = [
      sprite('generated:gamma'),
      sprite('generated:beta'),
      sprite('generated:alpha'),
    ];
    const errors = validateCatalogEntries(catalog);
    expect(errors).toHaveLength(1);
  });

  it('uses a custom label in the error message', () => {
    const catalog: CatalogEntry[] = [sprite('generated:b'), sprite('generated:a')];
    const errors = validateCatalogEntries(catalog, 'my-catalog.json');
    expect(errors[0]).toContain('my-catalog.json');
  });

  it('handles entries with missing id (id defaults to empty string for comparison)', () => {
    // Entry with no id sorts at the beginning of its group (empty string < any)
    const catalog: CatalogEntry[] = [{ id: '', kind: 'sprite' }, sprite('generated:alpha')];
    expect(validateCatalogEntries(catalog)).toEqual([]);
  });

  it('handles entries where kind is not "sheet" treated as non-sheet', () => {
    // kind="mob" is not "sheet", so it should be in the non-sheet group
    const catalog: CatalogEntry[] = [
      { id: 'mob:alpha', kind: 'mob' },
      { id: 'mob:beta', kind: 'mob' },
    ];
    expect(validateCatalogEntries(catalog)).toEqual([]);

    const outOfOrder: CatalogEntry[] = [
      { id: 'mob:beta', kind: 'mob' },
      { id: 'mob:alpha', kind: 'mob' },
    ];
    const errors = validateCatalogEntries(outOfOrder);
    expect(errors).toHaveLength(1);
  });
});
