# Session Handoff: Remove floor-specific code from the engine

## Date

2026-08-22

## Persona

Systems Engineer

## Systems touched

hud-ux, quests

## Apples

4🍎 estimated, 4🍎 actual (on target — wiring the contract into `MainGameScene`
was the bulk, as planned).

## What Was Done

`MainGameScene` no longer branches on floor identity. A new scenario
presentation contract (`src/shared/scenario-presentation.ts`) carries director
commentary milestones, stair marker state, stair confirmation copy, run outcome,
and completion copy. `src/game/scenarioDefinitions.ts` supplies per-floor data,
`src/bootstrap/floor-main-scene-options.ts` injects it, and the engine reads it.

Removed from the engine: `FLOOR_1_COMMENTARY`, the `world.floor === 1` /
`floor2-victory` commentary branches, the dual objective-marker path, the
`isFloor2` stair-prompt copy switch, the four hard-coded completion copy blocks,
and the `getFloorRunOutcome` / `getFloorCompletionPresentation` helpers in
`main-game-scene-helpers.ts`.

Observed in the real artifact (rule #9) via `tests/e2e/main-game-scene-boot.test.ts`
— before: the scene rendered Floor 1/Floor 2 copy from in-engine branches;
after: the same booted scene drives the stair prompt, the descend confirmation
modal, the completion screen, and the Floor 1 → Floor 2 restart entirely from
the injected contract, with identical copy. `tests/e2e/staircase-marker.test.ts`
confirms the contract-driven marker still renders the generated stairs art.

## Key Decisions Made

- The contract lives in `src/shared/` and is generic over `TWorld`, because
  `src/engine/` may not import `src/game/` and `src/shared/` may not import
  `src/core/`. The earlier `declare module` augmentation in bootstrap was
  rejected: it made the field unreadable by the engine, which is exactly why the
  first attempt shipped an injected-but-never-consumed contract.
- `locked` is derived from `staircaseUnlocked` (not `staircaseLocked` /
  presence), so a generic consumer never offers a descent that
  `confirmFloorNStairDescend` will reject. Behavior-identical for both floors.
- The "Descend" affordance requires `stairConfirmation` as well as a visible,
  unlocked marker, so the hint can never be shown for a scenario the scene
  cannot follow through on.
- ADR: `docs/knowledge/adr/2026-08-22-scenario-presentation-contract.md`.

## What's Next / Blockers

No blockers. Two **pre-existing** Floor 2 quirks were surfaced by the review and
deliberately preserved (this PR is behavior-preserving; both are identical to
the pre-refactor engine, verified against `8fdda66`):

1. Floor 2 timeout (`FLOOR2_TIMEOUT_GOAL_ID` + `world.state = 'game_over'`)
   produces no run outcome, so the player gets the death screen and a `death`
   run bundle instead of the timeout completion screen. Base did the same,
   because `floor2Scenario` sets `world.floorScenario = null` and the old
   `getFloorRunOutcome` read the timeout from `floorScenario.runSummary`.
2. `FLOOR_2_DIRECTOR.isTimeoutReached` is `world.state === 'game_over'`, so an
   ordinary HP death also plays the "floor collapsed" beat. Base used the same
   condition.

Both are now one-line contract edits in `scenarioDefinitions.ts` — a good
follow-up session with a Floor 2 timeout regression test.

Next scenario (Floor 3+) should be authored purely as a
`ScenarioPresentationContract` — if it needs a new engine branch, that is a
contract gap and the contract should grow instead.

## Retrospective

### Lessons Learned

- `npm run check:test-only-exports` resolves its baseline from `GITHUB_BASE_SHA`
  or `git merge-base HEAD origin/main`. The sandbox clone has no `origin/main`,
  so it reports false positives locally; run it as
  `GITHUB_BASE_SHA=<merge-base> npm run check:test-only-exports`.
- `tests/unit/main-game-scene-run-bundle.test.ts` parses `MainGameScene.ts`
  **source text** with regexes, so renaming locals in that file breaks tests
  that never import it.
- Playwright browsers are not preinstalled in the sandbox;
  `npx playwright install chromium` is required before any e2e run.

### Mistakes Made

- The first commit introduced the contract via TypeScript module augmentation in
  bootstrap and shipped it unconsumed by the engine — a dead parallel path that
  also tripped `check:test-only-exports` (the new types had only test
  consumers). Early signal: a repo-wide search for the new option name matching
  only the declaration and the injection site means the refactor is not done.

### Opportunities for Future Improvement

- A deterministic guard could assert that every `MainGameSceneOptions` field is
  read somewhere in `src/engine/`, catching injected-but-unread options in
  general rather than relying on the export-usage heuristic.
