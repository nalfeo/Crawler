import { describe, expect, it } from 'vitest';
import {
  blockReasonFromGold,
  describeShopOfferAvailability,
  describeShopOfferStatus,
  describeShopPurchaseFailure,
  formatShopGoldLine,
  formatShopOfferLabel,
  formatShopPrice,
  isShopOfferPurchasable,
  resolveShopOfferAvailability,
  shopOfferGoldShortfall,
  toShopBlockReason,
  type ShopOffer,
} from '../../src/engine/shop/shop-offer-model.js';

function offer(overrides: Partial<ShopOffer> = {}): ShopOffer {
  return {
    id: 'lucky-charm',
    name: 'Lucky Charm',
    priceGold: 40,
    purchasable: true,
    ...overrides,
  };
}

describe('shop offer model — availability resolution', () => {
  it('reports an eligible offer as available', () => {
    expect(resolveShopOfferAvailability(offer())).toBe('available');
    expect(isShopOfferPurchasable(offer())).toBe(true);
  });

  it('treats exhausted stock as sold out even when the offer claims to be purchasable', () => {
    expect(resolveShopOfferAvailability(offer({ stock: 0 }))).toBe('sold-out');
    expect(isShopOfferPurchasable(offer({ stock: 0 }))).toBe(false);
  });

  it('treats owned offers as owned before any affordability reason', () => {
    expect(
      resolveShopOfferAvailability(
        offer({ owned: true, purchasable: false, blockedReason: 'insufficient-funds' }),
      ),
    ).toBe('owned');
  });

  it('leaves unlimited stock (undefined) purchasable', () => {
    expect(resolveShopOfferAvailability(offer({ stock: undefined }))).toBe('available');
  });

  it('surfaces the authoritative block reason when the purchase is refused', () => {
    expect(
      resolveShopOfferAvailability(
        offer({ purchasable: false, blockedReason: 'insufficient-funds' }),
      ),
    ).toBe('insufficient-funds');
    expect(
      resolveShopOfferAvailability(
        offer({ purchasable: false, blockedReason: 'inventory-capacity' }),
      ),
    ).toBe('inventory-capacity');
    expect(
      resolveShopOfferAvailability(offer({ purchasable: false, blockedReason: 'sold-out' })),
    ).toBe('sold-out');
    expect(
      resolveShopOfferAvailability(offer({ purchasable: false, blockedReason: 'owned' })),
    ).toBe('owned');
  });

  it('falls back to unavailable for a refusal with no known reason', () => {
    expect(resolveShopOfferAvailability(offer({ purchasable: false }))).toBe('unavailable');
    expect(
      resolveShopOfferAvailability(offer({ purchasable: false, blockedReason: 'unknown' })),
    ).toBe('unavailable');
  });
});

describe('shop offer model — failure-code normalization', () => {
  it('maps merchant-specific purchase failure codes onto shared block reasons', () => {
    expect(toShopBlockReason('insufficient-funds')).toBe('insufficient-funds');
    expect(toShopBlockReason('inventory-capacity')).toBe('inventory-capacity');
    expect(toShopBlockReason('stock-unavailable')).toBe('sold-out');
    expect(toShopBlockReason('owned')).toBe('owned');
  });

  it('only blames gold when gold is actually short for codeless merchants', () => {
    expect(blockReasonFromGold(60, 10)).toBe('insufficient-funds');
    expect(blockReasonFromGold(60, 60)).toBe('unknown');
    expect(blockReasonFromGold(60, 500)).toBe('unknown');
  });

  it('renders a codeless refusal the player can afford as unavailable, not too expensive', () => {
    const refused = offer({
      priceGold: 60,
      purchasable: false,
      blockedReason: blockReasonFromGold(60, 500),
    });
    expect(resolveShopOfferAvailability(refused)).toBe('unavailable');
    expect(describeShopOfferStatus(resolveShopOfferAvailability(refused))).toBe(
      'Unavailable right now.',
    );
  });

  it('never guesses at an unrecognized or absent code', () => {
    expect(toShopBlockReason('invalid-stock-identity')).toBe('unknown');
    expect(toShopBlockReason(null)).toBe('unknown');
    expect(toShopBlockReason(undefined)).toBe('unknown');
  });
});

describe('shop offer model — shared wording', () => {
  it('formats prices, wallet lines and row labels identically for every merchant', () => {
    expect(formatShopPrice(40)).toBe('40g');
    expect(formatShopGoldLine(120)).toBe('Gold: 120g');
    expect(formatShopOfferLabel(offer())).toBe('Lucky Charm (40g)');
  });

  it('computes the gold shortfall, clamped at zero', () => {
    expect(shopOfferGoldShortfall(offer({ priceGold: 40 }), 25)).toBe(15);
    expect(shopOfferGoldShortfall(offer({ priceGold: 40 }), 40)).toBe(0);
    expect(shopOfferGoldShortfall(offer({ priceGold: 40 }), 90)).toBe(0);
  });

  it('gives every availability state a badge and a status sentence', () => {
    expect(describeShopOfferAvailability('available')).toBe('Buy');
    expect(describeShopOfferAvailability('sold-out')).toBe('Sold out');
    expect(describeShopOfferAvailability('owned')).toBe('Owned');
    expect(describeShopOfferAvailability('insufficient-funds')).toBe('No gold');
    expect(describeShopOfferAvailability('inventory-capacity')).toBe('Inv. full');
    expect(describeShopOfferAvailability('unavailable')).toBe('N/A');

    expect(describeShopOfferStatus('available')).toBeUndefined();
    expect(describeShopOfferStatus('sold-out')).toBe('Sold out.');
    expect(describeShopOfferStatus('owned')).toBe('Already owned.');
    expect(describeShopOfferStatus('insufficient-funds')).toBe('Not enough gold.');
    expect(describeShopOfferStatus('inventory-capacity')).toBe('No room in your bag.');
    expect(describeShopOfferStatus('unavailable')).toBe('Unavailable right now.');
  });

  it('maps purchase failures onto one player-facing hint per reason', () => {
    expect(describeShopPurchaseFailure('insufficient-funds')).toBe(
      'Purchase failed — not enough gold.',
    );
    expect(describeShopPurchaseFailure('inventory-capacity')).toBe(
      'Purchase failed — inventory is full.',
    );
    expect(describeShopPurchaseFailure('owned')).toBe('Purchase failed — you already own that.');
    expect(describeShopPurchaseFailure('stock-unavailable')).toBe(
      'Purchase failed — shop stock changed.',
    );
    expect(describeShopPurchaseFailure(undefined)).toBe('Purchase failed — shop stock changed.');
  });
});
