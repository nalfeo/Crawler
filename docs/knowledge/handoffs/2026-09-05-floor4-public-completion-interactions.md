# Handoff: Floor 4 Public Completion Interactions

## Date

2026-09-05

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (exact). The change stayed in existing Floor 4 scenario/AI-driver contracts plus regression tests; no new ECS system, lab, or architecture boundary was added.

## Summary

Closed Floor 4 completion slice 3 for the production `BehaviorTreeAI` on seed 404 by replacing the shared timer-driven `INTERMISSION` exits with public interaction confirmations. The arena director now waits in each intermission until the player reaches the authored Green Room SAFE room and confirms either the next-act Green Room exit or the terminal Floor 4 stairs. The BT provider now routes to live Headliners through public arena state and routes intermissions to the Green Room via the existing safe-anchor map semantics.

No Floor 4 gameplay shortcut was added to `runHeadless`: headless and the visual AI-runner lab both call the shared `autoFloor4ProgressionSystem`, which only invokes existing scenario confirmation contracts after the player is physically in a safe context. No health/phase mutation, forced kills, invulnerability, spawn, damage, or balance tuning was changed.

## Files touched

- `src/game/floor4Scenario.ts`
  - Removed `INTERMISSION` auto-advance from `arenaDirectorSystem`.
  - Added `confirmFloor4GreenRoomExit`, `isFloor4StairDescendAvailable`, and a mutating `confirmFloor4StairDescend` that records `VICTORY` only after public Green Room confirmation.
- `src/game/ai/bt-ai-provider.ts`
  - Added Floor 4 progress targeting for the live Headliner and for Green Room intermissions using existing public world/map state.
- `src/game/ai/auto-progression.ts`
  - Added `autoFloor4ProgressionSystem`, gated on Floor 4 `INTERMISSION` and safe context.
- `src/game/ai/headless-runner.ts`
  - Wired the Floor 4 auto-driver alongside existing Floor 1/2/3/6 progression helpers.
- `src/labs/ai-runner-lab/index.ts`
  - Mirrored the same Floor 4 auto-driver in the visual AI-runner lab.
- `src/game/scenarioDefinitions.ts`
  - Added Floor 4 terminal marker/prompt presentation using side-effect-free availability checks.
- `tests/headless/floor4-arena-completion.test.ts`
  - Replaced the expected-failure C5 characterization with required public interaction reasons and added `chestsForceResolved === 0`.
- `tests/e2e/floor4-ai-completion.deterministic.test.ts`
  - Updated visual gate expectations to the same public interaction reason sequence.
- `tests/helpers/floor4-completion-contract.ts`
  - Replaced old `slice2-auto-*` allowlist with public reason constants.
- `tests/unit/floor4-arena-director.test.ts`, `tests/unit/floor4-arena-waves.test.ts`, `tests/unit/scenario-definitions.test.ts`
  - Updated stale timer-driven intermission assumptions to call the same Green Room/stair confirmations after moving test players into the authored Green Room.
- `.specify/specs/floor4-playable-completion.md`
  - Updated the directly stale C5 text from open/timer-driven to required public interaction reasons.

## Verification run

- `bash scripts/agent/preflight.sh`: passed after installing the repository's existing lockfile dependencies; initial failure was missing local Playwright/dependency binaries.
- Baseline before fix: existing `tests/headless/floor4-arena-completion.test.ts` passed only with `1 expected fail` for C5 public interaction.
- `npm run typecheck`: passed after implementation and after post-sync rebase.
- `npx vitest run tests/headless/floor4-arena-completion.test.ts --pool=forks --testTimeout=180000`: passed (2/2) after implementation and after post-sync rebase.
- Direct seed-404 real headless artifact (`BehaviorTreeAI` + `runHeadless`): victory, 37,601 frames, 626,683.33 ms, 247 physical spawns, 40 waves released, 5/5 Headliners spawned/defeated, `chestsForceResolved=0`, `overtimeStarted=0`, reasons `green-room-exit` ×4 then `floor4-stairs-confirmed`.
- `npx vitest run tests/unit/floor4-arena-director.test.ts tests/unit/floor4-arena-waves.test.ts tests/unit/scenario-definitions.test.ts --pool=forks`: passed (68/68) after stale unit expectations were updated.
- Post-sync focused regression set: passed (70/70).
- `npm run verify:fast`: passed before pre-publish sync; post-sync rerun was started and should be checked before final publication.
- 3🍎 independent post-diff code review (`claude-sonnet-4.6` code-review agent): clean, no significant findings.
- Secret scan changed files: no secrets detected.

## Unresolved issues

None known for this slice. Floor 4 sponsor purchases/real shop transactions remain later-slice work; this change only confirms public Green Room continuation/terminal exit and keeps reward chest resolution physical (`chestsForceResolved=0`).

## Recommended next steps

- Let CI run the full repository suite after publication.
- If future Floor 4 Green Room shop transactions add actual purchases, keep them behind the same public safe-context/interaction path rather than adding headless-only automation.
