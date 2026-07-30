import type { GameWorld } from './world.js';
import { getFloor2EquipmentEconomyAccess } from './floor2-equipment-flags.js';
import { getGeneratedEquipmentInstance } from './generated-equipment-registry.js';
import { findGeneratedPhysicalOwners } from './systems/equipmentSystem.js';
import {
  addGeneratedEquipmentReference,
  canAcceptGeneratedEquipment,
  cloneInventoryBag,
  type InventoryBag,
} from '../shared/inventory.js';
import type {
  Floor2QuartermasterStockOffer,
  Floor2QuartermasterStockState,
} from '../shared/floor-types.js';
import type {
  GeneratedEquipmentInstanceId,
  GeneratedEquipmentRarity,
} from '../shared/generated-equipment-types.js';
import type { EquipmentSlotId } from '../shared/equipment-slots.js';
import type { StatId } from '../shared/stats.js';

export type QuartermasterPurchaseFailureCode =
  | 'economy-disabled'
  | 'inventory-capacity'
  | 'invalid-quantity'
  | 'invalid-equipment-config'
  | 'invalid-stock-identity'
  | 'insufficient-funds'
  | 'instance-not-found'
  | 'missing-inventory'
  | 'stock-unavailable'
  | 'unknown-offer'
  | 'ownership-conflict';

export interface QuartermasterPurchaseRequest {
  readonly stockId: string;
  readonly offerId: string;
  readonly quantity: number;
}

export type QuartermasterPurchaseResult =
  | {
      readonly ok: true;
      readonly instanceId: GeneratedEquipmentInstanceId;
      readonly goldSpent: number;
      readonly remainingGold: number;
    }
  | {
      readonly ok: false;
      readonly reason: QuartermasterPurchaseFailureCode;
      readonly message: string;
    };

export interface QuartermasterOfferUtility {
  readonly itemLevel: number;
  readonly rarity: GeneratedEquipmentRarity;
  readonly enhancementLevel: number;
  readonly slots: readonly EquipmentSlotId[];
  readonly statBonuses: Readonly<Partial<Record<StatId, number>>>;
  readonly weightLb: number;
}

export interface QuartermasterOfferView {
  readonly stockId: string;
  readonly offerId: string;
  readonly instanceId: GeneratedEquipmentInstanceId;
  readonly displayName: string | null;
  readonly unitPrice: number;
  readonly quantity: number;
  readonly affordable: boolean;
  readonly capacityAvailable: boolean;
  readonly canPurchase: boolean;
  readonly purchaseFailure: QuartermasterPurchaseFailureCode | null;
  readonly utility: QuartermasterOfferUtility | null;
}

interface PreparedPurchase {
  readonly offer: Floor2QuartermasterStockOffer;
  readonly stock: Floor2QuartermasterStockState;
  readonly bag: InventoryBag;
}

type PrepareResult =
  | { readonly ok: true; readonly prepared: PreparedPurchase }
  | Extract<QuartermasterPurchaseResult, { readonly ok: false }>;

function failure(
  reason: QuartermasterPurchaseFailureCode,
  message: string,
): Extract<QuartermasterPurchaseResult, { readonly ok: false }> {
  return { ok: false, reason, message };
}

function currentStock(world: GameWorld): Floor2QuartermasterStockState | undefined {
  return world.floorExtendedState?.settlement?.quartermasterStock;
}

