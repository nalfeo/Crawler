/**
 * Shared starter-weapon equip helper.
 *
 * Both Floor 1 loadout entry points — the modal-picker flow
 * (`applyFloor1LoadoutChoice`) and the direct scenario driver
 * (`selectFloor1StarterWeapon`) — need identical eviction → equip → fallback
 * semantics when a starter weapon is chosen. Keeping that logic here means the
 * two call sites can't drift (they previously duplicated the block and had
 * already diverged on failure logging).
 */

import { query } from 'bitecs';
import { Player } from '../../core/components.js';
import { equip, unequip } from '../../core/systems/equipmentSystem.js';
import type { GameWorld } from '../../core/world.js';
import { getEquipmentDefForStarterWeapon } from '../../shared/equipmentDefs.js';
import type { WeaponDef } from '../../shared/weaponDefs.js';
import { createLogger } from '../../shared/logger.js';
import { setActiveWeapon } from '../weaponSystem.js';

const logger = createLogger('game:starter-weapon-equip');

function findPlayerEid(world: GameWorld): number | undefined {
  return query(world.ecs, [Player])[0];
}

/**
 * Route a chosen starter weapon into the equipment system so it lives in the
 * hand slot(s) — one-handed → `mainHand`, two-handed → `mainHand` + `offHand` —
 * from frame one. `equip()` also activates the underlying `WeaponDef` via
 * `core/active-weapon`, so the player begins auto-firing without a separate
 * `setActiveWeapon` call.
 *
 * Any lingering hand-slot equipment is cleared first so re-initializing the
 * same world (dev tools, respawn, back-to-loadout debugging) can't leave a
 * stale weapon in a hand slot while the new starter routes through the raw
 * `setActiveWeapon` fallback. `force: true` bypasses the safe-context gate:
 * the loadout modal runs before `world.state` becomes `'playing'`/`'safe_room'`
 * and this is a scenario-driver action, not a player input.
 *
 * Falls back to a raw `setActiveWeapon` when there's no player entity, when the
 * starter has no equipment def registered (data divergence), or when `equip()`
 * fails — so the run still starts with a working weapon rather than a silent
 * no-op.
 *
 * @param weaponId The starter weapon id (e.g. `'sword'`, `'bow'`).
 * @param weaponDef The already-resolved `WeaponDef` for that starter.
 * @returns `true` when the weapon landed via the equipment system, `false` when
 *   the `setActiveWeapon` fallback was used.
 */
export function equipStarterOrFallback(
  world: GameWorld,
  weaponId: string,
  weaponDef: WeaponDef,
): boolean {
  const player = findPlayerEid(world);
  const equipmentDef = getEquipmentDefForStarterWeapon(weaponId);
  let equipped = false;
  if (player !== undefined && equipmentDef !== undefined) {
    unequip(world, player, 'mainHand', { force: true });
    unequip(world, player, 'offHand', { force: true });
    const result = equip(world, player, equipmentDef, { force: true });
    equipped = result.ok;
    if (!result.ok) {
      logger.warn('Starter weapon equip failed; falling back to setActiveWeapon', {
        weaponId,
        itemId: equipmentDef.id,
        reasons: result.reasons.map((r) => r.type),
      });
    }
  }
  if (!equipped) {
    setActiveWeapon(world, weaponDef);
  }
  return equipped;
}
