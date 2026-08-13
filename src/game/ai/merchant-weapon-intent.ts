import type { GameWorld } from '../../core/world.js';
import { equipFromBag } from '../../core/systems/equipmentSystem.js';
import { hasItem } from '../../shared/inventory.js';
import {
  getShopkeeperPostQuestStock,
  purchaseShopkeeperPostQuestItem,
  type ShopkeeperStockItem,
} from '../floorScenario.js';
import { canFarmOptionalMerchantPurchase, type Floor1RunPlan } from './run-planner.js';
import { ensureSpellBrokerDecision, getSpellBrokerIntent } from './spell-broker-intent.js';

export type MerchantWeaponIntentStatus =
  | 'pending'
  | 'declined'
  | 'farming'
  | 'returning'
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
  const spellBrokerIntent = ensureSpellBrokerDecision(world);
  if (
    intent.enabled &&
    spellBrokerIntent.shouldBuy &&
    getSpellBrokerIntent(world).purchaseStatus !== 'abandoned'
  ) {
    intent = { ...intent, decisionMade: true, status: 'declined' };
    intents.set(world, intent);
    return intent;
  }
  if (!intent.enabled || intent.status === 'declined' || intent.status === 'purchased') {
    return intent;
  }
  if (intent.status === 'abandoned') {
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

export function executeMerchantWeaponPurchase(world: GameWorld, playerEid: number): boolean {
  const intent = getMerchantWeaponIntent(world);
  if (!intent.enabled || intent.status !== 'returning' || !intent.itemId) {
    return false;
  }
  const abandon = (): false => {
    intents.set(world, { ...intent, status: 'abandoned' });
    return false;
  };
  const bag = world.inventories.get(playerEid);
  if (!bag) {
    return abandon();
  }
  if (
    !hasItem(bag, intent.itemId) &&
    !purchaseShopkeeperPostQuestItem(world, playerEid, intent.itemId)
  ) {
    return abandon();
  }
  const equipped = equipFromBag(world, playerEid, intent.itemId, { force: true });
  if (!equipped.ok) {
    return abandon();
  }
  intents.set(world, { ...intent, status: 'purchased' });
  return true;
}
