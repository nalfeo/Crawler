# Session Handoff: Floor 4 completion slice 1 — acceptance contract and dual-runner baseline

## Date

2026-09-03

## Persona

QA Engineer

## Systems touched

ai-combat-balance

## Apples

1🍎 estimated, 1🍎 actual (exact — contract/evidence slice; test-only assertions,
zero `src/**` change)

## What Was Done

Closed epic issue #4117 (`floor-4-playable-completion` slice 1). The spec file and
both gate tests already existed from the earlier animation-crash session; what was
missing was the slice's actual deliverable — an explicit acceptance contract that
maps **every** criterion to an assertion in **both** runners, plus the recorded
baseline, first-failed-criterion, and the verdict on the reported spawn discrepancy.

- `.specify/specs/floor4-playable-completion.md` — added the **C1–C8 contract
  table** (the eight criteria named in the epic), each row naming the concrete
  headless assertion, the concrete visual assertion, and its status; added a
  recaptured headless baseline evidence table (seed 404), per-runner "first failed
  criterion" records, an explicit **§Verdict on the reported spawn discrepancy**,
  and a reproducible **§Baseline commands** section. Also repaired mangled
  markdown in the old baseline block.
- `tests/headless/floor4-arena-completion.test.ts` — assertions tagged `C1`..`C8`;
  filled the real gaps: C1 scenario-initialization (`timeline[0]` is
  `COUNTDOWN`/`floor4-initialized`, 5-entry Headliner card), C2
  `gateTelegraphsArmed > 0`, C3/C4 per-act `WAVES`/`HEADLINE` timeline acts
  `[1..5]` and `overtimeStarted === 0`, C5 `INTERMISSION` acts `[1..5]` +
  `actIncome` acts `[1..5]` + five recorded auto-exit reasons, C6 terminal
  timeline entry, C8 `gameTimeMs` under the **manifest** stall backstop
  (3 600 000 ms) rather than only the test-local frame cap.
- `tests/helpers/floor4-completion-contract.ts` (new) — the contract's shared
  literals (five acts, manifest-derived stall backstop, C5's recorded
  auto-advance exit reasons), imported by both gates so a criterion change
  cannot silently loosen only one runner. The backstop lookup throws at import
  time rather than defaulting to `0`, which would otherwise turn C8 into an
  always-failing comparison with a misleading message.
- `tests/e2e/floor4-ai-completion.deterministic.test.ts` — same `C1`..`C8` tags and
  the same new assertions read off the lab's `window.__aiRunnerDebug().floor4Arena`
  snapshot, plus `effectiveFloor === 'floor4'` and an arena-elapsed-under-backstop
  check on both deterministic runs.

