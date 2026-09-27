# Floor 3 final UX — issue #3539

## Systems touched

hud-ux, quests, mobile-ux

## Scope and verdict

Recommended; 3 apples estimated. The existing versus, championship, victory,
and required keep-companion flows were already wired. This change completes
missing minimap allegiance and duplicate Studio HUD requirements without
changing progression logic.

## Plan and implementation

1. Trace existing Floor 3 surfaces, quest state, and real-scene tests.
2. Give player Companions green dots on both map render paths before family
   tinting; retain hostile red and move neutral NPCs to blue and cleared
   Studio markers to gray so green identifies allies.
3. Hide the standalone league panel during the Studio phase, retaining the
   championship bracket and outcome phases. Standard Studio quests already
   use canonical defeat flags, so preserve that pipeline.
4. Verify four viewport layouts, rendered marker colors, canonical quest and
   marker synchronization, and existing versus/endgame/keep behavior.
5. Run focused checks and fast verification, review the diff, and commit locally.

The materialized producer artifact supplied the hard gate but pointed to a
missing `.goobers/implementation-plan.md`; implementation follows its recorded
hard gate and the full issue body in the context artifacts.

## Observation and validation

Before editing, the existing league real-scene test passed while explicitly
requiring the unwanted purple Studios counter. Source tracing showed recruited
Companions carry Enemy and thus used the red-dot fallback.

After editing, the real MainGameScene displays the standard Studio quest and
no Studio scoreboard. Its radar contains distinct green ally, red rival, blue
neutral, white player, and gold objective pixels. A paused fixture separates
real entities to avoid dots covering each other; it does not replace rendering.
Knocking out the first unlocked Studio roster lets production progression
advance the defeat count to 1, clear its marker, and remove its quest/waypoint.

Evidence: `files/floor3-studio-tracker-radar.png` and
`files/floor3-auto-party-{1280x720,1920x1080,800x450,844x390}.png` (local artifacts).
The registered `main-scene-probe-lab` remains the real bootstrap observation
surface; no new system or lab registration is needed.

- Preflight passed.
- Four real-scene party viewport cases passed, including roster interaction,
  pause/resume, and no control/panel overlaps; Command remains intentionally
  absent under the current automatic-party design.
- Studio tracker/radar synchronization and quest waypoint E2Es passed.
- Existing endgame autonomy E2E passed: four versus rounds, keep selection,
  and stair exit through the real scene.
- Focused unit suites passed: 40 UX/allegiance tests and 24 victory-system tests.
- `npm run scope`: game visual, integration, coverage, and sim touched.
- `npm run verify:fast` passed again after the final coverage refinement.
- `npm run review:visual:deterministic` passed all 36 shared visual checks.
- `npm run verify:pr-prereqs` passed (final PR-title validation belongs to publication).
- No `files/guard-telemetry.jsonl` exists in this worktree.

## Review and risk

The read-only review found no production correctness defects and requested
stronger rendered-color distinction coverage. The revised pixel test checks
all five semantic colors together and passes. The reviewer re-read the complete
diff, confirmed no blocking or medium findings remain, and approved check-in.
The installed review-agent
skill was unavailable; a read-only reviewer followed the repository review
harness directly. Residual risk is visual palette preference: NPC blue is
shared across floors, while simulation and quest authority are unchanged.

## Authorization continuity

The user authorizes implementation of claimed issue #3539, focused checks,
and a local commit. Do not push, open a PR, modify the issue, or merge.
Deterministic workflow stages own those actions. This overrides the default
publication contract and transfers unchanged to downstream stages.

## Local-gate repass (2026-09-27)

Recommended; 1 apple estimated. The attached review verdict passed the complete
implementation. The sole local-gate finding was missing `tsx` in a different
fresh worktree, before verification could start. No gameplay correction was
requested or needed for that dependency-bootstrap failure.

