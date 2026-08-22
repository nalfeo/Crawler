/**
 * Shared merchant/shop presentation model.
 *
 * Every merchant surface in the game — the Floor 2 shop panel
 * (`ShopPanelUI.ts`) and the Floor 1 dialogue merchants presented through
 * `ModalPickerUI` (shopkeeper wares, post-quest stock, Spell Broker) — projects
 * its stock into the `ShopOffer` snapshot defined here, so the wording and the
 * availability rules the player reads are identical everywhere.
 *
 * This module is deliberately **presentation-only and framework-free**: it
 * never re-derives whether a purchase is legal. Eligibility is authoritative in
 * core/game (`quartermaster-purchase.ts`, `settlement-shop-purchase.ts`, the
 * shopkeeper/spell-broker scene options) and is handed to the snapshot via
 * `purchasable` / `blockedReason`. That keeps the UI from disagreeing with the
 * simulation, and keeps this file pure and unit-testable (no Phaser imports).
 */

/** Why an authoritative purchase check refused an offer. */
export type ShopPurchaseBlockReason =
  | 'insufficient-funds'
  | 'inventory-capacity'
  | 'sold-out'
  | 'owned'
  | 'unknown';

/**
 * Single resolved display state for an offer. Merchants supply overlapping
 * inputs (stock counts, ownership, affordability, block reasons); the UI reads
 * exactly one of these so it can never render, say, an enabled sold-out row.
 */
export type ShopOfferAvailability =
  | 'available'
  | 'sold-out'
  | 'owned'
  | 'insufficient-funds'
  | 'inventory-capacity'
  | 'unavailable';

/** A merchant-agnostic snapshot of one purchasable offer. */
export interface ShopOffer {
  /** Stable id used for selection/confirmation routing. */
  readonly id: string;
  /** Player-facing item/spell name. */
  readonly name: string;
  /** Unit price in gold. */
  readonly priceGold: number;
  /** Optional flavour/stat line shown under the name. */
  readonly detail?: string;
  /** Remaining stock. `undefined` means "unlimited / not stock-tracked". */
  readonly stock?: number;
  /** True when the player already owns this offer (spell bought, item held). */
  readonly owned?: boolean;
  /** Authoritative eligibility from the owning purchase logic. */
  readonly purchasable: boolean;
  /** Authoritative refusal reason, used when `purchasable` is false. */
  readonly blockedReason?: ShopPurchaseBlockReason;
}

/**
 * Collapse an offer's inputs into a single display state. Order matters: stock
 * and ownership are terminal facts, then authoritative eligibility, then the
 * recorded refusal reason.
 */
export function resolveShopOfferAvailability(offer: ShopOffer): ShopOfferAvailability {
  if (offer.stock !== undefined && offer.stock <= 0) return 'sold-out';
  if (offer.owned === true) return 'owned';
  if (offer.purchasable) return 'available';
  switch (offer.blockedReason) {
    case 'insufficient-funds':
      return 'insufficient-funds';
    case 'inventory-capacity':
      return 'inventory-capacity';
    case 'sold-out':
      return 'sold-out';
    case 'owned':
      return 'owned';
    default:
      return 'unavailable';
  }
}

/**
 * Normalize a purchase-failure code from any merchant's purchase logic
 * (`QuartermasterPurchaseFailureCode`, `SettlementShopPurchaseFailureCode`, or
 * a merchant-specific string) onto the shared block reasons the UI renders.
 * Unrecognized codes deliberately fall back to `unknown` rather than guessing.
 */
export function toShopBlockReason(code: string | null | undefined): ShopPurchaseBlockReason {
  switch (code) {
    case 'insufficient-funds':
      return 'insufficient-funds';
    case 'inventory-capacity':
      return 'inventory-capacity';
    case 'stock-unavailable':
    case 'sold-out':
      return 'sold-out';
    case 'owned':
      return 'owned';
    default:
      return 'unknown';
  }
}

/**
 * Block reason for a merchant that refuses a purchase without reporting a code.
 * Such a merchant can decline for reasons beyond price (already learned, no
 * free slot), so a gold shortfall is only claimed when gold is genuinely short;
 * otherwise the offer reads as unavailable rather than mislabeled as too
 * expensive.
 */
export function blockReasonFromGold(
  priceGold: number,
  playerGold: number,
): ShopPurchaseBlockReason {
  return playerGold < priceGold ? 'insufficient-funds' : 'unknown';
}

/** True when the player can buy this offer right now. */
export function isShopOfferPurchasable(offer: ShopOffer): boolean {
  return resolveShopOfferAvailability(offer) === 'available';
}

/** `40g` — the one price format every merchant uses. */
export function formatShopPrice(priceGold: number): string {
  return `${priceGold}g`;
}

/** `Gold: 120g` — the one wallet line every merchant uses. */
export function formatShopGoldLine(playerGold: number): string {
  return `Gold: ${formatShopPrice(playerGold)}`;
}

/** `Lucky Charm (40g)` — the one offer row label every merchant uses. */
export function formatShopOfferLabel(offer: ShopOffer): string {
  return `${offer.name} (${formatShopPrice(offer.priceGold)})`;
}

/** Missing gold for an offer the player cannot afford (0 when affordable). */
export function shopOfferGoldShortfall(offer: ShopOffer, playerGold: number): number {
  return Math.max(0, offer.priceGold - playerGold);
}

/** Compact badge/button label for an availability state (buy buttons, chips). */
export function describeShopOfferAvailability(availability: ShopOfferAvailability): string {
  switch (availability) {
    case 'available':
      return 'Buy';
    case 'sold-out':
      return 'Sold out';
    case 'owned':
      return 'Owned';
    case 'insufficient-funds':
      return 'No gold';
    case 'inventory-capacity':
      return 'Inv. full';
    case 'unavailable':
      return 'N/A';
  }
}

/** Sentence-form status shown beneath a blocked offer row. */
export function describeShopOfferStatus(availability: ShopOfferAvailability): string | undefined {
  switch (availability) {
    case 'available':
      return undefined;
    case 'sold-out':
      return 'Sold out.';
    case 'owned':
      return 'Already owned.';
    case 'insufficient-funds':
      return 'Not enough gold.';
    case 'inventory-capacity':
      return 'No room in your bag.';
    case 'unavailable':
      return 'Unavailable right now.';
  }
}

/** Player-facing failure hint for a refused purchase attempt. */
export function describeShopPurchaseFailure(reason: string | undefined): string {
  switch (reason) {
    case 'insufficient-funds':
      return 'Purchase failed — not enough gold.';
    case 'inventory-capacity':
      return 'Purchase failed — inventory is full.';
    case 'owned':
      return 'Purchase failed — you already own that.';
    default:
      return 'Purchase failed — shop stock changed.';
  }
}