**Real-artifact observation (rule #9).** Both baseline commands were run in this
session against the real artifacts, not just read: headless
`npx vitest run --project headless tests/headless/floor4-arena-completion.test.ts`
→ 2/2 pass in ~45s (`outcome=victory`, 36487 frames / 608116.67 ms game time,
`wavesReleased=40`, `enemiesSpawned=249`, `gateTelegraphsArmed=133`, Headliners
5 spawned / 5 defeated / 0 overtime, 5 act-income entries, timeline
`COUNTDOWN → (WAVES:n → HEADLINE:n → INTERMISSION:n)×5 → VICTORY`); visual
`npx vitest run --project e2e tests/e2e/floor4-ai-completion.deterministic.test.ts`
→ 1/1 pass in ~158s driving the real `ai-runner-lab`/`MainGameScene` twice at 16x
with zero page errors and an identical phase fingerprint across both runs.

## Key Decisions Made

- **No `src/**` change.\*\* The issue says "no implementation or tuning belongs in
  this slice," so every gap was closed with test-only assertions read from
  telemetry that already exists.
- **C7 by equivalence in the visual runner.** `RunStats` only exists headless.
  Rather than add a lab-only outcome field, the contract records that Floor 4's
  `ScenarioDefinition.isVictoryReached` _is_ `isFloor4ArenaVictory`
  (`src/game/scenarioDefinitions.ts:686`), i.e. exactly `phase.kind === 'VICTORY'`
  — so asserting C6 visually asserts the same predicate that produces
  `RunStats.outcome === 'victory'` headless.
- **C8 against the real backstop.** Read `floor4.manifest.json`'s
  `timer.durationMs` in both tests instead of inventing a cap, so retuning the
  backstop retunes the gate with it.
- **C5's shortfall is enforced in the gate, not just in prose.** Both tests now
  assert that all five `INTERMISSION` exits carry one of the two recorded
  auto-advance reasons (`slice2-auto-green-room-exit`, `slice2-auto-stairs`). The
  Green Room slice that replaces the shared timer with a real public interaction
  breaks that assertion by construction, forcing the implementing session to
  update both gates _and_ the contract table deliberately instead of letting C5
  quietly change meaning.
- **Spawn-discrepancy verdict: invalid report as a Floor 4 spawn defect**,
  localized instead to a floor-agnostic runtime seam (async generated-sprite
  texture decode vs. Phaser's synchronous scene lifecycle). The windowed run was
  frozen before `arenaDirectorSystem`'s first tick, so "windowed behavior is
  empty" was an observability/lifecycle failure, not spawn parity.

## What's Next / Blockers

- **C5 remains open** and is the only unmet criterion. Closing it is
  `floor4-arena.md` slice 5 (the real Green Room transaction: a physical exit or
  stairs prop plus a `stairConfirmation` on the Floor 4 scenario) _plus_
  `BehaviorTreeAI` navigate-and-interact logic. Note that
  `confirmFloor4StairDescend`/`onStairDescend` are currently dead code for Floor 4
  in both runners.
- Epic slices 2/3/4 are already satisfied; slice 5 (dual-runner convergence) can
  now cite this contract table directly rather than re-deriving criteria.

## Retrospective

### Lessons Learned

- Playwright browsers are **not** preinstalled in this cloud sandbox — the e2e
  project fails instantly with "Executable doesn't exist at
  .../chromium_headless_shell-1223". `npx playwright install chromium` (~40s) is a
  cheap prerequisite; run it before assuming an e2e suite is unrunnable locally.
- The fastest way to author telemetry-shaped assertions is to dump the real
  telemetry first. A throwaway `tests/headless/tmp-*.test.ts` that writes
  `RunStats` to `/tmp` and is deleted afterwards took 19s and removed all guessing
  about `timeline`/`actIncome`/`headlinerCard` shapes.
- `arenaDirectorSystem`'s phase timeline (`Floor4ArenaPhaseTimelineEntry`, with
  `frame`/`worldElapsedMs`/`phase`/`reason`) is a far better acceptance surface
  than the flat counters: per-act ordering, entry reasons, and terminal phase are
  all provable from it without touching ECS state.

### Mistakes Made

- Initially assumed the issue was unstarted and nearly re-authored the spec from
  scratch; the file already existed on `main` from the animation-crash session.
  Early signal: `ls .specify/specs/` before planning — for epic slices whose
  neighbours already merged, the artifact often exists in partial form and the
  real work is the _delta_.
- One `edit` call used an `old_str` that differed from the new string only by a
  trailing newline, which silently glued two statements onto one line
  (`async function runFloor4(...) {  const ai = ...`). Caught by re-viewing the
  range; prettier would not have caught the intent error. Re-view after any edit
  whose only difference is whitespace.

### Opportunities for Future Improvement

- The C1–C8 tag convention (assertion comments tagged with a contract id that a
  spec table mirrors) is worth generalizing: a small deterministic check could
  verify that every id in a spec's contract table appears in the named test files
  and vice versa, turning "the contract and the gate drifted" into a CI failure
  instead of a review finding.
- Floor 4 has no `RunStats`-equivalent in the visual runner because
  `finalizeRunSummary` is only called from Floor-1-specific sites in
  `src/game/floorScenario.ts`. Making `runSummary` finalize generically off
  `ScenarioDefinition.isVictoryReached` would let every floor's visual runner
  report a real outcome instead of `null`.
