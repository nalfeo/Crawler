/**
 * Shop modal presenter — the dialogue-merchant half of the shared shop system.
 *
 * Floor 1 merchants (shopkeeper wares, post-quest stock, the Spell Broker) talk
 * to the player through `ModalPickerUI` rather than the full shop panel. Before
 * this module each of them hand-rolled its own picker config in
 * `MainGameScene`, so prices, wallet lines and "you can't buy that" wording all
 * drifted apart. They now describe themselves as a `ShopModalPresentation` of
 * shared `ShopOffer` snapshots and this module builds the picker config, so
 * every merchant reads identically and a new merchant is a description, not a
 * new UX surface.
 *
 * Pure config construction is framework-free and unit-testable through
 * `openShopModal`; the presenter only adds the picker plumbing.
 */
import type { ModalPickerConfig, ModalPickerOption } from '../../shared/modal-picker.js';
import type { ModalPickerOpenHooks } from '../ModalPickerUI.js';
import {
  describeShopOfferStatus,
  formatShopGoldLine,
  formatShopOfferLabel,
  isShopOfferPurchasable,
  resolveShopOfferAvailability,
  type ShopOffer,
} from './shop-offer-model.js';

/**
 * What to do when the merchant has offers but none of them is purchasable.
 *
 * - `decline` — do not open; the caller falls through to ordinary dialogue.
 * - `open-disabled` — open anyway with disabled rows, so the player still sees
 *   the merchant's stock and *why* they can't buy it yet (the Floor 1 quest
 *   merchant works this way).
 */
export type ShopModalEmptyPolicy = 'decline' | 'open-disabled';

/** Why `openShopModal` refused to open. */
export type ShopModalDeclineReason = 'no-offers' | 'nothing-purchasable';

/** A merchant-agnostic description of a dialogue shop. */
export interface ShopModalPresentation {
  /** Stable automation identity forwarded verbatim to `ModalPickerUI`. */
  readonly kind?: string;
  readonly title: string;
  readonly body?: string;
  /** Player's current gold, rendered as the shared wallet subtitle. */
  readonly gold: number;
  readonly offers: readonly ShopOffer[];
  /** Defaults to `decline`. */
  readonly whenNothingPurchasable?: ShopModalEmptyPolicy;
  /** Defaults to true — merchants are always escapable. */
  readonly allowCancel?: boolean;
}

export interface ShopModalHooks {
  /** Called when the player confirms a purchasable offer. */
  readonly onPurchase: (offer: ShopOffer) => void;
  /** Called instead of opening when the shop has nothing to present. */
  readonly onDeclined?: (reason: ShopModalDeclineReason) => void;
}

/** Minimal `ModalPickerUI` surface the presenter needs. */
interface ShopModalPicker {
  isOpen(): boolean;
  open(config: ModalPickerConfig, hooks?: ModalPickerOpenHooks): void;
}

/** Build the picker config for a shop presentation. Pure. */
function buildShopModalConfig(presentation: ShopModalPresentation): ModalPickerConfig {
  const options: ModalPickerOption[] = presentation.offers.map((offer) => {
    const availability = resolveShopOfferAvailability(offer);
    const status = describeShopOfferStatus(availability);
    const description =
      availability === 'available' ? offer.detail : (status ?? offer.detail ?? undefined);
    const option: ModalPickerOption = {
      id: offer.id,
      label: formatShopOfferLabel(offer),
      ...(description === undefined ? {} : { description }),
      disabled: availability !== 'available',
    };
    return option;
  });
  const firstEnabled = options.find((option) => option.disabled !== true);
  const initialSelectedId = firstEnabled?.id ?? options[0]?.id;
  return {
    ...(presentation.kind === undefined ? {} : { kind: presentation.kind }),
    title: presentation.title,
    subtitle: formatShopGoldLine(presentation.gold),
    ...(presentation.body === undefined ? {} : { body: presentation.body }),
    options,
    allowCancel: presentation.allowCancel ?? true,
    ...(initialSelectedId === undefined ? {} : { initialSelectedId }),
  };
}

/**
 * Open a dialogue merchant on the shared surface.
 *
 * Returns true when the merchant took over the interaction (modal opened, or
 * one was already open), false when the caller should fall through to its
 * normal dialogue flow.
 */
export function openShopModal(
  picker: ShopModalPicker,
  presentation: ShopModalPresentation,
  hooks: ShopModalHooks,
): boolean {
  if (picker.isOpen()) return true;
  if (presentation.offers.length === 0) {
    hooks.onDeclined?.('no-offers');
    return false;
  }
  const anyPurchasable = presentation.offers.some((offer) => isShopOfferPurchasable(offer));
  if (!anyPurchasable && (presentation.whenNothingPurchasable ?? 'decline') === 'decline') {
    hooks.onDeclined?.('nothing-purchasable');
    return false;
  }
  picker.open(buildShopModalConfig(presentation), {
    onConfirm: ({ option }) => {
      const offer = presentation.offers.find((candidate) => candidate.id === option.id);
      // Re-check against the snapshot: disabled rows are still confirmable on
      // some input paths, and the authoritative purchase call happens in the
      // merchant's own `onPurchase` handler.
      if (offer && isShopOfferPurchasable(offer)) {
        hooks.onPurchase(offer);
      }
    },
  });
  return true;
}
