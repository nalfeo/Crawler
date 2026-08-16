import type { GameWorld } from '../../core/world.js';
import { equipFromBag } from '../../core/systems/equipmentSystem.js';
import { hasItem } from '../../shared/inventory.js';
import {
  getShopkeeperPostQuestStock,
  purchaseShopkeeperPostQuestItem,
  type ShopkeeperStockItem,
} from '../floorScenario.js';
import { canFarmOptionalMerchantPurchase, type Floor1RunPlan } from './run-planner.js';
import { ensureSpellBrokerDecision, isSpellBrokerPurchaseActive } from './spell-broker-intent.js';

export type MerchantWeaponIntentStatus =
  | 'pending'
  | 'declined'
  | 'farming'
  | 'returning'
  /**
   * Bought and sitting in the bag, but not yet equipped because the player was
   * not in a safe context when the purchase completed. Terminal for the
   * *purchase* decision (no re-farm, no re-buy, never abandoned) and retried
   * every tick by {@link executeMerchantWeaponPurchase} until the player next
   * stands somewhere the Equipment panel would open.
   */
  | 'awaiting-equip'
  | 'purchased'
  | 'abandoned';

export interface MerchantWeaponIntent {
  readonly enabled: boolean;
  readonly decisionMade: boolean;
  readonly status: MerchantWeaponIntentStatus;
  readonly itemId: string | null;
  readonly cost: number;
}

const intents = new WeakMap<GameWorld, MerchantWeaponIntent>();

function initialIntent(enabled: boolean): MerchantWeaponIntent {
  return {
    enabled,
    decisionMade: false,
    status: 'pending',
    itemId: null,
    cost: 0,
  };
}

export function configureMerchantWeaponPurchase(world: GameWorld, enabled: boolean): void {
  const current = intents.get(world);
  intents.set(world, current ? { ...current, enabled } : initialIntent(enabled));
}

export function getMerchantWeaponIntent(world: GameWorld): MerchantWeaponIntent {
  return intents.get(world) ?? initialIntent(false);
}

export function selectMerchantWeapon(
  world: GameWorld,
  stock: readonly ShopkeeperStockItem[],
): ShopkeeperStockItem | null {
  if (stock.length === 0) {
    return null;
  }
  return stock[world.rng.nextInt(0, stock.length - 1)] ?? null;
}

export function updateMerchantWeaponIntent(
  world: GameWorld,
  runPlan: Floor1RunPlan | null,
  goldFarmMs: number,
): MerchantWeaponIntent {
  let intent = getMerchantWeaponIntent(world);
  if (!intent.enabled || intent.status === 'declined' || intent.status === 'purchased') {
    return intent;
  }
  // Already bought — the only work left is the safe-context equip, which
  // `executeMerchantWeaponPurchase` retries. Re-running the farm/afford
  // decision here could otherwise flip a paid-for weapon back to 'farming'
  // (gold was just spent, so the deficit test sees a shortfall) or straight to
  // 'abandoned', losing an item the player already owns.
  if (intent.status === 'awaiting-equip') {
    return intent;
  }
  if (intent.status === 'abandoned') {
    return intent;
  }
  const spellBrokerIntent = ensureSpellBrokerDecision(world);
  if (isSpellBrokerPurchaseActive(spellBrokerIntent)) {
    return intent;
  }
  if (world.goalFlags.get('floor1-shop-quest-complete') !== true) {
    return intent;
  }

  if (!intent.decisionMade) {
    if (world.rng.next() >= 0.5) {
      intent = { ...intent, decisionMade: true, status: 'declined' };
      intents.set(world, intent);
      return intent;
    }
    const selected = selectMerchantWeapon(world, getShopkeeperPostQuestStock(world));
    if (!selected) {
      intent = { ...intent, decisionMade: true, status: 'abandoned' };
      intents.set(world, intent);
      return intent;
    }
    intent = {
      ...intent,
      decisionMade: true,
      status: 'farming',
      itemId: selected.itemId,
      cost: selected.cost,
    };
  }

  const deficit = Math.max(0, intent.cost - world.playerGold);
  if (deficit === 0) {
    intent = { ...intent, status: 'returning' };
  } else if (runPlan?.droppedOptionalBundleIds.includes('merchant-weapon-purchase')) {
    intent = { ...intent, status: 'abandoned' };
  } else if (runPlan?.includedOptionalBundleIds.includes('merchant-weapon-purchase')) {
    intent = { ...intent, status: 'farming' };
  } else if (!canFarmOptionalMerchantPurchase(runPlan, deficit, goldFarmMs)) {
    // The decision poll precedes the first graph containing this newly chosen
    // bundle, so use required-only slack once. Subsequent polls consume the
    // planner's explicit include/drop verdict above instead of double-counting
    // the already-budgeted farm work.
    intent = { ...intent, status: 'abandoned' };
  } else {
    intent = { ...intent, status: 'farming' };
  }
  intents.set(world, intent);
  return intent;
}

/**
 * Drive the merchant weapon purchase to completion.
 *
 * Two distinct steps that can complete on different ticks:
 *
 * 1. **Buy** (`returning`): needs physical presence at the merchant. Runs once.
 * 2. **Equip** (`awaiting-equip` → `purchased`): needs a safe context, exactly
 *    like the human Equipment panel. There is no `force` bypass.
 *
 * Splitting them matters: before this split a failed equip called `abandon()`,
 * which would now discard a weapon the AI had already paid for merely because
 * it was standing outside a safe room at the moment of purchase. The purchase
 * is therefore latched as `awaiting-equip` and retried on every subsequent
 * tick, completing on the next safe-room entry.
 *
 * Returns `true` only on the tick the weapon actually becomes equipped.
 */
export function executeMerchantWeaponPurchase(world: GameWorld, playerEid: number): boolean {
  const intent = getMerchantWeaponIntent(world);
  if (!intent.enabled || !intent.itemId) {
    return false;
  }
  if (intent.status !== 'returning' && intent.status !== 'awaiting-equip') {
    return false;
  }
  const itemId = intent.itemId;
  const abandon = (): false => {
    intents.set(world, { ...intent, status: 'abandoned' });
    return false;
  };
  const bag = world.inventories.get(playerEid);
  if (!bag) {
    return abandon();
  }
  if (!hasItem(bag, itemId) && !purchaseShopkeeperPostQuestItem(world, playerEid, itemId)) {
    return abandon();
  }
  const equipped = equipFromBag(world, playerEid, itemId);
  if (!equipped.ok) {
    // Bought but not equippable right now (almost always: not in a safe
    // context). Latch so the purchase is never repeated or discarded, and let
    // the next tick retry the equip.
    intents.set(world, { ...intent, status: 'awaiting-equip' });
    return false;
  }
  intents.set(world, { ...intent, status: 'purchased' });
  return true;
}
