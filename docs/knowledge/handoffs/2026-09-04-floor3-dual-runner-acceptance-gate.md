# Floor 3 AI completion: dual-runner acceptance gate

## Date

2026-09-04

## Persona

QA Engineer

## Systems touched

ai-behavior-tree

## Apples

3🍎 estimated, 3🍎 actual — exact; this session landed one new deterministic
test file, one shared-constant helper, a small refactor of an existing test,
and a one-field production telemetry fix required to make the new test
observe the truth.

## Summary

Closes #4087, the QA-owned final slice of the `floor-3-ai-runner-completion`
epic (blocked by #4083/#4085/#4086, all already merged).

- Added `tests/helpers/floor3-completion-contract.ts`: the one committed seed
  (3539), `startPlayerLevel` (20), the required Floor 3 surface sequence, and
  the per-surface expected open/confirm counts — imported by both runners so
  "one committed deterministic seed shared by both runners" can't silently
  drift into two independently-typed literals (mirrors the existing
  `floor4-completion-contract.ts` pattern).
- Refactored `tests/headless/floor3-completion.test.ts` to import the shared
  seed/level constants instead of local literals (no behavior change; still
  green).
- Added `tests/e2e/floor3-ai-completion.deterministic.test.ts`: boots the real
  AI Runner Lab (`lab=ai-runner&floor=floor3&seed=3539&startPlayerLevel=20`),
  presses only the public speed/run-toggle controls, then polls
  `window.__aiRunnerDebug()` with **no debug/teleport hooks** until the run
  reaches the real production victory/exit outcome. Unlike the existing
  `floor3-ai-runner-dialog-autonomy.deterministic.test.ts` (issue #4086's own
  narrower modal-autonomy contract, which force-finishes the run with the
  debug-only `window.__aiRunnerJumpToStairs()` teleport once every other
  surface is already confirmed), this new test lets the AI navigate itself to
  the real stairs and confirm the descent from real interaction range — no
  teleports, mocked completion, or runner-specific shortcuts anywhere. It
  asserts, with full trace/telemetry in every failure message: every required
  surface (intro → starter → 6× studio-versus → 5× poach → 4× final-four-versus
  → keep-companion → stair-descend) opened and confirmed the documented number
  of times in order; simulation resumed after every non-terminal confirmation;
  ≥10 consecutive simulated seconds alive outside the spawn room; and the run
  reached the real production `cleared_floor` outcome.
- Left `floor3-ai-runner-dialog-autonomy.deterministic.test.ts` untouched — its
  own acceptance bar (#4086) never required "no shortcuts to reach
  completion", only that every surface resolves through its real callback and
  the run survives ≥10s outside spawn, so its debug-jump usage stays in scope
  for that issue.

### Production fix required to make the new test correct

`AiRunnerDebugSnapshot.runOutcome` (`src/labs/ai-runner-lab/index.ts`) read
only `world.floorScenario?.runSummary?.outcome`, which is populated exclusively
by `finalizeRunSummary` — a function only Floor 1's `confirmFloor1StairDescend`
calls today. Floor 3's `confirmFloor3StairDescend` sets `world.state =
'safe_room'` (and the `FLOOR3_STAIRS_DISCOVERED_GOAL_ID` goal flag) but never
calls `finalizeRunSummary`, so `runOutcome` silently stayed `null` even after a
genuine production win — confirmed by running the new test before the fix: it
reached `worldState: "safe_room"` with every surface confirmed at frame 48,193
while `runOutcome` was still `null`. This is exactly the same OR-condition
headless `runHeadless` already uses (`scenarioOutcome === 'cleared_floor' ||
world.floorScenario?.runSummary?.outcome === 'cleared_floor'`) — generalized it
onto the debug snapshot by calling the floor's own `getScenarioDefinition(...).
getRunOutcome(world)` first, falling back to `runSummary.outcome`. This makes
the field correctly mirror headless `RunStats.outcome` for every floor, not
just Floor 1, and is the only production-code change in this PR.

## Verification

- `npm run typecheck` (targeted) — no errors in touched files.
- `npx eslint` on all touched files — clean.
- `npx vitest run tests/headless/floor3-completion.test.ts --project headless` — pass (after the shared-constant refactor).
- `npx vitest run tests/e2e/floor3-ai-completion.deterministic.test.ts --project e2e` — pass (new test; ~95s wall time).
- `npx vitest run tests/e2e/floor3-ai-runner-dialog-autonomy.deterministic.test.ts --project e2e` — pass (unaffected regression check).
- `npx vitest run tests/headless/floor1-completion.test.ts tests/headless/floor2-completion.test.ts tests/headless/floor3-completion.test.ts tests/headless/floor3-poach-loadout.test.ts --project headless` — 24/24 passed.
- `npx vitest run tests/e2e/floor4-ai-completion.deterministic.test.ts --project e2e` — pass (regression check on the shared `runOutcome` computation, since it's now floor-generic).
- All `tests/unit/ai-runner-lab*` wiring tests (15 files, 70 tests) — passed.
- `npm run verify:pr-prereqs` — passed after adding this handoff.

## Unresolved issues / next steps

None — this closes the epic's final slice. Non-goals per the epic (balance
tuning, win-rate thresholds, broad seed sweeps, other floors) remain
out of scope and untouched.
