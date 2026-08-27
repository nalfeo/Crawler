import type { GameWorld } from '../../core/world.js';
import { UNPAID_SHOPKEEPER_STAGES } from '../../shared/quest-types.js';
import { getShopkeeperStage, SHOPKEEPER_EQUIPMENT_COST } from '../floorScenario.js';

/**
 * Gold the AI holds back for the **required** shopkeeper charm while that
 * errand is still unpaid.
 *
 * The charm is not optional: the shop errand — and with it one of the three
 * goal flags the boss-stair door needs — cannot complete until it is bought.
 * The AI only commits to walking to the merchant once it is holding
 * {@link SHOPKEEPER_EQUIPMENT_COST}, so an *optional* purchase that spends that
 * gold mid-trip strands the run at the counter with an unaffordable charm and
 * forces an extra farm-and-return round trip past the same vendor. Observed on
 * seed 42: broker spell at 148.4s → merchant at 148.8s holding 32g of the 60g
 * charm → `unaffordable` → second merchant trip at 202.9s.
 *
 * Reserving the outstanding required cost keeps the committed trip funded, so
 * the run buys the charm on the trip it already planned and farms for the
 * optional pickup afterwards instead of walking the same route twice. Lives in
 * its own module so both intent lifecycles can read it without
 * `merchant-weapon-intent` ⇄ `spell-broker-intent` importing each other.
 *
 * Scoped to Floor 1: the shop errand is a Floor 1 quest, and
 * {@link getShopkeeperStage} reports `not-met` for any world that simply has no
 * such quest, which would otherwise reserve gold on every other floor forever.
 */
export function requiredShopPurchaseReserve(world: GameWorld): number {
  if (world.floorId !== 'floor1') {
    return 0;
  }
  return UNPAID_SHOPKEEPER_STAGES.has(getShopkeeperStage(world)) ? SHOPKEEPER_EQUIPMENT_COST : 0;
}
