import type { GameWorld } from './world.js';

export type Floor2EquipmentEconomyAccess =
  | { readonly kind: 'enabled' }
  | { readonly kind: 'disabled'; readonly message: string }
  | { readonly kind: 'invalid'; readonly message: string };

const FLOOR2_EQUIPMENT_ECONOMY_DISABLED_MESSAGE = 'Floor 2 equipment economy is disabled';
const FLOOR2_EQUIPMENT_ECONOMY_INVALID_MESSAGE =
  'floor2EquipmentEconomy requires floor2EquipmentRegistry and floor2EquipmentCatalog';

/**
 * Quartermaster generation and purchasing may proceed only when the economy
 * slice is explicitly enabled with its full dependency closure.
 */
export function getFloor2EquipmentEconomyAccess(world: GameWorld): Floor2EquipmentEconomyAccess {
  const { floor2EquipmentEconomy, floor2EquipmentRegistry, floor2EquipmentCatalog } =
    world.floor2EquipmentFlags;
  if (!floor2EquipmentEconomy) {
    return {
      kind: 'disabled',
      message: FLOOR2_EQUIPMENT_ECONOMY_DISABLED_MESSAGE,
    };
  }
  if (!floor2EquipmentRegistry || !floor2EquipmentCatalog) {
    return {
      kind: 'invalid',
      message: FLOOR2_EQUIPMENT_ECONOMY_INVALID_MESSAGE,
    };
  }
  return { kind: 'enabled' };
}
