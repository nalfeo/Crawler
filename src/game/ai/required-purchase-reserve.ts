import type { GameWorld } from '../../core/world.js';
import { getWorldFloorBehavior } from '../../core/floor-behavior.js';
import { FLOOR1_SHOP_QUEST_ID, UNPAID_SHOPKEEPER_STAGES } from '../../shared/quest-types.js';
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
 * Scoped by floor *config*, not by floor id: the reserve only applies on a floor
 * that has actually been entered (`floorId` assigned) and whose manifest gates
 * equipment behind the merchant charm errand this module can actually read.
 * {@link getShopkeeperStage} and {@link SHOPKEEPER_EQUIPMENT_COST} are specific to
 * {@link FLOOR1_SHOP_QUEST_ID}, so a floor that declares
 * `merchantCharmGatesEquipment` with a *different* `prerequisiteQuestId` gets no
 * reserve: its stage would read as the unpaid `not-met` stage for an errand it
 * never runs, and the AI would hold back gold forever. Such a floor opts in by
 * generalizing the stage/cost lookup here, not by declaring the flag alone. The
 * explicit `floorId` requirement keeps synthetic worlds (no floor assigned) from
 * inheriting Floor 1's charm gate through the numeric-floor fallback.
 */
export function requiredShopPurchaseReserve(world: GameWorld): number {
  if (
    !world.floorId ||
    getWorldFloorBehavior(world).merchantCharmGatesEquipment?.prerequisiteQuestId !==
      FLOOR1_SHOP_QUEST_ID
  ) {
    return 0;
  }
  return UNPAID_SHOPKEEPER_STAGES.has(getShopkeeperStage(world)) ? SHOPKEEPER_EQUIPMENT_COST : 0;
}
