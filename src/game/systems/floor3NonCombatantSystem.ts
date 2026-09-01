import { clearActiveWeapon, getActiveWeapon } from '../weaponSystem.js';
import type { GameWorld } from '../../core/world.js';

/**
 * Floor 3 Wranglers never operate player weapons. The equipped
 * loadout (active weapon, abilities) is preserved for Floor 4 carryover —
 * this system only clears the *active* weapon slot each frame it is
 * populated, guarded so it doesn't re-log/re-clear an already-empty slot
 * every tick. Active-ability activation is separately suppressed for the
 * player in `abilitySystem` (see the floor3 check there) so a carried-over
 * auto-triggering spell can't deal player-origin damage either.
 */
export function floor3NonCombatantSystem(world: GameWorld): void {
  if (world.floorId !== 'floor3') return;
  if (getActiveWeapon(world) !== undefined) {
    clearActiveWeapon(world);
  }
}
