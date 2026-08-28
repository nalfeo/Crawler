# Handoff: Between-floor stats/summary screen

## Date

2026-08-27

## Persona

UX Designer

## Systems touched

floor-transitions, hud-ui, ai-headless-runner

## Apples

3🍎 estimated / 3🍎 actual — exact. One pure shared model, one scene surface with
new input/lifecycle state, probe plumbing, and the 3🍎 review harness.

## Outcome

Issue #3678: clearing a floor previously showed three lines of flavor copy and
auto-restarted into the next floor after ~1.45s, so a player never saw what the
floor cost them. The floor-completion screen now carries a stats block and, for
a human run, waits for an explicit acknowledgement before descending.

Rows (in order): `Time on floor`, `Enemies slain`, `Level (+XP)`,
`Gold (+earned · held)`, `Weapon accuracy` (only when weapon telemetry exists),
`Health remaining` (only when max HP is known).

## Design decisions

- **Pure model in `src/shared/floor-summary.ts`.** All row construction,
  clamping, clock formatting, and column alignment live in a leaf-layer module
  with no Phaser import, so they are unit-testable and reusable. `src/shared` is
  not counted as an architectural layer by `pr-preflight.mjs`, so shared+engine
  needs no ADR.
- **Kills are counted per simulation step from a pre-step `combatEvents`
  cursor.** `CombatVfx` drains `world.combatEvents` once per _rendered_ frame,
  so the array is empty by the time the floor completes; capturing
  `combatEvents.length` before `runSimulationStep` and counting player-attributed
  `death` events after it counts each death exactly once even with multiple
  steps per frame. `SessionRecorder.totalKills` was rejected because it infers
  kills from enemy-count deltas.
