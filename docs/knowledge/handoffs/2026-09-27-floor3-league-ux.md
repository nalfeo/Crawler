# Floor 3 league UX completion

## Date

2026-09-27

## Issue

#3539 — Floor 3 Slice 14: versus intros, win/lose, overworld markers, keep-companion UX.

## Systems touched

hud-ux, quests

## Recommendation and scope

Recommended: finish the missing marker distinction and tracker replacement while
preserving the existing deterministic league flow. UX Designer persona; estimate
3 apples, actual 3 apples. The producer artifact provided a hard gate but its
referenced `.goobers/implementation-plan.md` was not materialized. The issue body,
Floor 3 spec, and inspected production paths supplied the bounded requirements.

Plan: trace the shipped flows, fix the missing presentation, add deterministic
real-scene regressions, validate, obtain independent review, and commit locally.
No gameplay authority or simulation rules changed.

## Changes and observations

- Player-team Companions now render green on both radar and overlay. Floor 3
  neutral NPCs use blue and cleared league locations use slate, reserving green
  for allies. Other floors retain their existing NPC color.
- The standalone purple Studios scoreboard is hidden during Studio progression;
  the existing canonical quest tracker is the sole Studio objective surface.
  The league panel still displays the Final Four bracket and season results.
- Existing roster placement already clears the companion panel; Command controls
  were removed by the automatic-combat work and remain absent.
- Baseline real MainGameScene tests passed and explicitly observed the unwanted
  Studios scoreboard. Revised runtime assertions observe no visible Studios
  counter, visible standard tracker text, and canonical count/quest/marker
  agreement after actual encounter KOs through the shipped simulation pipeline.
- A seeded scene probe places allied, hostile and neutral entities in visited
  radar space. Tests inspect actual draw colors in both map views and assert
  green pixels in the canvas screenshot (using the canvas-to-game transform).
- Real scene coverage also clears all six Studios and four Final Four rounds,
  verifies ordered versus modals and the retained bracket, confirms Escape cannot
  bypass the keep-one picker, checks the selected live companion is retained,
  and observes Season Over with Restart/Quit after a party wipe.
- Roster/control overlap checks pass at 800x450, 960x540, 1280x720 and 1600x900.
  This extends the existing registered main-scene-probe lab; no new ECS system.

Local screenshot evidence (generated, not committed):
`files/floor3-auto-party-main-scene.png`,
`files/floor3-studio-tracker-completed.png`,
`files/floor3-best-in-show-picker.png`, `files/floor3-season-over.png`.
The party and Best in Show captures were visually inspected as well.

## Verification

- Preflight passed, including session-start main synchronization.
- Floor 3 real-scene league and party tests: 4 passed.
- Floor 3 canonical quest/waypoint real-scene test: 1 passed.
- Focused unit suites: 122 passed across final UX, league projection, victory,
  wiring and minimap behavior (the 53 minimap tests were rerun after updating
  old source guards for the explicitly requested neutral-color change).
- `npm run scope`: gameplay_safe=true, game_visual_touched=true.
- `npm run verify:fast`: passed (full-project typecheck, changed-file lint,
  61 changed unit tests and integrity/data-contract checks).
- `npm run review:visual:deterministic`: passed (36 inventory/HUD tests).
- `npm run docs:check` reached handoff lint and failed only on three pre-existing
  missing retrospective subsections in
  `2026-09-26-merge-train-synchronize-reevaluation.md`; this task does not modify it.
- Independent read-only complete-diff review passed with no blocking or medium
  findings; okay to check in after required checks. The referenced review-agent
  skill is absent locally, so the reviewer applied the repository review
  standards directly. No external review messages were published.
- No guard telemetry file exists. Token-budget reporting could not run because
  this runner has no `/root/.codex/sessions` directory; no threshold was reported.

## Authorization continuity and remaining ownership

### Local-gate repass — 2026-09-27

Recommended; estimate 1 apple. The attached independent review passed without
findings. The local gate failed before verification started because its separate
fresh worktree lacked `tsx`. This was a dependency-bootstrap failure, not a
feature regression. The implementation remains commit
`f998688cb4ae5f715041e44feed71fc644aff377`.

Repass plan: bootstrap this worktree using the canonical preflight, rerun the
failed gate and focused feature checks, then commit this recovery evidence.
No source changes or gate relaxations were necessary.

- `npm run preflight`: passed; installed 470 packages, resolved the pinned Node
  22.23.2 runtime, checked types, and confirmed main synchronization.
- `npm run verify:fast`: passed, including full-project typecheck, lint of eight
  changed files, and data-contract/integrity checks. Its changed-test selection
  found no uncommitted tests, so explicit focused tests were also run.
- `npm run test:unit -- tests/unit/hud-minimap.test.ts`: 53 passed.
- `npm run test:e2e -- tests/e2e/floor3-league-hud.deterministic.test.ts
tests/e2e/main-game-scene-floor3-party-ux.test.ts`: all four real MainGameScene
  tests passed, covering marker pixels, viewport layout, canonical Studio
  tracking, versus, victory/keep-one, and defeat presentation.
- Fresh `npm run scope` reports `gameplay_safe=false`, `sim_touched=true`, and
  `game_visual_touched=true`; this supersedes the earlier scope observation.
- No guard telemetry file exists. Local logs are
  `.goobers/verify-fast-repass.log` and `.goobers/floor3-e2e-repass.log`.

The downstream local-CI stage must run `npm run preflight` in any newly created
worktree before `npm run verify:fast`: installed dependencies are local and do
not transfer through a Git commit. This repass verifies the bootstrapped
implementation checkout; it does not change the external runner configuration.
The attached independent feature review remains applicable because this repass
changes only handoff evidence. Publication and issue mutations remain owned by
the deterministic workflow under the authorization limits below.

The user authorized implementation of #3539, focused validation, and a local
commit. Explicit limits: do not push, open a PR, modify the issue, or merge.
The deterministic workflow owns those later mutations. These limits override
this repository's usual publication default and transfer unchanged to the next
stage. No external account or publication actions were taken.

Residual risk is presentation-only: palette changes and visibility gating.
Shared render paths, real pixel assertions, canonical progression checks and
retained endgame coverage bound that risk. Broad balance sweeps and the full
suite remain CI-owned.

## Retrospective

### Lessons Learned

A league intro hides the map while its modal is open. Assert canonical completion
immediately, then inspect rendered minimap markers after acknowledging the modal.

### Mistakes Made

The first pixel assertion sampled game coordinates in a page screenshot and
left the companion under the player dot. The corrected probe separates marker
positions and converts canvas screenshot coordinates before sampling.

### Opportunities for Future Improvement

Materialize the producer's referenced plan contents alongside its artifact so
acceptance-case labels such as A1–A7 are available to the implementation stage.
