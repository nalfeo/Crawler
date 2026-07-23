# Handoff: HUD Skill Tracker, Miss VFX, Legacy Projectile Retirement

**Date:** 2026-06-22  
**Persona:** Producer → UX Designer + Systems Engineer + Game Designer slices  
**Branch:** copilot/hud-miss-vfx-retire-legacy  
**Apple estimate:** 🍎🍎🍎🍎🍎 | **Actual:** 🍎🍎🍎🍎🍎 | **Verdict:** On target (scope was large)

---

## Systems touched

enemies, hud-ux, vfx

## What Was Done

### Slice A — Miss VFX

- Added `'miss'` to `CombatEvent.type` union in `src/shared/combat-events.ts`
- `dispatchAttack()` in `weaponSystem.ts` now pushes a miss combat event (gray "MISS" floater) when the accuracy roll fails
- `CombatVfx.ts` renders the miss event as a gray `#a0a0a0` "MISS" floater

### Slice B — HUD Skill Tracker

- Created `src/engine/HudSkillTracker.ts`: beveled pixel-UI panel at bottom-left showing the active weapon's class skill and type skill (name + level + progress bar)
- Reads `world.floor1.selectedWeaponId` for the active weapon, `world.skillStatesByEntity` for skill state — all from the core world, no game-layer import
- Wired into `HudUI.ts`: import, instantiate in bottomLeft group, sync, destroy
- Added `initializePlayerWeaponSkills()` to `floor1Scenario.ts` called after `initializeBaseStats()` so skills are seeded at game start

### Slice C — Retire Legacy Projectile System

- Removed legacy fire block and all legacy helpers from `weaponSystem.ts`: `WeaponConfig`, `weaponConfigs` WeakMap, `configureWeaponSystem`, `resolveWeaponConfig`, `readLastFireMs`, `writeLastFireMs`, `createDefaultConfig`, `getWeaponConfig`
- Removed `configureWeaponSystem` and `WeaponConfig` exports from `game/index.ts`
- Updated `combat-lab/index.ts`: replaced `configureWeaponSystem` calls with `setActiveWeapon(pistol)`, removed legacy projectile GUI controls
- Rewrote all weapon-system tests to use `setActiveWeapon` path only

### Coverage

- Added targeted tests in `weapon-system-coverage.test.ts` covering: miss event emission, beam/trap/thrown weapon type paths (returning, bouncing, plain), boss priority targeting, `computeEffectiveAccuracy` TRAP + no-Stats branches

---

## Known Issues / Next Session

- `src/game/enemyAISystem.ts` coverage thresholds are failing (lines 40.87% < 88%, branches 27.6% < 68%). This is **pre-existing** — it was masked by the weaponSystem.ts coverage failure in previous sessions. The weaponSystem.ts threshold now passes; enemyAISystem.ts needs dedicated test work.
- HudSkillTracker progress bar uses `state.usage % 100 / 100` as an approximation (skill thresholds live in game layer, inaccessible from engine). A future pass could expose threshold progress via the core world.
- Session lock needs unlocking after PR merges.

---

## Files Changed

| File                                        | Change                                      |
| ------------------------------------------- | ------------------------------------------- |
| `src/shared/combat-events.ts`               | Added `'miss'` type                         |
| `src/game/weaponSystem.ts`                  | Miss emission + full legacy system removal  |
| `src/engine/CombatVfx.ts`                   | Miss floater rendering                      |
| `src/engine/HudSkillTracker.ts`             | **NEW** — skill tracker panel               |
| `src/engine/HudUI.ts`                       | Wired HudSkillTracker                       |
| `src/game/floor1Scenario.ts`                | `initializePlayerWeaponSkills()`            |
| `src/game/index.ts`                         | Removed legacy exports                      |
| `src/labs/combat-lab/index.ts`              | Replaced legacy config with setActiveWeapon |
| `tests/game/weapon-system.test.ts`          | Rewrote to data-driven only                 |
| `tests/game/weapon-system-coverage.test.ts` | Added weapon type + miss + boss tests       |
| `tests/game/ranged-weapons.test.ts`         | Removed legacy mode test                    |
