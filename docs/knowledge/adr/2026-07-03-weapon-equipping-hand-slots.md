# ADR: Require Weapons to Be Equipped in Hand Slots (Starter + Merchant Flow)

**Date:** 2026-07-03
**Scope:** src/shared (equipment defs + types), src/core (active-weapon resolution, equipment system, exports), src/game (Floor 1 loadout + merchant flow, shared starter-equip helper)

## Status

Accepted

## Estimated Complexity

🍎 x 3 — no new ECS system, but the change threads a new "active weapon derives
from equipped hand slots" rule across the shared/core/game boundary (equipment
defs, active-weapon resolution, starter loadout, and merchant purchase flow) plus
a shared eviction/equip/fallback helper and regression coverage.

## Context

Before this change, a run's active weapon was driven directly by
`setActiveWeapon` (in `src/game/weaponSystem.ts`) at loadout time, independent of
the equipment system. Weapons were selectable as starter/merchant items but were
not actually placed into the `mainHand` / `offHand` equipment slots, so:

- The equipment paper-doll / stat pipeline in `src/core/systems/equipmentSystem.ts`
  did not see the weapon, so hand-slot bonuses and 2H occupancy were not modeled.
- Starter selection (`selectFloor1StarterWeapon` in `src/game/floorScenario.ts`)
  and the loadout-modal path (`applyFloor1LoadoutChoice` in
  `src/game/scenarios/floorLoadoutScenario.ts`) each drove the active weapon on
  their own, with the starter-weapon → shop-item mapping duplicated between
  `src/shared/equipmentDefs.ts` and `src/game/floorScenario.ts`.

We want weapons to be first-class equipment: the wielded weapon is whatever
occupies the hand slots, so the merchant and starter flows share one source of
truth and the equipment system stays authoritative.

## Decision

Route starter and merchant weapons through the equipment system's hand slots, and
derive the active weapon from what is equipped.

1. **Single source of truth for the starter mapping.** Export
   `STARTER_WEAPON_ID_TO_ITEM_ID` from `src/shared/equipmentDefs.ts` and consume it
   from `src/game/floorScenario.ts`, deleting the duplicate
   `FLOOR_1_STARTER_WEAPON_TO_SHOP_ITEM_ID` map. Equipment defs for the starter
   weapons live alongside it, and `getEquipmentDefForStarterWeapon` resolves a
   weapon id to its hand-slot equipment def.

2. **Active weapon is a per-`GameWorld` side-map, set/cleared by equip/unequip.**
   `src/core/active-weapon.ts` stores the wielded `WeaponDef` in a per-`GameWorld`
   `WeakMap`, plus a `generation` counter bumped on each real switch. `equipmentSystem`
   sets it on equip and clears it on unequip; the `setActiveWeapon` fallback sets it
   directly; `weaponSystem` reads it and watches the `generation` to reset per-weapon
   fire-timer state on a swap. `src/core/index.ts` re-exports it so the game layer can
   consume it without a `core` → `game` cycle.

3. **One eviction/equip/fallback helper.** Both loadout entry points delegate to
   `equipStarterOrFallback(world, weaponId, weaponDef)` in
   `src/game/scenarios/starterWeaponEquip.ts`, which force-unequips `mainHand` /
   `offHand`, force-equips the starter def, logs a warning on failure, and falls
   back to `setActiveWeapon` if the equip did not take. This keeps the
   eviction/equip/fallback semantics in one place so `selectFloor1StarterWeapon`
   and `applyFloor1LoadoutChoice` cannot drift apart.

The force flags are required because loadout runs before `world.state` becomes
`playing` / `safe_room`, so the safe-context equip gate would otherwise reject the
starter equip.

## Consequences

### Positive

- Equipment system is authoritative for the wielded weapon; hand-slot bonuses and
  2H occupancy apply to weapons like any other gear.
- Starter and merchant weapon flows share one mapping and one equip helper, so
  behavior stays consistent and future changes touch a single seam.
- Re-running the loadout on a reused world (dev tools / respawn) no longer strands
  a weapon in an occupied slot: the pre-unequip makes the equip idempotent.

### Negative

- One more indirection: loadout code goes through `equipStarterOrFallback` rather
  than calling `setActiveWeapon` directly.
- The active weapon now has two possible origins (equipped hand slot, or the
  `setActiveWeapon` fallback), so debugging must consider both paths.

### Risks

- If a starter def is missing or the equip fails silently, the fallback keeps the
  run playable but the equipment paper-doll would not reflect the weapon. Mitigated
  by module-load validation (every starter weapon id resolves to a real def) and
  the warning-on-failure log in the shared helper.

## Alternatives Considered

- **Keep `setActiveWeapon` as the sole driver and skip equipment slots.** Rejected:
  weapons would never appear in the paper-doll and hand-slot bonuses could not
  apply, defeating the "weapons are equipment" goal.
- **Auto-swap the starter into whichever hand slot is free instead of force-evicting.**
  Deferred as a separate slot-conflict-resolution follow-up; for the starter flow a
  deterministic force-evict of both hand slots is simpler and matches the "fresh
  run loadout" intent.
- **Duplicate the equip block in both entry points (status quo).** Rejected: the two
  copies had already diverged (one logged on failure, one dropped it silently), so a
  shared helper is required to stop the drift.
