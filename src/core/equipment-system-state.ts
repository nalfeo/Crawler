import type { EquipmentItemDef } from '../shared/equipment-types.js';
import type { GameWorld } from './world.js';

const entityTags = new WeakMap<GameWorld, Map<number, Set<string>>>();
const customRequirements = new WeakMap<
  GameWorld,
  Map<string, (world: GameWorld, entity: number, itemDef: EquipmentItemDef) => boolean>
>();

export function getEntityTagMap(world: GameWorld): Map<number, Set<string>> {
  let map = entityTags.get(world);
  if (!map) {
    map = new Map();
    entityTags.set(world, map);
  }
  return map;
}

export function getCustomRequirements(
  world: GameWorld,
): Map<string, (world: GameWorld, entity: number, itemDef: EquipmentItemDef) => boolean> {
  let map = customRequirements.get(world);
  if (!map) {
    map = new Map();
    customRequirements.set(world, map);
  }
  return map;
}