Repass plan: run preflight, rerun the failed fast gate and focused unit/real-scene
checks, then commit this evidence locally. `npm run preflight` installed the
worktree dependencies and passed; `npm run verify:fast` then passed unchanged.
The five focused unit suites (companion minimap color, Floor 3 final UX, UX
surfaces, UX wiring, and victory system) passed all 61 tests.
All seven real MainGameScene tests passed across the league HUD, four party
viewport cases, Studio quest waypoints, and AI-runner dialog/endgame autonomy.
The browser suites used the worktree's own Vite server and production scene.
`npm run scope` retained the implementation's game-visual and sim classification.
`git diff --check` passed. Handoff lint reported three pre-existing missing
retrospective subsections only in the unchanged
`2026-09-26-merge-train-synchronize-reevaluation.md`; this handoff had no findings.

Dependency installation is local to a worktree and is not transferred by a Git
commit. Downstream validation in another fresh worktree must run
`npm run preflight` before `npm run verify:fast`. The existing preflight already
provides this bootstrap; this repass does not alter or weaken the verifier.
Logs are in `.goobers/repass-{verify-fast,unit,e2e}.log` in this run's workspace.
No guard telemetry file was present. Local-only authorization remains unchanged.

## Fresh-worktree gate repair (2026-09-27)

Recommended; 2 apples estimated. Persona: DevOps Engineer. The second attached
local-gate failure again came from a separate worktree without `tsx`; the prior
local-only dependency installation could not resolve it. This section supersedes
the previous repass's instruction to rely on a downstream preflight invocation.

Plan executed: trace the deterministic gate entrypoint, reuse the existing
Node dependency bootstrap for `verify:fast`, cover cold/warm and failure paths,
run an actual cold gate plus Floor 3 regressions, review, and commit locally.

`npm run verify:fast` now enters the existing pinned-runtime preflight bootstrap
with `--verify-fast`. It installs locked dependencies only if tsx is absent,
then runs the unchanged `verify-fast.sh`. It does not run session-start sync or
preflight's other Bash phases. Both installation and verifier failures remain
nonzero. No workflow definition reload is required: the runner's existing
`npm run verify:fast` command consumes the committed package entrypoint.

Additional systems touched: agent-tooling, local verification bootstrap.

Observed before: attached downstream logs fail before any checks with missing
tsx. Observed after: moved this worktree's node_modules aside, ran the exact
`npm run verify:fast` command, and observed dependency installation followed by
all fast checks passing. Log: `.goobers/cold-verify-fast.log` (local artifact).
The saved dependency tree remains ignored under `files/repass-saved/node_modules`.

Bootstrap/runtime tests: 18 passed, including cold/warm dispatch, install failure,
and propagation of gate failure. Focused Floor 3 unit tests: 61 passed. Explicit
ESLint of both bootstrap modules passed. Scope inspection retained the original
feature's visual/simulation coverage requirements. Read-only independent review
of the complete diff found no blocking or medium findings and approved check-in.
The installed review-agent skill remains unavailable; the reviewer used the
repository review-harness procedure.

Residual risk: the first verification in an empty worktree now needs registry
access to install the lockfile, exactly as preflight already does. Warm runs skip
installation. Gameplay and verification checks are unchanged in this repass.
Authorization remains local implementation, checks, and commit only; downstream
workflow stages retain push, PR, issue, and merge ownership.

The real-scene rerun exposed a startup race in the existing endgame test: six
checks passed, but endgame stayed at frame zero after intro/starter confirmation.
Its fixed 300 ms delay allowed Resume before asynchronous startup completed.
Replaced that delay with observed `playing` plus matching runner/scene paused
state, then require frame advancement after Resume. All original progression
assertions, seed 3540, and simulation polling limits remain intact. The same-seed
endgame then passed in 38 seconds. Independent follow-up review traced the
modal/pause wiring and approved this readiness fix without findings.
Final fast verification passed after this test change. No guard telemetry exists.

Final combined real-scene run: all 7 tests in 4 files passed in 74 seconds,
including all four viewports, Studio tracker/markers, and complete endgame.
Final PR prerequisites passed (publication owns final PR-title validation).
Evidence logs: `.goobers/final-e2e.log`, `.goobers/final-verify-fast.log`, and
`.goobers/final-pr-prereqs.log`. Session implementation is fully complete.
