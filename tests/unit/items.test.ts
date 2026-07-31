import { describe, expect, it } from 'vitest';
import {
  ITEM_CATALOG,
  getItemById,
  getItemByIndex,
  getItemIndex,
  KNOWN_TAGS,
  isKnownTag,
  _customTag as customTag,
  normalizeGeneratedInventoryTag,
} from '../../src/shared/items.js';

describe('Item Catalog', () => {
  it('contains at least 100 items', () => {
    expect(ITEM_CATALOG.length).toBeGreaterThanOrEqual(100);
  });

  it('snapshot: current catalog size (update when intentionally adding items)', () => {
    expect(ITEM_CATALOG).toHaveLength(126);
  });

  it('has unique IDs', () => {
    const ids = ITEM_CATALOG.map((item) => item.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it('every item has at least one tag', () => {
    for (const item of ITEM_CATALOG) {
      expect(item.tags.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('every item has a non-empty name and description', () => {
    for (const item of ITEM_CATALOG) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.description.length).toBeGreaterThan(0);
    }
  });

  it('every item has a valid maxStack', () => {
    for (const item of ITEM_CATALOG) {
      expect(item.maxStack).toBeGreaterThan(0);
    }
  });

  it('has at least 20 items per canonical tag', () => {
    for (const tag of KNOWN_TAGS) {
      const count = ITEM_CATALOG.filter((item) => item.tags.includes(tag)).length;
      expect(count).toBeGreaterThanOrEqual(20);
    }
  });

  it('snapshot: current item count per canonical tag (update when intentionally adding items)', () => {
    const expected: Record<string, number> = {
      Materials: 27,
      Weapons: 23,
      Consumables: 20,
      'Key Items': 20,
      Misc: 21,
    };
    for (const tag of KNOWN_TAGS) {
      const count = ITEM_CATALOG.filter((item) => item.tags.includes(tag)).length;
      expect(count).toBe(expected[tag]);
    }
  });

  it('some items have custom (non-known) tags', () => {
    const hasCustomTag = ITEM_CATALOG.some((item) => item.tags.some((tag) => !isKnownTag(tag)));
    expect(hasCustomTag).toBe(true);
  });

  it('some items have multiple tags', () => {
    const multiTagged = ITEM_CATALOG.filter((item) => item.tags.length > 1);
    expect(multiTagged.length).toBeGreaterThan(0);
  });
});

describe('Catalog lookup helpers', () => {
  it('getItemById returns the correct item', () => {
    const item = getItemById('iron-ore');
    expect(item).toBeDefined();
    expect(item!.name).toBe('Iron Ore');
  });

  it('getItemById returns undefined for unknown ID', () => {
    expect(getItemById('nonexistent')).toBeUndefined();
  });

  it('getItemByIndex returns correct item', () => {
    const first = ITEM_CATALOG[0]!;
    const item = getItemByIndex(0);
    expect(item).toBeDefined();
    expect(item!.id).toBe(first.id);
  });

  it('getItemByIndex returns undefined for out-of-range', () => {
    expect(getItemByIndex(9999)).toBeUndefined();
  });

  it('getItemIndex returns correct index', () => {
    const idx = getItemIndex('iron-ore');
    expect(idx).toBe(0);
  });

  it('getItemIndex returns -1 for unknown ID', () => {
    expect(getItemIndex('nonexistent')).toBe(-1);
  });
});

describe('Tag system', () => {
  it('isKnownTag identifies canonical tags', () => {
    expect(isKnownTag('Materials')).toBe(true);
    expect(isKnownTag('Weapons')).toBe(true);
    expect(isKnownTag('Consumables')).toBe(true);
    expect(isKnownTag('Key Items')).toBe(true);
    expect(isKnownTag('Misc')).toBe(true);
  });

  it('isKnownTag rejects custom tags', () => {
    expect(isKnownTag(customTag('Smelly Stuff'))).toBe(false);
    expect(isKnownTag(customTag('Corpses'))).toBe(false);
  });

  it('customTag creates a branded string', () => {
    const tag = customTag('Forbidden Snacks');
    expect(tag).toBe('Forbidden Snacks');
    expect(typeof tag).toBe('string');
  });

  it('normalizes generated category tags onto inventory tabs', () => {
    expect(normalizeGeneratedInventoryTag('weapon')).toBe('Weapons');
    expect(normalizeGeneratedInventoryTag('Weapons')).toBe('Weapons');
    expect(normalizeGeneratedInventoryTag('equipment')).toBe(customTag('Gear'));
    expect(normalizeGeneratedInventoryTag('armor')).toBe(customTag('Gear'));
    expect(normalizeGeneratedInventoryTag('accessory')).toBe(customTag('Gear'));
  });

  it('preserves non-category generated tags as custom tabs', () => {
    expect(normalizeGeneratedInventoryTag('basic-leather')).toBe(customTag('basic-leather'));
    expect(normalizeGeneratedInventoryTag('floor2')).toBe(customTag('floor2'));
  });
});
