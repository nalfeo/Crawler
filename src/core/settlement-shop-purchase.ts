import type { GameWorld } from './world.js';
import { addItem, type InventoryBag } from '../shared/inventory.js';
import type { Floor2ShopInstance, Floor2ShopInventoryItem } from '../shared/floor-types.js';
import { getItemById } from '../shared/items.js';
import type { EquipmentItemDef } from '../shared/equipment-types.js';
import { getWeaponDef } from '../shared/weaponDefs.js';
import { getEquipmentDefForItem, getEquippableItemIds } from '../shared/equipmentDefs.js';

export type SettlementShopPurchaseFailureCode =
  | 'insufficient-funds'
  | 'invalid-quantity'
  | 'missing-inventory'
  | 'stock-unavailable'
  | 'unknown-item'
  | 'unknown-shop';

export interface SettlementShopPurchaseRequest {
  readonly itemId: string;
  readonly quantity: number;
}

export type SettlementShopPurchaseResult =
  | {
      readonly ok: true;
      readonly goldSpent: number;
      readonly remainingGold: number;
    }
  | {
      readonly ok: false;
      readonly reason: SettlementShopPurchaseFailureCode;
      readonly message: string;
    };

export interface SettlementShopOfferView {
  readonly offerId: string;
  readonly itemId: string;
  readonly displayName: string | null;
  readonly unitPrice: number;
  readonly quantity: number;
  readonly affordable: boolean;
  readonly canPurchase: boolean;
  readonly purchaseFailure: SettlementShopPurchaseFailureCode | null;
  readonly utility: null;
}

interface PreparedPurchase {
  readonly settlement: NonNullable<NonNullable<GameWorld['floorExtendedState']>['settlement']>;
  readonly shop: Floor2ShopInstance;
  readonly lineItem: Floor2ShopInventoryItem;
  readonly catalogItemId: string;
  readonly bag: InventoryBag;
}

type PrepareResult =
  | { readonly ok: true; readonly prepared: PreparedPurchase }
  | Extract<SettlementShopPurchaseResult, { readonly ok: false }>;

function failure(
  reason: SettlementShopPurchaseFailureCode,
  message: string,
): Extract<SettlementShopPurchaseResult, { readonly ok: false }> {
  return { ok: false, reason, message };
}

function cloneBag(bag: InventoryBag): InventoryBag {
  return {
    ...bag,
    slots: bag.slots.map((slot) => ({ ...slot })),
    generatedEquipment: bag.generatedEquipment?.map((entry) => ({ ...entry })),
  };
}

function resolveShop(world: GameWorld, shopNpcEid: number): Floor2ShopInstance | undefined {
  return world.floorExtendedState?.settlement?.shops.find((shop) => shop.npcEid === shopNpcEid);
}

function resolveEquipmentDefForWeaponId(weaponId: string): EquipmentItemDef | undefined {
  for (const itemId of getEquippableItemIds()) {
    const def = getEquipmentDefForItem(itemId);
    if (def?.weaponId === weaponId) {
      return def;
    }
  }
  return undefined;
}

function resolveCatalogItem(itemId: string): { itemId: string; displayName: string } | null {
  const catalogItem = getItemById(itemId);
  if (catalogItem) {
    return { itemId: catalogItem.id, displayName: catalogItem.name };
  }
  const equipmentDef = resolveEquipmentDefForWeaponId(itemId);
  if (equipmentDef) {
    return { itemId: equipmentDef.id, displayName: equipmentDef.name };
  }
  return null;
}

function resolveDisplayName(itemId: string): string | null {
  return (
    getItemById(itemId)?.name ??
    resolveEquipmentDefForWeaponId(itemId)?.name ??
    getWeaponDef(itemId)?.name ??
    null
  );
}

function preparePurchase(
  world: GameWorld,
  playerEid: number,
  shopNpcEid: number,
  request: SettlementShopPurchaseRequest,
): PrepareResult {
  const settlement = world.floorExtendedState?.settlement;
  const shop = resolveShop(world, shopNpcEid);
  if (!settlement || !shop) {
    return failure('unknown-shop', 'Settlement shop is missing or unknown');
  }
  if (request.quantity !== 1) {
    return failure(
      'invalid-quantity',
      'Settlement shop purchases require an exact quantity of one',
    );
  }
  const lineItem = shop.inventory.find((item) => item.itemId === request.itemId);
  if (!lineItem) {
    return failure('unknown-item', 'Settlement shop item is missing from this stock list');
  }
  if (lineItem.stock < request.quantity) {
    return failure('stock-unavailable', 'Settlement shop item is sold out');
  }
  const bag = world.inventories.get(playerEid);
  if (!bag) {
    return failure('missing-inventory', 'Purchasing entity has no inventory bag');
  }
  const catalogItem = resolveCatalogItem(lineItem.itemId);
  if (!catalogItem) {
    return failure('unknown-item', 'Settlement shop item is not in the shared catalog');
  }
  if (world.playerGold < lineItem.unitPrice) {
    return failure('insufficient-funds', 'Player cannot afford this settlement shop item');
  }
  return {
    ok: true,
    prepared: { settlement, shop, lineItem, catalogItemId: catalogItem.itemId, bag },
  };
}

export function getSettlementShopOfferViews(
  world: GameWorld,
  playerEid: number,
  shopNpcEid: number,
): readonly SettlementShopOfferView[] {
  const shop = resolveShop(world, shopNpcEid);
  if (!shop) {
    return Object.freeze([]);
  }
  return Object.freeze(
    shop.inventory.map((lineItem) => {
      const prepared = preparePurchase(world, playerEid, shopNpcEid, {
        itemId: lineItem.itemId,
        quantity: 1,
      });
      return Object.freeze({
        offerId: lineItem.itemId,
        itemId: lineItem.itemId,
        displayName: resolveDisplayName(lineItem.itemId),
        unitPrice: lineItem.unitPrice,
        quantity: lineItem.stock,
        affordable: world.playerGold >= lineItem.unitPrice,
        canPurchase: prepared.ok,
        purchaseFailure: prepared.ok ? null : prepared.reason,
        utility: null,
      });
    }),
  );
}

export function purchaseSettlementShopOffer(
  world: GameWorld,
  playerEid: number,
  shopNpcEid: number,
  request: SettlementShopPurchaseRequest,
): SettlementShopPurchaseResult {
  const result = preparePurchase(world, playerEid, shopNpcEid, request);
  if (!result.ok) {
    return result;
  }
  const { settlement, shop, lineItem, catalogItemId, bag } = result.prepared;
  const nextBag = cloneBag(bag);
  addItem(nextBag, catalogItemId, request.quantity);
  const nextShop: Floor2ShopInstance = {
    ...shop,
    inventory: shop.inventory.map((entry) =>
      entry.itemId === lineItem.itemId
        ? { ...entry, stock: entry.stock - request.quantity }
        : entry,
    ),
  };
  const nextSettlement = {
    ...settlement,
    shops: settlement.shops.map((entry) => (entry.npcEid === shopNpcEid ? nextShop : entry)),
  } satisfies typeof settlement;
  const nextGold = world.playerGold - lineItem.unitPrice;

  world.playerGold = nextGold;
  world.inventories.set(playerEid, nextBag);
  world.floorExtendedState = { ...world.floorExtendedState, settlement: nextSettlement };

  return {
    ok: true,
    goldSpent: lineItem.unitPrice,
    remainingGold: nextGold,
  };
}
