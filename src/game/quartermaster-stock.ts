import type { GameWorld } from '../core/world.js';
import { createGeneratedEquipmentRegistry } from '../core/generated-equipment-registry.js';
import {
  FLOOR2_QUARTERMASTER_GENERATED_BASE_IDS,
  getEquipmentDefForItem,
} from '../shared/equipmentDefs.js';
import type {
  Floor2QuartermasterStockOffer,
  Floor2QuartermasterStockState,
} from '../shared/floor-types.js';
import type {
  GeneratedEquipmentInstanceV1,
  GeneratedEquipmentRarity,
} from '../shared/generated-equipment-types.js';
import { makeRunKey } from '../shared/generated-equipment-types.js';
import {
  FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
  loadShopArchetypes,
} from '../shared/data/shop-archetypes.js';
import { hashStringToSeed, SeededRandom } from '../shared/random.js';
import { generateEquipmentInstance } from './generated-equipment-generator.js';

export type QuartermasterRestockResult =
  | {
      readonly ok: true;
      readonly changed: boolean;
      readonly stock: Floor2QuartermasterStockState;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid-epoch' | 'missing-settlement';
      readonly message: string;
    };

function ensureFloor2EquipmentRegistry(world: GameWorld): void {
  if (world.generatedEquipmentRegistry.runKey !== null) return;
  world.generatedEquipmentRegistry = createGeneratedEquipmentRegistry({
    runKey: makeRunKey(`floor2-${world.seed}`),
    generationPolicy: world.generatedEquipmentRegistry.generationPolicy,
  });
}

function generatedPrice(instance: GeneratedEquipmentInstanceV1): number {
  const rarityMultiplier = instance.rarity === 'uncommon' ? 1.5 : 1;
  return Math.max(1, Math.round((20 + instance.itemLevel * 5) * rarityMultiplier));
}

function rarityForOffer(
  index: number,
  rng: SeededRandom,
): Exclude<GeneratedEquipmentRarity, 'rare'> {
  if (index === 0) return 'common';
  if (index === 1) return 'uncommon';
  return rng.next() < 0.5 ? 'common' : 'uncommon';
}

function generateStock(
  world: GameWorld,
  restockEpoch: number,
  retiredInstanceIds: readonly Floor2QuartermasterStockState['retiredInstanceIds'][number][],
): Floor2QuartermasterStockState {
  ensureFloor2EquipmentRegistry(world);
  const quartermaster = loadShopArchetypes().find(
    (archetype) => archetype.id === FLOOR2_QUARTERMASTER_ARCHETYPE_ID,
  );
  if (!quartermaster) {
    throw new Error(`Missing shop archetype "${FLOOR2_QUARTERMASTER_ARCHETYPE_ID}"`);
  }
  const rng = new SeededRandom(
    hashStringToSeed(`floor2-quartermaster-stock:${world.seed}:${restockEpoch}`),
  );
  const bases = [...FLOOR2_QUARTERMASTER_GENERATED_BASE_IDS];
  rng.shuffle(bases);
  const size = rng.nextInt(quartermaster.minInventorySize, quartermaster.maxInventorySize);
  if (bases.length < size) {
    throw new Error(`Quartermaster generated-equipment catalog requires at least ${size} bases`);
  }
  const stockId = `floor2-quartermaster:${world.seed}:${restockEpoch}`;
  const offers: Floor2QuartermasterStockOffer[] = bases.slice(0, size).map((baseId, index) => {
    const def = getEquipmentDefForItem(baseId);
    if (!def || def.weaponId !== undefined) {
      throw new Error(`Quartermaster generated-equipment base is not wearable gear: ${baseId}`);
    }
    const rarity = rarityForOffer(index, rng);
    const instance = generateEquipmentInstance(
      world,
      {
        baseId,
        itemLevel: Math.max(1, world.playerLevel.level),
        rarity,
        enhancementLevel: 0,
      },
      { rng, allowedEffectKinds: ['stat'] },
    );
    return Object.freeze({
      offerId: `${stockId}:${index}`,
      instanceId: instance.instanceId,
      rarity,
      unitPrice: generatedPrice(instance),
      quantity: 1 as const,
    });
  });
  return Object.freeze({
    stockId,
    restockEpoch,
    offers: Object.freeze(offers),
    retiredInstanceIds: Object.freeze([...retiredInstanceIds]),
  });
}

/** Create the one deterministic floor-load stock batch (epoch zero). */
export function createInitialFloor2QuartermasterStock(
  world: GameWorld,
): Floor2QuartermasterStockState {
  return generateStock(world, 0, []);
}

/**
 * Advance stock by exactly one epoch. Repeating the current epoch is idempotent;
 * skipped/backward epochs fail so reloads cannot reroll stock.
 */
export function restockFloor2Quartermaster(
  world: GameWorld,
  requestedEpoch: number,
): QuartermasterRestockResult {
  const settlement = world.floorExtendedState?.settlement;
  if (!settlement) {
    return {
      ok: false,
      reason: 'missing-settlement',
      message: 'Floor 2 settlement must exist before Quartermaster restock',
    };
  }
  const current = settlement.quartermasterStock;
  if (requestedEpoch === current.restockEpoch) {
    return { ok: true, changed: false, stock: current };
  }
  if (requestedEpoch !== current.restockEpoch + 1) {
    return {
      ok: false,
      reason: 'invalid-epoch',
      message: `Quartermaster restock must advance from ${current.restockEpoch} to ${current.restockEpoch + 1}`,
    };
  }
  const newlyRetired = current.offers
    .filter((offer) => offer.quantity > 0)
    .map((offer) => offer.instanceId);
  const stock = generateStock(world, requestedEpoch, [
    ...current.retiredInstanceIds,
    ...newlyRetired,
  ]);
  world.floorExtendedState = {
    ...world.floorExtendedState,
    settlement: { ...settlement, quartermasterStock: stock },
  };
  return { ok: true, changed: true, stock };
}
