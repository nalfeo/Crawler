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
import { getEquipmentDefForItem } from './equipmentDefs.js';
import type { EquipmentSlotId } from './equipment-slots.js';
import type { GeneratedEquipmentInstanceKey } from './generated-equipment-types.js';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface InventorySlot {
  itemId: string;
  quantity: number;
}

export interface StackableStaticInventoryEntry extends InventorySlot {
  readonly kind: 'stackable-static-item';
}

export interface GeneratedEquipmentInventoryEntry {
  readonly kind: 'generated-instance';
  readonly instanceKey: GeneratedEquipmentInstanceKey;
}

export type InventoryBagEntry = StackableStaticInventoryEntry | GeneratedEquipmentInventoryEntry;

/**
 * Read-only presentation fields required to query either inventory lane.
 *
 * Generated instances deliberately keep their full data in the core registry;
 * callers supply the narrow resolver instead of teaching the bag about registry
 * storage. This keeps `listInventoryEntries()` as the one canonical bag traversal
 * while preserving the core/shared layer boundary.
 */
export interface InventoryEntryMetadata {
  readonly name: string;
  readonly description: string;
  readonly tags: readonly ItemTag[];
  readonly rarity: string;
  readonly slots: readonly EquipmentSlotId[];
}

/** Resolves immutable registry-backed metadata for one generated bag reference. */
export type GeneratedInventoryEntryResolver = (
  entry: GeneratedEquipmentInventoryEntry,
) => InventoryEntryMetadata | undefined;

