import type { GameWorld } from '../../core/world.js';
import { getAbilityDefinition } from '../abilities/registry.js';
import { getActiveWeaponDef, getActiveWeaponSnapshot } from '../../core/active-weapon.js';
import { listGeneratedEquipmentInstances } from '../../core/generated-equipment-registry.js';
import { findGeneratedPhysicalOwners } from '../../core/systems/equipmentSystem.js';
import { getQuartermasterOfferViews } from '../../core/quartermaster-purchase.js';
import { canPurchaseSpellBrokerSpell, getOfferedBossRewardSpellIds } from '../floorScenario.js';
import { generatedEquipmentCatalogKey } from './headless-run-data.js';
import {
  recordBuildSnapshot,
  recordChoiceOffer,
  recordChoiceSelection,
  type BuildEntry,
  type ChoiceBuildRecorder,
} from './choice-build-telemetry.js';

export function readChoiceBuild(world: GameWorld, playerEid: number): BuildEntry[] {
  const build: BuildEntry[] = [];
  const abilities = world.abilityStatesByEntity.get(playerEid);
  const active = new Set(abilities?.equippedActiveAbilityIds ?? []);
  const learned = new Set(abilities?.learnedSpellIds ?? []);
  for (const id of new Set([...learned, ...(abilities?.ownedActiveAbilityIds ?? []), ...active]))
    build.push({
      catalogKey: `${getAbilityDefinition(id)?.kind === 'spell' || learned.has(id) ? 'spell' : 'ability'}:${id}`,
      location: active.has(id) ? 'active' : 'owned',
    });
  for (const id of new Set(abilities?.passiveAbilityIds ?? []))
    build.push({ catalogKey: `passive:${id}`, location: 'passive' });
  const weapon = getActiveWeaponDef(world);
  // Generated active weapons already have their physical equipment identity below.
  if (weapon && !getActiveWeaponSnapshot(world))
    build.push({ catalogKey: `weapon:${weapon.id}`, location: 'equipped' });
  for (const instance of listGeneratedEquipmentInstances(world)) {
    const owners = findGeneratedPhysicalOwners(world, instance.instanceId).filter(
      (owner) => owner.entity === playerEid,
    );
    const location = owners.some((owner) => owner.container === 'equipped')
      ? 'equipped'
      : owners.some((owner) => owner.container === 'bag')
        ? 'bag'
        : null;
    if (location !== null)
      build.push({ catalogKey: generatedEquipmentCatalogKey(instance), location });
  }
  return build;
}

export function captureChoiceBuild(
  state: ChoiceBuildRecorder,
  world: GameWorld,
  playerEid: number,
  activeTimeMs: number,
  vendorBaseline = 0,
): void {
  const gameTimeMs = world.elapsedMs;
  const bossAvailable =
    world.goalFlags.get('floor1-boss-battle-complete') === true && !world.featureUnlocks.spells;
  recordChoiceOffer(
    state,
    'boss-spell',
    bossAvailable
      ? getOfferedBossRewardSpellIds(world).map((id) => ({
          catalogKey: `spell:${id}`,
          selectable: true,
          constraints: [],
        }))
      : [],
    gameTimeMs,
    activeTimeMs,
  );
  // Later floors can unlock spells without having a Floor 1 broker rack.
  const brokerStock = world.floorScenario?.spellBrokerOffers;
  if (world.featureUnlocks.spells && brokerStock) {
    recordChoiceOffer(
      state,
      'spell-broker',
      brokerStock.map((offer) => {
        const selectable = canPurchaseSpellBrokerSpell(world, playerEid, offer.spellId);
        return {
          catalogKey: `spell:${offer.spellId}`,
          selectable,
          constraints: selectable ? [] : null,
          cost: offer.cost,
          budget: world.playerGold,
        };
      }),
      gameTimeMs,
      activeTimeMs,
    );
  }
  const instances = new Map(
    listGeneratedEquipmentInstances(world).map((instance) => [instance.instanceId, instance]),
  );
  const stock = world.floorExtendedState?.settlement?.quartermasterStock;
  if (stock)
    recordChoiceOffer(
      state,
      `quartermaster:${stock.stockId}`,
      getQuartermasterOfferViews(world, playerEid).flatMap((offer) => {
        const instance = instances.get(offer.instanceId);
        return instance
          ? [
              {
                catalogKey: generatedEquipmentCatalogKey(instance),
                selectable: offer.canPurchase,
                constraints: offer.purchaseFailure ? [offer.purchaseFailure] : [],
                cost: offer.unitPrice,
                budget: world.playerGold,
              },
            ]
          : [];
      }),
      gameTimeMs,
      activeTimeMs,
    );
  for (const [index, decision] of world.vendorLedger.decisions.entries()) {
    if (index >= vendorBaseline && decision.outcome === 'purchased' && decision.itemId !== null)
      recordChoiceSelection(
        state,
        `vendor:${decision.vendorId}:${index}`,
        `${decision.reason === 'spell' ? 'spell' : 'item'}:${decision.itemId}`,
        decision.gameTimeMs,
        activeTimeMs,
      );
  }
  recordBuildSnapshot(state, readChoiceBuild(world, playerEid), gameTimeMs, activeTimeMs);
}

/** Snapshot exact stock references before maintenance; ownership alone is not a purchase. */
export function readQuartermasterStock(world: GameWorld, playerEid: number) {
  const instances = new Map(
    listGeneratedEquipmentInstances(world).map((item) => [item.instanceId, item]),
  );
  return getQuartermasterOfferViews(world, playerEid).flatMap((offer) => {
    const instance = instances.get(offer.instanceId);
    return instance ? [{ ...offer, catalogKey: generatedEquipmentCatalogKey(instance) }] : [];
  });
}

export function captureQuartermasterPurchases(
  state: ChoiceBuildRecorder,
  world: GameWorld,
  before: ReturnType<typeof readQuartermasterStock>,
  activeTimeMs: number,
): void {
  const stock = world.floorExtendedState?.settlement?.quartermasterStock;
  for (const offer of before) {
    const after =
      stock?.stockId === offer.stockId
        ? stock.offers.find(
            (item) => item.offerId === offer.offerId && item.instanceId === offer.instanceId,
          )
        : undefined;
    // Maintenance can free bag space or claim gold before buying. Eligibility in
    // the earlier offer snapshot must not veto this exact sold-stock transition.
    if (offer.quantity === 1 && after?.quantity === 0) {
      recordChoiceSelection(
        state,
        ['quartermaster', offer.stockId, offer.offerId].join(':'),
        offer.catalogKey,
        world.elapsedMs,
        activeTimeMs,
      );
    }
  }
}
