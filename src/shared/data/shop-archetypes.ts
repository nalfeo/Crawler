/**
 * Floor 2 shop-archetype registry — data-driven pool from
 * `shop-archetypes.floor2.json`. `generateShopInventory` in
 * `src/core/generateShopInventory.ts` consumes these archetypes to roll a
 * seeded per-run shop inventory.
 *
 * Archetype entries reference *purchasable* weapon item ids from
 * `weapons.json`: a weapon id qualifies once it activates through a
 * weapon-equipment def or, like the merchant-stocked weapons below, only
 * through its own catalog-only `items.ts` entry. `knownShopItemIds()` below
 * enumerates exactly that id space (via `resolveShopCatalogItem`) — it does
 * NOT admit an arbitrary `items.ts` slug that isn't also a `weapons.json` id.
 * The loader validates that invariant at load-time (through the same resolver
 * the purchase path uses) so stock a player could never buy can't ship.
 *
 * The merchant's-charm (`SHOPKEEPER_EQUIPMENT_ITEM_ID`) is a *unique* item —
 * sold only by the Floor 1 merchant after his fetch-quest completes — and is
 * deliberately excluded from `knownShopItemIds()` so it can never be
 * referenced by a generic shop-archetype entry (other merchants must never
 * sell it).
 *
 * Prices are the *base* per-item price. Runtime price is
 * `basePrice * archetype.priceMultiplier * (tuning.shopPricing.tierMultiplier ?? 1)`.
 */
import { z } from 'zod';
import archetypesJson from './shop-archetypes.floor2.json';
import weaponsJson from './weapons.json';
import { isShopCatalogItem } from '../shop-catalog.js';

export const FLOOR2_QUARTERMASTER_ARCHETYPE_ID = 'the-quartermaster';

const shopEntrySchema = z
  .object({
    /** Item id — must resolve against the known-item catalog (see below). */
    itemId: z.string().min(1),
    /** Weight for weighted-without-replacement inventory rolls. */
    weight: z.number().positive(),
    /** Base gold price before archetype/tier multipliers. */
    basePrice: z.number().int().positive(),
  })
  .strict();

export type ShopEntryDef = z.infer<typeof shopEntrySchema>;

const shopArchetypeDefSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    /** Registered NpcDef id used when spawning the shopkeeper NPC. */
    npcId: z.string().min(1),
    /** Per-archetype price multiplier applied on top of tier pricing. */
    priceMultiplier: z.number().positive(),
    minInventorySize: z.number().int().positive(),
    maxInventorySize: z.number().int().positive(),
    entries: z.array(shopEntrySchema).min(1),
  })
  .strict()
  .refine((a) => a.minInventorySize <= a.maxInventorySize, {
    message: 'minInventorySize must be <= maxInventorySize',
  })
  .refine((a) => a.entries.length >= a.minInventorySize, {
    message: 'entries.length must be >= minInventorySize',
  });

export type ShopArchetypeDef = z.infer<typeof shopArchetypeDefSchema>;

const shopArchetypePackSchema = z
  .object({
    _note: z.string().optional(),
    version: z.number().int().positive(),
    archetypes: z.array(shopArchetypeDefSchema).min(1),
  })
  .strict();

/**
 * Item ids a shop archetype may stock: every `weapons.json` id that the
 * merchant purchase path can resolve onto a bag item via
 * `resolveShopCatalogItem`. A weapon id qualifies once either a
 * weapon-equipment def activates it, or it has its own catalog-only `items.ts`
 * entry of the same id — otherwise the offer would render with a name and
 * price but refuse the purchase as `unknown-item`. This deliberately does NOT
 * enumerate `items.ts` at large: a non-weapon catalog slug (e.g. a consumable)
 * is not a valid archetype entry even though `resolveShopCatalogItem` would
 * resolve it. `SHOPKEEPER_EQUIPMENT_ITEM_ID` (the merchant's-charm) is
 * likewise never admitted — see the module docblock.
 */
export function knownShopItemIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const weapon of weaponsJson as Array<{ id: string }>) {
    if (isShopCatalogItem(weapon.id)) {
      ids.add(weapon.id);
    }
  }
  return ids;
}

let cachedArchetypes: readonly ShopArchetypeDef[] | null = null;

/** Load, validate, and cache the shop archetypes. */
export function loadShopArchetypes(): readonly ShopArchetypeDef[] {
  if (cachedArchetypes !== null) return cachedArchetypes;
  const parsed = shopArchetypePackSchema.parse(archetypesJson);
  const known = knownShopItemIds();
  const seen = new Set<string>();
  for (const archetype of parsed.archetypes) {
    if (seen.has(archetype.id)) {
      throw new Error(`Duplicate shop archetype id: ${archetype.id}`);
    }
    seen.add(archetype.id);
    for (const entry of archetype.entries) {
      if (!known.has(entry.itemId)) {
        throw new Error(
          `Shop archetype "${archetype.id}" references unpurchasable itemId "${entry.itemId}"`,
        );
      }
    }
  }
  const quartermasterCount = parsed.archetypes.filter(
    (archetype) => archetype.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
  ).length;
  if (quartermasterCount !== 1) {
    throw new Error(
      `Floor 2 shop archetypes must contain exactly one "${FLOOR2_QUARTERMASTER_ARCHETYPE_ID}" definition; found ${quartermasterCount}`,
    );
  }
  cachedArchetypes = Object.freeze(parsed.archetypes.slice());
  return cachedArchetypes;
}

/** Look up a single archetype by id, or undefined. */
export function getShopArchetype(id: string): ShopArchetypeDef | undefined {
  return loadShopArchetypes().find((a) => a.id === id);
}

/** Test-only reset. */
export function _resetShopArchetypeCache(): void {
  cachedArchetypes = null;
}