export interface InventoryBag {
  /** Legacy static-item lane. Existing item/count consumers remain unchanged. */
  slots: InventorySlot[];
  /** Generated equipment stores identity references only; B1 owns full records. */
  generatedEquipment?: GeneratedEquipmentInventoryEntry[];
  /** Optional generated-item cap. Omitted preserves the existing infinite-capacity bag. */
  generatedEquipmentCapacity?: number;
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

/** Canonical discriminated view across the legacy static and generated-reference lanes. */
export function listInventoryEntries(bag: InventoryBag): readonly InventoryBagEntry[] {
  return [
    ...bag.slots.map(
      (slot): StackableStaticInventoryEntry => ({
        kind: 'stackable-static-item',
        itemId: slot.itemId,
        quantity: slot.quantity,
      }),
    ),
    ...(bag.generatedEquipment ?? []).map(
      (entry): GeneratedEquipmentInventoryEntry => ({
        kind: entry.kind,
        instanceKey: entry.instanceKey,
      }),
    ),
  ];
}

/** Check for one exact generated instance reference. */
export function hasGeneratedEquipmentReference(
  bag: InventoryBag,
  instanceKey: GeneratedEquipmentInstanceKey,
): boolean {
  return (bag.generatedEquipment ?? []).some((entry) => entry.instanceKey === instanceKey);
}

/** Remaining exact-instance capacity; `Infinity` preserves the legacy unbounded bag. */
export function getGeneratedEquipmentRemainingCapacity(bag: InventoryBag): number {
  const capacity = bag.generatedEquipmentCapacity;
  if (capacity === undefined) return Number.POSITIVE_INFINITY;
  return Math.max(0, Math.floor(capacity) - (bag.generatedEquipment?.length ?? 0));
}

/** Whether the bag can accept the requested number of generated instances. */
export function canAcceptGeneratedEquipment(bag: InventoryBag, quantity = 1): boolean {
  return (
    Number.isInteger(quantity) &&
    quantity >= 0 &&
    getGeneratedEquipmentRemainingCapacity(bag) >= quantity
  );
}

/**
 * Add one exact generated instance reference.
 *
 * This low-level bag primitive enforces local uniqueness. World/registry ownership
 * validation belongs to the core transfer API.
 */
export function addGeneratedEquipmentReference(
  bag: InventoryBag,
  instanceKey: GeneratedEquipmentInstanceKey,
): GeneratedEquipmentInventoryEntry {
  if (hasGeneratedEquipmentReference(bag, instanceKey)) {
    throw new Error(`Generated equipment instance already exists in bag: ${instanceKey}`);
  }
  const entry: GeneratedEquipmentInventoryEntry = {
    kind: 'generated-instance',
    instanceKey,
  };
  (bag.generatedEquipment ??= []).push(entry);
  return entry;
}

/** Remove one exact generated instance reference without matching on base identity. */
export function removeGeneratedEquipmentReference(
  bag: InventoryBag,
  instanceKey: GeneratedEquipmentInstanceKey,
): GeneratedEquipmentInventoryEntry | undefined {
  const entries = bag.generatedEquipment;
  if (!entries) return undefined;
  const index = entries.findIndex((entry) => entry.instanceKey === instanceKey);
  if (index < 0) return undefined;
  return entries.splice(index, 1)[0];
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
  if (!def) {
    throw new Error(`Unknown itemId "${itemId}"`);
  }
  const rawMaxStack = def.maxStack;
  if (rawMaxStack <= 0) {
    throw new Error(`Invalid maxStack for item "${itemId}": ${rawMaxStack}`);
  }
  const maxStack = rawMaxStack;
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

function resolveEntryMetadata(
  entry: InventoryBagEntry,
  catalog: readonly ItemDef[] | undefined,
  resolveGenerated: GeneratedInventoryEntryResolver | undefined,
): InventoryEntryMetadata | undefined {
  if (entry.kind === 'generated-instance') {
    return resolveGenerated?.(entry);
  }
  const def = catalog
    ? catalog.find((candidate) => candidate.id === entry.itemId)
    : getItemById(entry.itemId);
  if (!def) return undefined;
  return {
    name: def.name,
    description: def.description,
    tags: def.tags,
    rarity: def.rarity,
    slots: getEquipmentDefForItem(entry.itemId)?.slots ?? [],
  };
}

/**
 * Search slots by item name or description (case-insensitive substring match).
 * Returns matching slots (references, not copies).
 */
export function search(
  bag: InventoryBag,
  query: string,
  catalog?: readonly ItemDef[],
): InventorySlot[];
export function search(
  bag: InventoryBag,
  query: string,
  catalog: readonly ItemDef[] | undefined,
  resolveGenerated: GeneratedInventoryEntryResolver,
): InventoryBagEntry[];
export function search(
  bag: InventoryBag,
  query: string,
  catalog?: readonly ItemDef[],
  resolveGenerated?: GeneratedInventoryEntryResolver,
): unknown[] {
  const lowerQuery = query.toLowerCase();
  return listInventoryEntries(bag).filter((entry) => {
    const metadata = resolveEntryMetadata(entry, catalog, resolveGenerated);
    if (!metadata) return false;
    return (
      metadata.name.toLowerCase().includes(lowerQuery) ||
      metadata.description.toLowerCase().includes(lowerQuery)
    );
  });
}

/** Filter slots to those whose item has a given tag. */
export function filterByTag(
  bag: InventoryBag,
  tag: ItemTag,
  catalog?: readonly ItemDef[],
): InventorySlot[];
export function filterByTag(
  bag: InventoryBag,
  tag: ItemTag,
  catalog: readonly ItemDef[] | undefined,
  resolveGenerated: GeneratedInventoryEntryResolver,
): InventoryBagEntry[];
export function filterByTag(
  bag: InventoryBag,
  tag: ItemTag,
  catalog?: readonly ItemDef[],
  resolveGenerated?: GeneratedInventoryEntryResolver,
): unknown[] {
  return listInventoryEntries(bag).filter((entry) => {
    const metadata = resolveEntryMetadata(entry, catalog, resolveGenerated);
    return metadata?.tags.includes(tag) ?? false;
  });
}

/** Filter slots to equippable items that can be worn in the given equipment slot. */
export function filterByEquipmentSlot(bag: InventoryBag, slotId: EquipmentSlotId): InventorySlot[];
export function filterByEquipmentSlot(
  bag: InventoryBag,
  slotId: EquipmentSlotId,
  resolveGenerated: GeneratedInventoryEntryResolver,
): InventoryBagEntry[];
export function filterByEquipmentSlot(
  bag: InventoryBag,
  slotId: EquipmentSlotId,
  resolveGenerated?: GeneratedInventoryEntryResolver,
): unknown[] {
  return listInventoryEntries(bag).filter((entry) => {
    const metadata = resolveEntryMetadata(entry, undefined, resolveGenerated);
    return metadata?.slots.includes(slotId) ?? false;
  });
}

/**
 * Filter slots to every equippable item in the bag, regardless of slot. Used by
 * the integrated equipment-panel bag column when no slot filter is active.
 */
export function filterEquippable(bag: InventoryBag): InventorySlot[];
export function filterEquippable(
  bag: InventoryBag,
  resolveGenerated: GeneratedInventoryEntryResolver,
): InventoryBagEntry[];
export function filterEquippable(
  bag: InventoryBag,
  resolveGenerated?: GeneratedInventoryEntryResolver,
): unknown[] {
  return listInventoryEntries(bag).filter((entry) => {
    const metadata = resolveEntryMetadata(entry, undefined, resolveGenerated);
    return (metadata?.slots.length ?? 0) > 0;
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
  sortBy?: SortField,
  catalog?: readonly ItemDef[],
): InventorySlot[];
export function sortSlots(
  bag: InventoryBag,
  sortBy: SortField | undefined,
  catalog: readonly ItemDef[] | undefined,
  resolveGenerated: GeneratedInventoryEntryResolver,
): InventoryBagEntry[];
export function sortSlots(
  bag: InventoryBag,
  sortBy: SortField = 'rarity',
  catalog?: readonly ItemDef[],
  resolveGenerated?: GeneratedInventoryEntryResolver,
): unknown[] {
  const resolve = (entry: InventoryBagEntry) =>
    resolveEntryMetadata(entry, catalog, resolveGenerated);

  return [...listInventoryEntries(bag)].sort((a, b) => {
    const defA = resolve(a);
    const defB = resolve(b);
    if (!defA || !defB) return 0;

    switch (sortBy) {
      case 'rarity': {
        const diff = (RARITY_ORDER[defB.rarity] ?? 0) - (RARITY_ORDER[defA.rarity] ?? 0);
        if (diff !== 0) return diff;
        return (
          defA.name.localeCompare(defB.name) ||
          inventoryEntryIdentity(a).localeCompare(inventoryEntryIdentity(b))
        );
      }
      case 'name':
        return (
          defA.name.localeCompare(defB.name) ||
          inventoryEntryIdentity(a).localeCompare(inventoryEntryIdentity(b))
        );
      case 'quantity':
        return (
          (b.kind === 'stackable-static-item' ? b.quantity : 1) -
            (a.kind === 'stackable-static-item' ? a.quantity : 1) ||
          inventoryEntryIdentity(a).localeCompare(inventoryEntryIdentity(b))
        );
    }
  });
}

/** Stable identity for UI keys, pins, selection, and deterministic sort tie-breaks. */
export function inventoryEntryIdentity(entry: InventoryBagEntry): string {
  return entry.kind === 'generated-instance'
    ? `generated:${entry.instanceKey}`
    : `static:${entry.itemId}`;
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
  resolveGenerated?: GeneratedInventoryEntryResolver,
): ItemTag[] {
  const tags = new Set<ItemTag>();
  for (const entry of listInventoryEntries(bag)) {
    const metadata = resolveEntryMetadata(entry, catalog, resolveGenerated);
    if (!metadata) continue;
    for (const tag of metadata.tags) {
      tags.add(tag);
    }
  }
  return [...tags];
}

/**
 * Derive the visible, ordered list of tabs to render in the UI.
 * 1. Start with all active tags in the inventory.
 * 2. Remove tags in `prefs.hidden` (only custom tags can be hidden).
 * 3. Honour `prefs.order` first for both known and custom tags.
 * 4. Append any remaining active tags alphabetically.
 */
export function getVisibleTabs(
  bag: InventoryBag,
  prefs: TabPreferences,
  catalog?: readonly ItemDef[],
  resolveGenerated?: GeneratedInventoryEntryResolver,
): ItemTag[] {
  const active = new Set(getActiveTags(bag, catalog, resolveGenerated));

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
