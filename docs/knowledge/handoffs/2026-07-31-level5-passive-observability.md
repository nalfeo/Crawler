# Handoff: Level-5 passive observability

## Date

2026-07-31

## Persona

Producer → UX Designer / Game Designer

## Systems touched

hud-ux, weapons, vfx

## Apples

- Estimated: 🍎🍎🍎
- Actual: 🍎🍎🍎

## What changed

- `MainGameScene.openAbilitiesConfigModal()` now initializes missing state with `createEmptyAbilityState()` instead of hand-rolling a partial `AbilityState` literal.
- Abilities modal projection now includes `passiveAbilityIds` (distinct non-equippable rows) with:
  - passive active/inactive status from `appliedPassiveAbilityIds`
  - effect summary text
  - inactive reason text when a weapon prerequisite exists and is unmet.
- `AbilityLoadoutUI` now supports non-toggle rows (`canToggle: false`) and renders them as `PASSIVE` action chips.
- Passive apply feedback in `abilitySystem.applyPassive()` now emits the activation VFX for player-held passives regardless of weapon prerequisite, so general level-5 passives produce visible unlock/application feedback.
- Added passive presentation metadata in `src/shared/ability-presentation.ts` so engine-layer UI can render passive names/descriptions/effect summaries and prerequisite labels without importing game-layer registries.
- Extended `main-scene-probe-lab` observability with:
  - visible loadout entry projection in `MainSceneState`
  - a skill-usage queue seam (`queueSkillUsage`) for deterministic real-pipeline progression.
- Added deterministic regressions:
  - `tests/e2e/main-game-scene-ui-exclusivity.test.ts` now verifies level-5 passive grants through the real scene pipeline appear in rendered loadout projection with active/inactive + prerequisite-reason text.
  - `tests/game/weapon-skill-abilities.test.ts` now verifies unconditional passive application emits activation VFX.

## Verification

- Attempted `npm run test:unit -- tests/game/weapon-skill-abilities.test.ts` ❌ (`vitest: not found`)
- Attempted `npm run verify:fast` ❌ (dependencies unavailable in this environment; `typescript`/`eslint` local packages missing)
- `runtime-tools-secret_scanning` on changed files ✅ no secrets found
- `parallel_validation` executed ✅ (no findings; CodeQL database too large so security scan was skipped by tooling)

## Notes / blockers

- Required pre-implementation issue comment could not be posted from this environment: `gh issue comment` returned `HTTP 403 Forbidden`.
- Preflight dependency install failed due network resolution error to Azure npm mirror (`ENOTFOUND ms-feed-12.pkgs.visualstudio.com`), which also blocked local lint/test execution.
