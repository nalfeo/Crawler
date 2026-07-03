/**
 * Pure, deterministic shop-inventory generator (Floor 2 · Slice 6).
 *
 * Given a `SeededRandom` and an archetype, produces an inventory of unique
 * item entries drawn by weighted-without-replacement from
 * `archetype.entries`. Identical `rng` state + archetype ⇒ identical
 * inventory (property tested).
 *
 * Prices are computed at generation time so the shop UI never has to know
 * about tiers: `unitPrice = round(basePrice * priceMultiplier * tierMultiplier)`
 * with `tierMultiplier` folded in via the optional `options.tierMultiplier`
 * (defaults to `tuning.shopPricing.floor2TierMultiplier`).
 *
 * Layer-safe (core → shared → data). No ECS, no world state, no Math.random().
 */
import type { SeededRandom } from '../shared/random.js';
import type { ShopArchetypeDef, ShopEntryDef } from '../shared/data/shop-archetypes.js';
import tuning from '../shared/data/tuning.json';

/** A single rolled inventory line. */
export interface ShopInventoryItem {
  readonly itemId: string;
  readonly unitPrice: number;
  /** Stock the shopkeeper offers. Slice 6 always emits 1 — spec calls for variety, not stack management. */
  readonly stock: number;
}

/** Full rolled inventory for one shop. */
export interface ShopInventory {
  readonly archetypeId: string;
  readonly items: readonly ShopInventoryItem[];
}

export interface GenerateShopInventoryOptions {
  /** Override the tier multiplier (default: tuning.shopPricing.floor2TierMultiplier). */
  readonly tierMultiplier?: number;
  /** Override the roll size — otherwise a seeded pick in [min, max]. */
  readonly size?: number;
}

/**
 * Generate one shop's inventory deterministically.
 */
export function generateShopInventory(
  rng: SeededRandom,
  archetype: ShopArchetypeDef,
  options: GenerateShopInventoryOptions = {},
): ShopInventory {
  const tierMultiplier = options.tierMultiplier ?? tuning.shopPricing.floor2TierMultiplier;

  const min = archetype.minInventorySize;
  const max = archetype.maxInventorySize;
  const requestedSize = options.size ?? rng.nextInt(min, max);
  const size = Math.min(Math.max(requestedSize, 1), archetype.entries.length);

  // Weighted-without-replacement: copy entries then remove each pick.
  const pool: ShopEntryDef[] = archetype.entries.slice();
  const items: ShopInventoryItem[] = [];
  for (let i = 0; i < size; i += 1) {
    if (pool.length === 0) break;
    const idx = weightedPickIndex(rng, pool);
    const entry = pool[idx]!;
    pool.splice(idx, 1);
    const raw = entry.basePrice * archetype.priceMultiplier * tierMultiplier;
    // Round to nearest gold. Never emit 0/negative prices — clamp low bound.
    const unitPrice = Math.max(1, Math.round(raw));
    items.push({ itemId: entry.itemId, unitPrice, stock: 1 });
  }

  return { archetypeId: archetype.id, items };
}

function weightedPickIndex(rng: SeededRandom, pool: readonly ShopEntryDef[]): number {
  let total = 0;
  for (const entry of pool) total += entry.weight;
  const roll = rng.next() * total;
  let running = 0;
  for (let i = 0; i < pool.length; i += 1) {
    running += pool[i]!.weight;
    if (roll < running) return i;
  }
  // Numerical fallback — return the last index.
  return pool.length - 1;
}
