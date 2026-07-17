import { addComponent, addEntity, set } from 'bitecs';
import { BloodColor } from '../components.js';
import type { GameWorld } from '../world.js';

/** Default blood colour for any enemy that does not specify one (red). */
export { DEFAULT_BLOOD_COLOR } from '../../shared/constants.js';

/** Zero all typed-array store slots for a recycled entity ID. */
export function clearEntityStores(world: GameWorld, eid: number): void {
  const { stores } = world;
  for (const group of Object.values(stores)) {
    for (const arr of Object.values(group as Record<string, ArrayLike<number>>)) {
      if (arr instanceof Float32Array || arr instanceof Uint16Array || arr instanceof Uint8Array) {
        arr[eid] = 0;
      }
    }
  }
  world.enemyAppearanceKeys.delete(eid);
  world.enemyProjectileArchetypeKeys.delete(eid);
  world.statusEffectsByEntity.delete(eid);
  world.attackWeaponSkillsByEntity.delete(eid);
}

/** Create an entity with zeroed store slots (safe against ID recycling). */
export function createEntity(world: GameWorld): number {
  const eid = addEntity(world.ecs);
  clearEntityStores(world, eid);
  return eid;
}

/**
 * Set the BloodColor component from a packed 0xRRGGBB integer.
 * Exported so floor scenarios and other spawners can reuse it.
 */
export function setBloodColor(world: GameWorld, eid: number, hex: number): void {
  addComponent(
    world.ecs,
    eid,
    set(BloodColor, { r: (hex >> 16) & 0xff, g: (hex >> 8) & 0xff, b: hex & 0xff }),
  );
}