- **Auto-driven runs keep the timed auto-advance.** `isRunAutoDriven()` (the
  repo's standard `options.isAutoDriven?.() ?? options.autoLevelUpAllocator !==
undefined` signal) selects the original `startFloorTransitionProgress` path, so
  the headless runner and AI sweeps can never hang on a screen nobody can
  acknowledge.
- **Acknowledgement is a dedicated latch with a 450ms arm delay.** SPACE, ENTER,
  or any pointer press (including touch — the scene's normal pointer handler
  deliberately ignores touch, so the summary latches before that filter) advances
  the floor. The arm delay guarantees the same ENTER that confirmed the stair
  modal cannot instantly dismiss the summary.
- **Scoped to `transition_to_next_floor` only.** Terminal victory already opens
  the run survey, so a summary there would stack two modals.
- **Per-floor gold uses `world.goldLedger`** (`earnedFromDrops +
earnedFromLootBoxes`), because `playerGold` carries across floors; floor time
  uses `world.elapsedMs`.

## Files touched

- `src/shared/floor-summary.ts` (new) — pure model + `countPlayerAttributedKills`.
- `src/engine/scenes/MainGameScene.ts` — summary text objects, summary layout,
  acknowledgement input, fixed-step freeze while waiting, per-step kill counting,
  `getFloorSummaryState()` probe read-back (incl. panel/content bounds).
- `src/labs/main-scene-probe-lab/index.ts` — `FloorSummaryProbeState`,
  `getFloorSummaryState()`, `setAutoDrivenForProbe()`.
- `tests/e2e/helpers/main-scene-probe.ts` — `getFloorSummaryState`,
  `acknowledgeFloorSummary`, `setAutoDrivenForProbe` wrappers.
- `tests/e2e/floor-summary-screen.test.ts` (new), `tests/unit/floor-summary.test.ts`
  (new), `tests/unit/main-game-scene-floor-summary-wiring.test.ts` (new),
  `tests/e2e/main-game-scene-boot.test.ts` (both transition tests now acknowledge).

## Observe before done

Observed in the **real shipped `MainGameScene`** (booted by the main-scene probe
lab, not a synthetic lab surface):

- **Before:** Floor 1 cleared → flavor copy → auto-restart into Floor 2 in
  ~1.45s.
- **After:** the panel renders all six stat lines plus
  `Press SPACE or ENTER to descend`; the run is still on `floor1` after 3s of
  deliberate waiting, then descends to Floor 2 on SPACE. Screenshot-verified
  layout at 1280x720.
- **Auto-driven:** with `isAutoDriven()` true, the same completion reaches
  Floor 2 with no input at all.

The layout is pinned deterministically (not by screenshot) with a
panel-containment assertion: the union bounds of every visible completion text
must sit inside the panel rectangle, so growing the summary can never overflow
it silently.

## Verification run

- `npm run typecheck`, `npm run lint`, `npm run format`
- `npx vitest run tests/unit/floor-summary.test.ts tests/unit/main-game-scene-floor-summary-wiring.test.ts --project unit`
- `npx vitest run tests/e2e/floor-summary-screen.test.ts tests/e2e/main-game-scene-boot.test.ts --project e2e`
- `bash scripts/agent/verify-fast.sh` — green (2397 unit tests)
- Review harness: `plan_review` (gpt-5.6-sol, minor divergence, 7/7 resolved),
  `code_review` 2 rounds (round 2 clean), `independent_grade` (gemini-3.1-pro-preview,
  pass, 5/5/5/5/5)

## Unresolved issues

None blocking. Two notes for the next agent:

- The summary panel geometry is a second-pass override
  (`layoutFloorCompletionScreenWithSummary`) on top of the compact terminal
  variant's geometry; adding a seventh row will need the panel height bumped, and
  the containment assertion in `tests/e2e/floor-summary-screen.test.ts` will catch
  it if it isn't.
- `tests/unit/main-game-scene-helpers.test.ts` still has a comment mentioning the
  "~1.45s restart timer"; that timer is still exactly what an auto-driven run
  uses, so the comment is accurate, but a human-run reader may find it confusing.

## Recommended next steps

- Consider surfacing a per-floor damage-taken / damage-dealt pair once that
  telemetry is durable per floor (the `SessionRecorder` currently aggregates for
  the whole run).
- If a future floor introduces a between-floor shop, it should hang off the same
  acknowledged pause rather than adding a second gate.

## Retrospective

### Lessons Learned

- `world.combatEvents` is a **per-rendered-frame** buffer: `CombatVfx` drains it every
  frame (`src/engine/CombatVfx.ts`), so anything that wants end-of-floor totals must
  accumulate them per simulation step, not read them at the end. This is easy to miss
  because the array looks durable when read inside a step.
- The main-scene probe lab defaults to **human-driven** (`isAutoDriven()` false), so any
  new "wait for the player" gate silently hangs every existing e2e that drives a floor
  transition. Grep for `primeFloor*StairTransition` before adding one.
- Layout regressions are cheaper to pin than to screenshot: asserting the union bounds of
  the completion texts sit inside the panel rectangle is deterministic, runs in the real
  scene, and catches an overflow that a screenshot review would have to notice by eye.

### Mistakes Made

- The first panel geometry was authored blind (620x460 with the title at `centerY - 190`).
  Shrinking the panel to 400 without re-checking the title offset would have pushed the
  38px title outside the panel; only the containment assertion added afterwards would have
  caught it. Write the deterministic layout assertion **before** tuning geometry.
- The first round of tests covered the auto-driven "must not hang" contract with a
  source-string regex only. A source guard cannot prove a timer still fires — round 1 of
  the code review correctly rejected it, and the fix needed a new probe seam
  (`setAutoDrivenForProbe`).

### Opportunities for Future Improvement

- `layoutFloorCompletionScreenWithSummary()` is a second-pass override of hard-coded
  offsets. A small vertical-stack layout helper (measure, then lay out sequentially) would
  let any of these panels grow without hand-tuned constants.
- `docs:check` was already failing on `main` for two unrelated reasons (a README link label
  that looks like a repo path, and `check-session-instructions.ts` pinning an outdated
  AGENTS.md wording). Both are fixed here, but a pinned-literal check that must be edited
  in lockstep with prose is a recurring drift source — matching on a stable key phrase
  would be more robust.
