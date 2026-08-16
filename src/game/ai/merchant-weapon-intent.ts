import type { GameWorld } from '../../core/world.js';
import { recordVendorDecision } from '../../core/world.js';
import { equipFromBag } from '../../core/systems/equipmentSystem.js';
import { hasItem } from '../../shared/inventory.js';
import { SeededRandom, hashStringToSeed } from '../../shared/random.js';
import {
  FLOOR1_MERCHANT_VENDOR_ID,
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
  if (!isSpellBrokerPurchaseActive(spellIntent) || spellIntent.purchaseCount > 0) {
    // Only the run's *first* spell outranks the weapon. A repeat purchase off
    // the broker's stepped-down rack is a sink for gold the run has no
    // other use for, so reserving for it would let an unaffordable second
    // spell block an affordable weapon and bank the gold instead.
    return 0;
  }
  return spellIntent.cost;
}

/**
 * Probability that a run is willing to switch its main weapon class at the
 * merchant at all.
 *
 * Buying the merchant's rack is not a routine gold sink: it re-classes the run
 * (combat behavior, stat allocation, and every later equipment decision follow
 * the main weapon), so it must read as an occasional, deliberate pivot rather
 * than something every contestant does on the way past. The roll gates the
 * *willingness*; affordability and the run deadline still decide whether a
 * willing run actually completes the switch.
 *
 * **0.5 is a designer-set ceiling, not a free tuning knob.** Half the runs is
 * the most willingness the switch may carry; a lower value is allowed only when
 * the Floor 1 economy gate still passes, and the gate ceiling itself must never
 * be raised to buy headroom (rule #11).
 *
 * Measured over the 25-seed `GATE_SEEDS` panel: always-willing (the original
 * policy) bought a weapon in 8/25 runs at a 33.4% median unspent-spendable
 * share; 0.75 gave 7/25 and 33.3%. At 0.5 the weapon buy-rate falls to 4/25 and
 * the banked gold pushed the median to **37.2%**, over the gate's 35% ceiling —
 * so 0.5 ships together with the broker's repeat-purchase sink (see
 * `floor1SpellBrokerOfferCost` and `FLOOR1_SPELL_BROKER_MAX_PURCHASES`), which
 * gives a declining run somewhere to put the gold: 4/25 weapons, 10/25 second
 * spells, **29.1%** median unspent, 25/25 wins.
 */
export const MERCHANT_WEAPON_SWITCH_CHANCE = 0.5;

/**
 * Deterministic per-run willingness roll, drawn from a dedicated
 * seed-derived stream so it consumes **no** gameplay RNG (rule #3/#4): the same
 * seed always makes the same shopping choice, and enabling the intent cannot
 * shift the simulation's RNG sequence.
 */
export function rollsMerchantWeaponSwitch(seed: number): boolean {
  const rng = new SeededRandom(hashStringToSeed(`${seed}:floor1-merchant-weapon-switch`));
  // Discard the first draw: xorshift32's opening output stays correlated with
  // its seed, so consecutive small seeds (exactly the contiguous gate panel)
  // decide alike. Measured over seeds 1..1000 both draws sit at ~50%, but the
  // 1..25 prefix reads 24% on the first draw and 48% on the second.
  rng.next();
  return rng.next() < MERCHANT_WEAPON_SWITCH_CHANCE;
}

/**
 * Gold held back for a still-pending weapon-class switch.
 *
 * The mirror of {@link spellPurchaseReserve}: the *first* broker spell outranks
 * the weapon, but a **repeat** spell is a luxury sink and must not eat the gold
 * a run is actively farming toward its one class switch — otherwise the switch,
 * which the willingness roll already makes an occasional event, could never
 * complete once a run owned a spell.
 */
export function merchantWeaponReserve(world: GameWorld): number {
  const intent = getMerchantWeaponIntent(world);
  if (!intent.enabled) {
    return 0;
  }
  if (intent.itemId === null) {
    // The weapon decision is made only after the shop quest completes, which
    // can land *after* the broker is first reachable. Until then, reserve the
    // cheapest thing the rack could sell — but only for a run whose willingness
    // roll will actually want the switch, so a declining run's gold stays free
    // for the repeat spell. The roll is a pure function of the seed, so reading
    // it early consumes no RNG and cannot change the decision made later.
    if (intent.decisionMade || !rollsMerchantWeaponSwitch(world.seed)) {
      return 0;
    }
    const stock = getShopkeeperPostQuestStock(world);
    return stock.length === 0 ? 0 : Math.min(...stock.map((entry) => entry.cost));
  }
  // `abandoned` counts too: it means "couldn't farm the deficit in time", and
  // the lifecycle above explicitly recovers such an intent once the run holds
  // the price outright. Letting a repeat spell spend that gold first would
  // permanently cancel a switch the run still wants.
  return intent.status === 'declined' || intent.status === 'purchased' ? 0 : intent.cost;
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
    // Switching main weapon class is a run-defining pivot, not a routine
    // purchase, so a run first rolls whether it wants one at all (see
    // MERCHANT_WEAPON_SWITCH_CHANCE). A declined run keeps its starter and its
    // gold; a willing run's affordability is then resolved by the
    // farming/abandon lifecycle below, not by a second coin flip. The
    // selection is made against gold that remains *after* the higher-value
    // spell purchase, because `selectMerchantWeapon` subtracts the spell
    // reserve from its budget.
    if (!rollsMerchantWeaponSwitch(world.seed)) {
      intent = { ...intent, decisionMade: true, status: 'declined' };
      intents.set(world, intent);
      recordVendorDecision(world, {
        vendorId: FLOOR1_MERCHANT_VENDOR_ID,
        itemId: null,
        cost: 0,
        outcome: 'declined',
        reason: 'no-weapon-class-switch-this-run',
      });
      return intent;
    }
    const selected = selectMerchantWeapon(world, getShopkeeperPostQuestStock(world));
    if (!selected) {
      intent = { ...intent, decisionMade: true, status: 'abandoned' };
      intents.set(world, intent);
      recordVendorDecision(world, {
        vendorId: FLOOR1_MERCHANT_VENDOR_ID,
        itemId: null,
        cost: 0,
        outcome: 'abandoned',
        reason: 'no-stock',
      });
      return intent;
    }
    intent = {
      ...intent,
      decisionMade: true,
      status: 'farming',
      itemId: selected.itemId,
      cost: selected.cost,
    };
    recordVendorDecision(world, {
      vendorId: FLOOR1_MERCHANT_VENDOR_ID,
      itemId: selected.itemId,
      cost: selected.cost,
      outcome: 'wanted',
      reason: 'weapon-class-switch',
    });
  }

  const previousStatus = intent.status;
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
  if (intent.status === 'abandoned' && previousStatus !== 'abandoned') {
    recordVendorDecision(world, {
      vendorId: FLOOR1_MERCHANT_VENDOR_ID,
      itemId: intent.itemId,
      cost: intent.cost,
      outcome: 'abandoned',
      reason: 'deficit-unfarmable-in-budget',
    });
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
    recordVendorDecision(world, {
      vendorId: FLOOR1_MERCHANT_VENDOR_ID,
      itemId: intent.itemId,
      cost: intent.cost,
      outcome: 'unaffordable',
      reason: 'reserved-for-spell',
    });
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
