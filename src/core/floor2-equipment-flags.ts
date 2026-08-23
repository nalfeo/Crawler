import type { GameWorld } from './world.js';
import { getWorldFloorBehavior } from './floor-behavior.js';

export type Floor2EquipmentEconomyAccess =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

const FLOOR2_EQUIPMENT_ECONOMY_DISABLED_MESSAGE = 'Floor 2 equipment economy is disabled';
const FLOOR2_EQUIPMENT_ECONOMY_INVALID_MESSAGE =
  'floor2EquipmentEconomy requires floor2EquipmentRegistry and floor2EquipmentCatalog';
const FLOOR2_EQUIPMENT_ECONOMY_WRONG_FLOOR_MESSAGE =
  'Floor 2 equipment economy is only available on Floor 2';

const FLOOR2_EQUIPMENT_REWARDS_DISABLED_MESSAGE = 'Floor 2 equipment rewards are disabled';
const FLOOR2_EQUIPMENT_REWARDS_INVALID_MESSAGE =
  'floor2EquipmentRewards requires floor2EquipmentRegistry and floor2EquipmentCatalog';
const FLOOR2_EQUIPMENT_REWARDS_WRONG_FLOOR_MESSAGE =
  'Floor 2 equipment rewards are only available on Floor 2';

/**
 * Shared generated-equipment economy dependency gate. Floor-specific consumers
 * remain responsible for checking whether their floor exposes the economy.
 */
export function getEquipmentEconomyAccess(world: GameWorld): Floor2EquipmentEconomyAccess {
  if (!getWorldFloorBehavior(world).equipmentEconomy) {
    return {
      kind: 'disabled',
      message: FLOOR2_EQUIPMENT_ECONOMY_DISABLED_MESSAGE,
    };
  }
  const { floor2EquipmentEconomy, floor2EquipmentRegistry, floor2EquipmentCatalog } =
    world.floor2EquipmentFlags;
  if (!floor2EquipmentEconomy) {
    return { kind: 'disabled', message: FLOOR2_EQUIPMENT_ECONOMY_DISABLED_MESSAGE };
  }
  if (!floor2EquipmentRegistry || !floor2EquipmentCatalog) {
    return {
      kind: 'invalid',
      message: FLOOR2_EQUIPMENT_ECONOMY_INVALID_MESSAGE,
    };
  }
  return { kind: 'enabled' };
}

/**
 * Quartermaster generation and purchasing may proceed only when the economy
 * slice is explicitly enabled with its full dependency closure on a floor
 * that opts into `settlementEquipmentEconomy` (see shared/floor-behavior.ts)
 * — a manifest-driven gate rather than a hardcoded floor id, though only
 * Floor 2 currently opts in. Fail closed on any floor that doesn't, regardless
 * of the per-world flag values.
 */
export function getFloor2EquipmentEconomyAccess(world: GameWorld): Floor2EquipmentEconomyAccess {
  if (!getWorldFloorBehavior(world).settlementEquipmentEconomy) {
    return {
      kind: 'disabled',
      message: FLOOR2_EQUIPMENT_ECONOMY_WRONG_FLOOR_MESSAGE,
    };
  }
  return getEquipmentEconomyAccess(world);
}

/**
 * Achievement equipment reward RESOLUTION (resolving an unlocked achievement's
 * reward into an immutable generated bundle) may proceed only when the dedicated
 * `floor2EquipmentRewards` flag is enabled with its full dependency closure
 * (registry + catalog) on a floor that opts into `settlementEquipmentEconomy`.
 * This is intentionally distinct from the Quartermaster/boss-chest economy
 * gate: reward bundles are a separate feature flag. Fail closed on any floor
 * that doesn't opt in, regardless of the per-world flag values — which keeps
 * Floor 1 equipment-free even though it separately opts into `equipmentEconomy`
 * for boss-chest drops.
 */
export function getFloor2EquipmentRewardsAccess(world: GameWorld): Floor2EquipmentEconomyAccess {
  if (!getWorldFloorBehavior(world).settlementEquipmentEconomy) {
    return {
      kind: 'disabled',
      message: FLOOR2_EQUIPMENT_REWARDS_WRONG_FLOOR_MESSAGE,
    };
  }
  if (!getWorldFloorBehavior(world).equipmentEconomy) {
    return {
      kind: 'disabled',
      message: FLOOR2_EQUIPMENT_REWARDS_DISABLED_MESSAGE,
    };
  }
  const { floor2EquipmentRewards, floor2EquipmentRegistry, floor2EquipmentCatalog } =
    world.floor2EquipmentFlags;
  if (!floor2EquipmentRewards) {
    return {
      kind: 'disabled',
      message: FLOOR2_EQUIPMENT_REWARDS_DISABLED_MESSAGE,
    };
  }
  if (!floor2EquipmentRegistry || !floor2EquipmentCatalog) {
    return {
      kind: 'invalid',
      message: FLOOR2_EQUIPMENT_REWARDS_INVALID_MESSAGE,
    };
  }
  return { kind: 'enabled' };
}
