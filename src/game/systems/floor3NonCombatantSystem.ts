import { clearActiveWeapon } from '../weaponSystem.js';
import type { GameWorld } from '../../core/world.js';

/** Floor 3 Wranglers never operate player weapons. */
export function floor3NonCombatantSystem(world: GameWorld): void {
  if (world.floorId !== 'floor3') return;
  clearActiveWeapon(world);
}
