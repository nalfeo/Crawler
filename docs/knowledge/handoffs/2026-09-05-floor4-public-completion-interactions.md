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

Review follow-up made the public path the ONLY path. Every intermission (not just the terminal one) now publishes exactly one Green Room exit marker (`getFloor4GreenRoomExitMarker`); `MainGameScene` renders it, resolves its prompt copy per-world (`ScenarioPresentationContract.getStairConfirmation`), and its confirmation modal invokes `ScenarioDefinition.onStairDescend` = `confirmFloor4GreenRoomInteraction`, which opens the next act during acts 1-4 and confirms the terminal exit on act 5. `autoFloor4ProgressionSystem` (headless only) calls that same action and nothing else, and every confirmation is gated on the published marker's interaction radius — the exact proximity test the scene applies — so the AI can never confirm from a position the human prompt withholds. The AI-runner lab calls no Floor 4 driver at all: it reuses its floor-agnostic "walk to marker → `queuedInteraction` → confirm modal" path, so the passing visual gate is direct evidence the scene interaction resolves all five intermissions. No health/phase mutation, forced kills, invulnerability, spawn, damage, or balance tuning was changed.

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
  - No Floor 4-specific driver: the lab drives Floor 4 through its existing generic stair-marker → interaction → modal-confirm path.
- `src/game/scenarioDefinitions.ts`
  - Floor 4 marker/prompt for EVERY intermission, projected off the shared marker; `onStairDescend` performs both continuations.
- `src/shared/scenario-presentation.ts`, `src/engine/scenes/MainGameScene.ts`
  - Optional per-world `getStairConfirmation` so one exit affordance can narrate more than one continuation; the scene prefers it and falls back to the static copy.
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
- `npm run verify:fast`: passed.
- `npx vitest run --project e2e tests/e2e/floor4-ai-completion.deterministic.test.ts`: passed (1/1, ~167s) with the lab driving Floor 4 exclusively through the real `MainGameScene` marker/modal interaction.
- 3🍎 independent post-diff code review (`claude-sonnet-4.6` code-review agent): clean, no significant findings.
- Secret scan changed files: no secrets detected.

## Unresolved issues

None known for this slice. Floor 4 sponsor purchases/real shop transactions remain later-slice work; this change only confirms public Green Room continuation/terminal exit and keeps reward chest resolution physical (`chestsForceResolved=0`).

## Recommended next steps

- Let CI run the full repository suite after publication.
- If future Floor 4 Green Room shop transactions add actual purchases, keep them behind the same public safe-context/interaction path rather than adding headless-only automation.