function preparePurchase(
  world: GameWorld,
  playerEid: number,
  request: QuartermasterPurchaseRequest,
): PrepareResult {
  const access = getFloor2EquipmentEconomyAccess(world);
  if (access.kind === 'disabled') {
    return failure('economy-disabled', access.message);
  }
  if (access.kind === 'invalid') {
    return failure('invalid-equipment-config', access.message);
  }
  const stock = currentStock(world);
  if (!stock || stock.stockId !== request.stockId) {
    return failure('invalid-stock-identity', 'Quartermaster stock identity is stale or unknown');
  }
  if (request.quantity !== 1) {
    return failure(
      'invalid-quantity',
      'Generated equipment offers require an exact quantity of one',
    );
  }
  const offer = stock.offers.find((candidate) => candidate.offerId === request.offerId);
  if (!offer) {
    return failure('unknown-offer', 'Quartermaster offer identity is unknown');
  }
  const duplicateOfferIds = stock.offers.filter(
    (candidate) => candidate.offerId === request.offerId,
  );
  if (duplicateOfferIds.length > 1) {
    return failure(
      'invalid-stock-identity',
      'Quartermaster stock contains a duplicate offer identity',
    );
  }
  if (offer.quantity < request.quantity) {
    return failure('stock-unavailable', 'Quartermaster offer is sold out');
  }
  const bag = world.inventories.get(playerEid);
  if (!bag) {
    return failure('missing-inventory', 'Purchasing entity has no inventory bag');
  }
  if (world.playerGold < offer.unitPrice) {
    return failure('insufficient-funds', 'Player cannot afford this Quartermaster offer');
  }
  if (!canAcceptGeneratedEquipment(bag, request.quantity)) {
    return failure('inventory-capacity', 'Inventory cannot accept another generated item');
  }
  if (!getGeneratedEquipmentInstance(world, offer.instanceId)) {
    return failure(
      'instance-not-found',
      'Offered generated equipment is missing from the registry',
    );
  }
  const activeStockOwners = stock.offers.filter(
    (candidate) => candidate.quantity > 0 && candidate.instanceId === offer.instanceId,
  );
  if (
    activeStockOwners.length !== 1 ||
    stock.retiredInstanceIds.includes(offer.instanceId) ||
    findGeneratedPhysicalOwners(world, offer.instanceId).length !== 0
  ) {
    return failure(
      'ownership-conflict',
      'Generated equipment does not have one Quartermaster owner',
    );
  }
  return { ok: true, prepared: { offer, stock, bag } };
}

/** Shared UI/AI projection; all eligibility flags come from the purchase preflight. */
export function getQuartermasterOfferViews(
  world: GameWorld,
  playerEid: number,
): readonly QuartermasterOfferView[] {
  const stock = currentStock(world);
  if (!stock) return Object.freeze([]);
  return Object.freeze(
    stock.offers.map((offer) => {
      const request = { stockId: stock.stockId, offerId: offer.offerId, quantity: 1 };
      const prepared = preparePurchase(world, playerEid, request);
      const instance = getGeneratedEquipmentInstance(world, offer.instanceId);
      return Object.freeze({
        stockId: stock.stockId,
        offerId: offer.offerId,
        instanceId: offer.instanceId,
        displayName: instance?.frozen.displayName ?? null,
        unitPrice: offer.unitPrice,
        quantity: offer.quantity,
        affordable: world.playerGold >= offer.unitPrice,
        capacityAvailable:
          world.inventories.get(playerEid) !== undefined &&
          canAcceptGeneratedEquipment(world.inventories.get(playerEid)!, 1),
        canPurchase: prepared.ok,
        purchaseFailure: prepared.ok ? null : prepared.reason,
        utility:
          instance === undefined
            ? null
            : Object.freeze({
                itemLevel: instance.itemLevel,
                rarity: instance.rarity,
                enhancementLevel: instance.enhancementLevel,
                slots: instance.frozen.slots,
                statBonuses: instance.frozen.statBonuses,
                weightLb: instance.frozen.weightLb,
              }),
      });
    }),
  );
}

/**
 * Atomically transfer one exact generated instance from Quartermaster stock to
 * the player's bag. Every fallible check completes before immutable next-state
 * objects are built and committed.
 */
export function purchaseQuartermasterOffer(
  world: GameWorld,
  playerEid: number,
  request: QuartermasterPurchaseRequest,
): QuartermasterPurchaseResult {
  const result = preparePurchase(world, playerEid, request);
  if (!result.ok) return result;

  const { offer, stock, bag } = result.prepared;
  const nextBag: InventoryBag = cloneInventoryBag(bag);
  addGeneratedEquipmentReference(nextBag, offer.instanceId);
  const nextStock: Floor2QuartermasterStockState = {
    ...stock,
    offers: stock.offers.map((candidate) =>
      candidate.offerId === offer.offerId ? { ...candidate, quantity: 0 } : candidate,
    ),
  };
  const settlement = world.floorExtendedState!.settlement!;
  const nextSettlement = { ...settlement, quartermasterStock: nextStock };
  const nextGold = world.playerGold - offer.unitPrice;

  world.playerGold = nextGold;
  world.inventories.set(playerEid, nextBag);
  world.floorExtendedState = { ...world.floorExtendedState, settlement: nextSettlement };

  return {
    ok: true,
    instanceId: offer.instanceId,
    goldSpent: offer.unitPrice,
    remainingGold: nextGold,
  };
}
