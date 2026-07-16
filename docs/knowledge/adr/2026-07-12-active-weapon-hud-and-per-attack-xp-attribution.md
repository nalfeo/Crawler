# ADR: Active-weapon-only HUD source and per-attack weapon XP attribution

## Status

Accepted

**Date:** 2026-07-12

## Context

The optional merchant weapon purchase flow can switch the equipped weapon during a run.
Two attribution seams diverged:

1. `HudSkillTracker` could display stale starter-weapon skills by reading a scenario
   fallback (`floorScenario.selectedWeaponId`) instead of the canonical active-weapon
   state.
2. Weapon XP attribution on hit used attacker-level skill IDs, which can be
   overwritten by a later weapon fire before an earlier delayed hit lands.

The requirement is strict: when no weapon is equipped, hide the skill HUD; and XP/hit
attribution must follow the weapon that spawned the attack, not whichever weapon was
fired most recently.

## Decision

1. Make active-weapon state the sole HUD source:
   - `HudSkillTracker` now reads only `getActiveWeaponDef(world)`.
   - When no active weapon exists, the skill HUD is hidden (no fallback).
2. Add per-attack attribution map in world state:
   - `attackWeaponSkillsByEntity: Map<attackEid, {classSkillId,typeSkillId}>`.
3. Populate that map at attack spawn time in `weaponSystem` for melee, projectile,
   thrown, beam, and trap attack entities.
4. Emit XP from damage systems via a source-aware bridge
   (`emitWeaponHitSkillEventsForSource`) that prefers per-attack IDs and only falls
   back to attacker-level IDs for legacy safety.
5. Preserve attribution across spawned secondary attacks:
   - AoE-on-impact and trap explosion AoE inherit the source attack's skill IDs.
6. Clear per-attack attribution on entity recycle (`clearEntityStores`) to avoid stale
   carryover.

## Consequences

### Positive

- Skill HUD always matches equipped reality, including merchant-driven weapon swaps.
- No HUD panel is shown when the player has no equipped weapon.
- Delayed-hit XP attribution remains stable across weapon switches and subsequent fires.
- Trap/AoE secondary damage keeps the original weapon attribution chain.

### Negative and risks

- Adds one world-side map and extra write/read plumbing on attack spawn/hit paths.
- Attribution correctness now depends on secondary-attack propagation paths being
  maintained when new attack producers are added.

## Alternatives considered

1. Keep HUD fallback to scenario selection. Rejected: violates requirement and can show
   stale/non-equipped weapon skills.
2. Keep attacker-level-only XP attribution. Rejected: delayed-hit misattribution window
   remains.
3. Attach skill IDs directly to ECS components. Rejected for now: wider component/store
   surface change than needed; map-based side-channel is surgical and deterministic.
