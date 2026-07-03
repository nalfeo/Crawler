/**
 * Active-weapon state — the single source of truth for which `WeaponDef` the
 * player is currently wielding.
 *
 * Layer-safe (core → shared): both `equipmentSystem` (core) and `weaponSystem`
 * (game) read/write this state, so it lives in core to avoid a
 * `core → game` cycle. Storage is a per-`GameWorld` `WeakMap` following the
 * same side-map pattern used by `equipmentSystem` and the pre-refactor
 * `weaponSystem`.
 *
 * A monotonically-increasing `generation` counter is bumped on every real
 * switch (id change or clear). `weaponSystem` watches the counter to know
 * when to reset its per-weapon fire-timer bookkeeping (aim/cooldown), so a
 * mid-run weapon swap doesn't inherit the previous weapon's cooldown state.
 * Live-tuning (labs) that updates a def in place while keeping the same id
 * does NOT bump the generation.
 */

import type { WeaponDef } from '../shared/weaponDefs.js';
import type { GameWorld } from './world.js';

interface ActiveWeaponState {
  def: WeaponDef | undefined;
  generation: number;
}

const stateMap = new WeakMap<GameWorld, ActiveWeaponState>();

function getOrCreateState(world: GameWorld): ActiveWeaponState {
  let state = stateMap.get(world);
  if (state === undefined) {
    state = { def: undefined, generation: 0 };
    stateMap.set(world, state);
  }
  return state;
}

/** Set the player's active weapon. Bumps the generation on a real switch. */
export function setActiveWeaponDef(world: GameWorld, def: WeaponDef): void {
  const state = getOrCreateState(world);
  if (state.def?.id === def.id) {
    state.def = def;
    return;
  }
  state.def = def;
  state.generation += 1;
}

/** Clear the player's active weapon. No-op when nothing is active. */
export function clearActiveWeaponDef(world: GameWorld): void {
  const state = getOrCreateState(world);
  if (state.def === undefined) return;
  state.def = undefined;
  state.generation += 1;
}

/** Get the player's active `WeaponDef`, or undefined when nothing is active. */
export function getActiveWeaponDef(world: GameWorld): WeaponDef | undefined {
  return stateMap.get(world)?.def;
}

/**
 * Get the current switch generation. Consumers cache this and reset any
 * per-weapon state when the value changes.
 */
export function getActiveWeaponGeneration(world: GameWorld): number {
  return stateMap.get(world)?.generation ?? 0;
}
