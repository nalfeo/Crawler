/**
 * Floor 2 shop-archetype registry — data-driven pool from
 * `shop-archetypes.floor2.json`. `generateShopInventory` in
 * `src/core/generateShopInventory.ts` consumes these archetypes to roll a
 * seeded per-run shop inventory.
 *
 * Archetype entries reference *existing* item ids: the weapons in
 * `weapons.json` and the merchant's-charm (`SHOPKEEPER_EQUIPMENT_ITEM_ID`).
 * The loader validates that invariant at load-time so a data typo can't ship.
 *
 * Prices are the *base* per-item price. Runtime price is
 * `basePrice * archetype.priceMultiplier * (tuning.shopPricing.tierMultiplier ?? 1)`.
 */
import { z } from 'zod';
import archetypesJson from './shop-archetypes.floor2.json';
import weaponsJson from './weapons.json';
import { SHOPKEEPER_EQUIPMENT_ITEM_ID } from '../quest-types.js';

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

/** Known item ids referenceable by shop archetypes. */
export function knownShopItemIds(): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const weapon of weaponsJson as Array<{ id: string }>) {
    ids.add(weapon.id);
  }
  ids.add(SHOPKEEPER_EQUIPMENT_ITEM_ID);
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
          `Shop archetype "${archetype.id}" references unknown itemId "${entry.itemId}"`,
        );
      }
    }
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
