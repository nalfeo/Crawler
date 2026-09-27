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
