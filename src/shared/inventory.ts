/**
 * Inventory bag — data types and pure functions for managing a player's inventory.
 *
 * The bag has infinite capacity. Duplicate items stack up to ItemDef.maxStack.
 * Tab preferences let the player reorder or hide custom tabs.
 */

import {
  type CustomTag,
  type ItemDef,
  type ItemTag,
  KNOWN_TAGS,
  isKnownTag,
  getItemById,
} from './items.js';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface InventorySlot {
  itemId: string;
  quantity: number;
}

export interface InventoryBag {
  slots: InventorySlot[];
}

export interface TabPreferences {
  /** User-defined tab ordering. Known tags appear in KNOWN_TAGS order by default. */
  order: ItemTag[];
  /** Custom tags the user has hidden. Known (canonical) tags cannot be hidden. */
  hidden: Set<CustomTag>;
}

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

export function createInventoryBag(): InventoryBag {
  return { slots: [] };
}

export function createTabPreferences(): TabPreferences {
  return { order: [...KNOWN_TAGS], hidden: new Set() };
}

// ---------------------------------------------------------------------------
// Bag operations (pure — return new state or mutate-in-place for perf)
// ---------------------------------------------------------------------------

/**
 * Add `quantity` of an item to the bag. Stacks if the item already exists,
 * respecting `maxStack`. Overflow creates additional slots.
 * Returns the number of items actually added.
 */
export function addItem(
  bag: InventoryBag,
  itemId: string,
  quantity: number,
  catalog?: readonly ItemDef[],
): number {
  if (quantity <= 0) return 0;

  const def = catalog ? catalog.find((d) => d.id === itemId) : getItemById(itemId);
  const maxStack = def?.maxStack ?? Infinity;
  let remaining = quantity;

  // Fill existing slots first
  for (const slot of bag.slots) {
    if (slot.itemId !== itemId) continue;
    const space = maxStack - slot.quantity;
    if (space <= 0) continue;
    const toAdd = Math.min(space, remaining);
    slot.quantity += toAdd;
    remaining -= toAdd;
    if (remaining <= 0) return quantity;
  }

  // Create new slots for the remainder
  while (remaining > 0) {
    const toAdd = Math.min(maxStack, remaining);
    bag.slots.push({ itemId, quantity: toAdd });
    remaining -= toAdd;
  }

  return quantity;
}

/**
 * Remove `quantity` of an item from the bag.
 * Returns the number of items actually removed.
 */
export function removeItem(bag: InventoryBag, itemId: string, quantity: number): number {
  if (quantity <= 0) return 0;

  let remaining = quantity;

  for (let i = bag.slots.length - 1; i >= 0; i--) {
    const slot = bag.slots[i]!;
    if (slot.itemId !== itemId) continue;

    const toRemove = Math.min(slot.quantity, remaining);
    slot.quantity -= toRemove;
    remaining -= toRemove;

    if (slot.quantity <= 0) {
      bag.slots.splice(i, 1);
    }

    if (remaining <= 0) break;
  }

  return quantity - remaining;
}

/** Check whether the bag contains at least `minQty` (default 1) of an item. */
export function hasItem(bag: InventoryBag, itemId: string, minQty = 1): boolean {
  return getItemCount(bag, itemId) >= minQty;
}

