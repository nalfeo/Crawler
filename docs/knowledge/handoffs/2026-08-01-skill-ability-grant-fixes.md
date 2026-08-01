# Handoff: Skill Ability Grant System Fixes

**Date:** 2026-08-01  
**Branch:** nalfeo-skill-ability-grants-restructure  
**Apple estimate:** 2🍎  
**Session slug:** skill-ability-grant-fixes

## Systems touched

skills, abilities

## Summary

Fixed all bugs and test failures introduced when the ability-grant system was redesigned to give weapon CLASS skills (slashing, ranged, etc.) passive abilities at all four milestones (L5/L10/L15/L20) and weapon TYPE skills (sword, pistol, etc.) active ability stubs. The redesign changed skill definitions in `src/game/skills/registry.ts` so every milestone now specifies `abilityId` only (no `effect` blocks), and `applyMilestone()` in `skillSystem.ts` handles all grants.

## What was broken

1. **Duplicate ability IDs in `src/game/abilities/registry.ts`** — an old stub block (~lines 905–1032) defined abilities that were also defined earlier in the file, causing Zod parse errors that crashed every test.

2. **Source-conflict at L5** — `applyMilestone()` and the legacy `SKILL_LEVEL5_ABILITY_GRANTS` path both called `grantAbilitySources` with the same `sourceId` (`skill:pistol:5`), causing an `AbilityGrantError`. Fix: skip the legacy path when the skill's L5 milestone already has `abilityId`.

3. **Missing VFX/announcement in `applyMilestone()`** — the legacy L5 path emitted a VFX flash and `skillPassiveUnlocked` announcement, but `applyMilestone()` did not. Added matching logic (weapon-gated passives get announcement only; general passives get VFX + announcement).

4. **Stale threshold constants in tests** — skill definition changes earlier in the session shifted all usage thresholds (e.g., swordsmanship L5: 100→260, iron-skin L5: 450→920, iron-skin L20: 5000→16970).

5. **Stale milestone effect expectations in tests** — old tests checked for `extra_projectile`/`stat_multiply` stat modifiers at swordsmanship L10/L15. Those effects are gone; milestones now only grant abilities via `abilityId`. Tests rewritten to check `passiveAbilityIds`.

## Files changed

- `src/game/abilities/registry.ts` — removed duplicate stub block; no Zod parse errors remain
- `src/game/systems/skillSystem.ts` — guard against double-grant at L5; VFX/announcement added to `applyMilestone()`
- `tests/game/skill-system.test.ts` — updated thresholds; replaced stat-modifier assertions with ability-grant assertions
- `tests/game/skill-system-branches.test.ts` — updated iron-skin thresholds; rewrote L10/L15 milestone tests
- `tests/game/weapon-skill-abilities.test.ts` — updated to read L5 abilityId from skill def; weapon-gated tests use `slashing` skill

## Current state

All 1296 tests pass. `verify:fast` green. Branch rebased on main.

## Design notes

- The upgrade-replace semantics (L15 revokes L5's ability, L20 revokes L10's) are implemented in `applyMilestone()` lines ~182–207.
- `SKILL_LEVEL5_ABILITY_GRANTS` (legacy map) remains for any future skill that might omit the `abilityId` on its L5 milestone, but all current skills use the `abilityId` path.
- Weapon TYPE active abilities are stubbed as passives for now — a follow-up session will wire up the real active ability system once that is designed.
