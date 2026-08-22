import { describe, expect, it, vi } from 'vitest';
import type { ModalPickerConfig } from '../../src/shared/modal-picker.js';
import type { ModalPickerOpenHooks } from '../../src/engine/ModalPickerUI.js';
import { openShopModal } from '../../src/engine/shop/shop-modal-presenter.js';
import type { ShopOffer } from '../../src/engine/shop/shop-offer-model.js';

interface FakePicker {
  readonly opened: Array<{ config: ModalPickerConfig; hooks?: ModalPickerOpenHooks }>;
  isOpen(): boolean;
  open(config: ModalPickerConfig, hooks?: ModalPickerOpenHooks): void;
  confirm(optionId: string): void;
  setOpen(open: boolean): void;
}

function createFakePicker(): FakePicker {
  const opened: Array<{ config: ModalPickerConfig; hooks?: ModalPickerOpenHooks }> = [];
  let open = false;
  return {
    opened,
    isOpen: () => open,
    open(config, hooks) {
      opened.push({ config, hooks });
      open = true;
    },
    confirm(optionId) {
      const last = opened[opened.length - 1];
      const option = last?.config.options.find((candidate) => candidate.id === optionId);
      if (!last || !option) throw new Error(`no option ${optionId}`);
      last.hooks?.onConfirm?.({ option, optionIndex: 0, source: 'keyboard' });
    },
    setOpen(next) {
      open = next;
    },
  };
}

const affordable: ShopOffer = {
  id: 'spark',
  name: 'Spark',
  priceGold: 60,
  detail: 'A permanent spell for this run.',
  purchasable: true,
};
const tooExpensive: ShopOffer = {
  id: 'firestorm',
  name: 'Firestorm',
  priceGold: 300,
  detail: 'A permanent spell for this run.',
  purchasable: false,
  blockedReason: 'insufficient-funds',
};
const alreadyOwned: ShopOffer = {
  id: 'mend',
  name: 'Mend',
  priceGold: 80,
  owned: true,
  purchasable: false,
};

describe('shop modal presenter — config construction', () => {
  it('renders every merchant with the same label, wallet line and disabled rules', () => {
    const picker = createFakePicker();

    openShopModal(
      picker,
      {
        kind: 'spell-broker',
        title: 'The Spell Broker',
        body: 'Choose one.',
        gold: 100,
        offers: [tooExpensive, affordable, alreadyOwned],
      },
      { onPurchase: vi.fn() },
    );
    const config = picker.opened[0]?.config;

    expect(config?.kind).toBe('spell-broker');
    expect(config?.subtitle).toBe('Gold: 100g');
    expect(config?.body).toBe('Choose one.');
    expect(config?.allowCancel).toBe(true);
    expect(config?.options).toEqual([
      {
        id: 'firestorm',
        label: 'Firestorm (300g)',
        description: 'Not enough gold.',
        disabled: true,
      },
      {
        id: 'spark',
        label: 'Spark (60g)',
        description: 'A permanent spell for this run.',
        disabled: false,
      },
      { id: 'mend', label: 'Mend (80g)', description: 'Already owned.', disabled: true },
    ]);
  });

  it('preselects the first purchasable offer rather than a blocked one', () => {
    const picker = createFakePicker();

    openShopModal(
      picker,
      { title: 'Wares', gold: 100, offers: [tooExpensive, affordable] },
      { onPurchase: vi.fn() },
    );

    expect(picker.opened[0]?.config.initialSelectedId).toBe('spark');
  });

  it('falls back to the first row when nothing is purchasable', () => {
    const picker = createFakePicker();

    openShopModal(
      picker,
      {
        title: 'Wares',
        gold: 0,
        offers: [tooExpensive, alreadyOwned],
        whenNothingPurchasable: 'open-disabled',
      },
      { onPurchase: vi.fn() },
    );

    expect(picker.opened[0]?.config.initialSelectedId).toBe('firestorm');
  });

  it('omits the automation kind when the merchant does not declare one', () => {
    const picker = createFakePicker();

    openShopModal(
      picker,
      { title: 'Wares', gold: 10, offers: [affordable] },
      { onPurchase: vi.fn() },
    );

    expect(picker.opened[0]?.config.kind).toBeUndefined();
  });
});

describe('shop modal presenter — opening policy', () => {
  it('opens and routes a confirmed purchase back to the merchant', () => {
    const picker = createFakePicker();
    const onPurchase = vi.fn();

    expect(
      openShopModal(picker, { title: 'Wares', gold: 100, offers: [affordable] }, { onPurchase }),
    ).toBe(true);
    picker.confirm('spark');

    expect(onPurchase).toHaveBeenCalledWith(affordable);
  });

  it('never routes a purchase for a blocked row', () => {
    const picker = createFakePicker();
    const onPurchase = vi.fn();

    openShopModal(
      picker,
      { title: 'Wares', gold: 100, offers: [affordable, tooExpensive] },
      { onPurchase },
    );
    picker.confirm('firestorm');

    expect(onPurchase).not.toHaveBeenCalled();
  });

  it('declines (so the caller falls through to dialogue) when nothing is purchasable', () => {
    const picker = createFakePicker();
    const onDeclined = vi.fn();

    const opened = openShopModal(
      picker,
      { title: 'Wares', gold: 0, offers: [tooExpensive, alreadyOwned] },
      { onPurchase: vi.fn(), onDeclined },
    );

    expect(opened).toBe(false);
    expect(picker.opened).toHaveLength(0);
    expect(onDeclined).toHaveBeenCalledWith('nothing-purchasable');
  });

  it('still opens an unaffordable shop when the merchant asks for the disabled view', () => {
    const picker = createFakePicker();
    const onDeclined = vi.fn();

    const opened = openShopModal(
      picker,
      {
        title: 'Wares',
        gold: 0,
        offers: [tooExpensive],
        whenNothingPurchasable: 'open-disabled',
      },
      { onPurchase: vi.fn(), onDeclined },
    );

    expect(opened).toBe(true);
    expect(onDeclined).not.toHaveBeenCalled();
    expect(picker.opened[0]?.config.options[0]?.disabled).toBe(true);
  });

  it('declines an empty shop without opening', () => {
    const picker = createFakePicker();
    const onDeclined = vi.fn();

    expect(
      openShopModal(
        picker,
        { title: 'Wares', gold: 10, offers: [] },
        { onPurchase: vi.fn(), onDeclined },
      ),
    ).toBe(false);
    expect(onDeclined).toHaveBeenCalledWith('no-offers');
  });

  it('yields to a modal that is already open instead of stacking one', () => {
    const picker = createFakePicker();
    picker.setOpen(true);

    expect(
      openShopModal(
        picker,
        { title: 'Wares', gold: 100, offers: [affordable] },
        { onPurchase: vi.fn() },
      ),
    ).toBe(true);
    expect(picker.opened).toHaveLength(0);
  });
});