/** Total quantity of an item across all slots. */
export function getItemCount(bag: InventoryBag, itemId: string): number {
  let count = 0;
  for (const slot of bag.slots) {
    if (slot.itemId === itemId) count += slot.quantity;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Querying / filtering
// ---------------------------------------------------------------------------

/**
 * Search slots by item name or description (case-insensitive substring match).
 * Returns matching slots (references, not copies).
 */
export function search(
  bag: InventoryBag,
  query: string,
  catalog?: readonly ItemDef[],
): InventorySlot[] {
  const lowerQuery = query.toLowerCase();
  return bag.slots.filter((slot) => {
    const def = catalog ? catalog.find((d) => d.id === slot.itemId) : getItemById(slot.itemId);
    if (!def) return false;
    return (
      def.name.toLowerCase().includes(lowerQuery) ||
      def.description.toLowerCase().includes(lowerQuery)
    );
  });
}

/** Filter slots to those whose item has a given tag. */
export function filterByTag(
  bag: InventoryBag,
  tag: ItemTag,
  catalog?: readonly ItemDef[],
): InventorySlot[] {
  return bag.slots.filter((slot) => {
    const def = catalog ? catalog.find((d) => d.id === slot.itemId) : getItemById(slot.itemId);
    if (!def) return false;
    return def.tags.includes(tag);
  });
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortField = 'name' | 'rarity' | 'quantity';

const RARITY_ORDER: Record<string, number> = {
  Common: 0,
  Uncommon: 1,
  Rare: 2,
  Epic: 3,
  Legendary: 4,
};

/**
 * Return a sorted copy of the bag's slots.
 * Default sort: by rarity (descending), then name (ascending).
 */
export function sortSlots(
  bag: InventoryBag,
  sortBy: SortField = 'rarity',
  catalog?: readonly ItemDef[],
): InventorySlot[] {
  const resolve = (id: string) =>
    catalog ? catalog.find((d) => d.id === id) : getItemById(id);

  return [...bag.slots].sort((a, b) => {
    const defA = resolve(a.itemId);
    const defB = resolve(b.itemId);
    if (!defA || !defB) return 0;

    switch (sortBy) {
      case 'rarity': {
        const diff = (RARITY_ORDER[defB.rarity] ?? 0) - (RARITY_ORDER[defA.rarity] ?? 0);
        return diff !== 0 ? diff : defA.name.localeCompare(defB.name);
      }
      case 'name':
        return defA.name.localeCompare(defB.name);
      case 'quantity':
        return b.quantity - a.quantity;
    }
  });
}

// ---------------------------------------------------------------------------
// Tab system
// ---------------------------------------------------------------------------

/**
 * Collect all unique tags present in the player's current inventory.
 * Only tags attached to items the player actually holds appear.
 */
export function getActiveTags(
  bag: InventoryBag,
  catalog?: readonly ItemDef[],
): ItemTag[] {
  const tags = new Set<ItemTag>();
  for (const slot of bag.slots) {
    const def = catalog ? catalog.find((d) => d.id === slot.itemId) : getItemById(slot.itemId);
    if (!def) continue;
    for (const tag of def.tags) {
      tags.add(tag);
    }
  }
  return [...tags];
}

/**
 * Derive the visible, ordered list of tabs to render in the UI.
 * 1. Start with all active tags in the inventory.
 * 2. Remove tags in `prefs.hidden` (only custom tags can be hidden).
 * 3. Order: known tags first (in KNOWN_TAGS order), then user-ordered custom,
 *    then any remaining custom tags alphabetically.
 */
export function getVisibleTabs(
  bag: InventoryBag,
  prefs: TabPreferences,
  catalog?: readonly ItemDef[],
): ItemTag[] {
  const active = new Set(getActiveTags(bag, catalog));

  // Remove hidden custom tags
  for (const hidden of prefs.hidden) {
    active.delete(hidden);
  }

  // Build ordered result
  const result: ItemTag[] = [];
  const placed = new Set<ItemTag>();

  // Honour prefs.order first
  for (const tag of prefs.order) {
    if (active.has(tag) && !placed.has(tag)) {
      result.push(tag);
      placed.add(tag);
    }
  }

  // Any remaining active tags not yet placed (new custom tags), alphabetically
  const remaining = [...active].filter((t) => !placed.has(t));
  remaining.sort((a, b) => a.localeCompare(b));
  result.push(...remaining);

  return result;
}

// ---------------------------------------------------------------------------
// Tab preference mutations
// ---------------------------------------------------------------------------

/** Move a tab to a new position in the order. */
export function reorderTab(prefs: TabPreferences, tag: ItemTag, newIndex: number): void {
  const idx = prefs.order.indexOf(tag);
  if (idx !== -1) {
    prefs.order.splice(idx, 1);
  }
  const clamped = Math.max(0, Math.min(prefs.order.length, newIndex));
  prefs.order.splice(clamped, 0, tag);
}

/** Hide a custom tab. Known tags cannot be hidden. */
export function hideTab(prefs: TabPreferences, tag: ItemTag): boolean {
  if (isKnownTag(tag)) return false;
  prefs.hidden.add(tag as CustomTag);
  return true;
}

/** Show a previously hidden custom tab. */
export function showTab(prefs: TabPreferences, tag: CustomTag): void {
  prefs.hidden.delete(tag);
}
