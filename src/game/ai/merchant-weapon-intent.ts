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

/**
 * Pick which post-quest weapon to intend to buy.
 *
 * Budget-aware and deterministic: prefer the most expensive item the player can
 * already afford (cost is the merchant's own value ranking — the pricier the
 * weapon, the stronger it is), and fall back to the cheapest item in stock when
 * nothing is affordable yet, so the run farms toward the smallest deficit
 * instead of an arbitrary one. Ties break on item id so the choice is stable
 * regardless of stock ordering. Consumes no RNG.
 */
/**
 * Gold the AI holds back for the higher-value optional purchase (a broker
 * spell) while that purchase is still pending. The two optional purchases used
 * to be mutually exclusive, so a run made at most one of them; they now run
 * concurrently and the spell — the strictly more valuable pickup — keeps
 * priority through this reserve.
 */
export function spellPurchaseReserve(world: GameWorld): number {
  const spellIntent = ensureSpellBrokerDecision(world);
  return isSpellBrokerPurchaseActive(spellIntent) ? spellIntent.cost : 0;
}

export function selectMerchantWeapon(
  world: GameWorld,
  stock: readonly ShopkeeperStockItem[],
): ShopkeeperStockItem | null {
  if (stock.length === 0) {
    return null;
  }
  const byValueDesc = [...stock].sort(
    (a, b) => b.cost - a.cost || a.itemId.localeCompare(b.itemId),
  );
  const budget = world.playerGold - spellPurchaseReserve(world);
  const affordable = byValueDesc.find((entry) => entry.cost <= budget);
  return affordable ?? byValueDesc[byValueDesc.length - 1] ?? null;
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
  // `abandoned` means the deficit couldn't be farmed inside the run's slack,
  // not "never buy". Recover once the player holds the full price outright
  // (over and above the spell reserve) — there is no farming left to fund.
  if (intent.status === 'abandoned') {
    if (!intent.itemId || world.playerGold - spellPurchaseReserve(world) < intent.cost) {
      return intent;
    }
    intent = { ...intent, status: 'returning' };
    intents.set(world, intent);
    return intent;
  }
  if (world.goalFlags.get('floor1-shop-quest-complete') !== true) {
    return intent;
  }

  if (!intent.decisionMade) {
    // Budget-aware policy: always intend to convert leftover gold into power.
    // Affordability is resolved by the farming/abandon lifecycle below, not by
    // a coin flip. The selection is made against gold that remains *after* the
    // higher-value spell purchase, because `selectMerchantWeapon` subtracts the
    // spell reserve from its budget.
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

  const deficit = Math.max(0, intent.cost + spellPurchaseReserve(world) - world.playerGold);
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
  // Not affordable *yet* once the spell reserve is honoured — stay pending
  // rather than abandoning, so the run can come back after farming.
  if (
    !hasItem(bag, intent.itemId) &&
    world.playerGold - intent.cost < spellPurchaseReserve(world)
  ) {
    return false;
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
