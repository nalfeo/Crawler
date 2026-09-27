# Floor 3 slice 14 UX completion

## Systems touched

hud-ux, minimap, quests, main-scene-probe-lab, floor3-companion-league

## Scope and authorization

Issue #3539. Verdict: recommended; estimate 3 apples, actual 3 apples.
UX Designer persona. The supplied producer artifact names a missing plan file,
but includes the complete acceptance gate; the hydrated issue supplies requirements.
The user authorizes implementation, focused checks, and a local commit only.
Do not push, open a PR, modify the issue, or merge; deterministic runner stages
own those mutations. These limits transfer with this handoff.

## Completed plan

1. Trace shipped versus, endgame, keep-one, party controls, markers, and quests.
2. Fix remaining marker allegiance and duplicate Studio HUD behavior.
3. Extend deterministic real-scene coverage, run focused and required local
   checks, review the complete diff, and commit locally.

## Changes and observation

The baseline three real MainGameScene tests passed and positively asserted the
old purple Studios counter. Player Companions retain the Enemy ECS component;
minimap styling previously painted them red. Both map surfaces now resolve
Companion plus player Team before enemy styling and render allies green
(#4ade80). Neutral NPC dots are lavender (#e2b6ff), and cleared Floor 3 markers
are slate (#94a3b8), reserving the ally color for the player's Companions.

The standalone panel is hidden during Studio progression. Existing canonical
Studio quests supply the standard tracker; the Final Four bracket and endgame
panel remain. No simulation rules or progression state ownership changed.
Command controls were already removed by the automatic-party design; Roster
remains usable without overlapping the companion panel.

The updated fixed-seed MainGameScene test observes a visible standard Studio
quest, no standalone panel, green ally draw colors in both map surfaces, and
an actual green pixel in the radar. For the pixel check only, the paused lab
places a recruited ally two tiles from the player inside the discovered spawn
room so the player's glyph cannot cover it. Studio defeat is driven by knocking
out the active roster in the lab; production objective and quest ticks then
clear the marker, increment the canonical count, and remove the completed
quest and waypoint. This fixture verifies presentation wiring, not combat balance.
The real headless completion test separately observes production combat.
Screenshot: files/floor3-ux-after.png (local runner artifact).

## Validation

- Preflight passed.
- Baseline real-scene tests: 3 passed.
- Party controls: 1280x720, 960x540, 1920x1080 passed, including keyboard,
  touch, pause/resume, and no panel overlap.
- Updated league tracker/marker/pixel and quest-waypoint browser checks passed.
- Real-scene AI runner modal autonomy passed: versus rounds, victory,
  required keep-one selection, and continued runtime flow.
- Focused view-model and wiring tests: 39 passed; victory-system tests: 24 passed.
- Headless completion and poach/loadout suites: 6 passed.
- Typecheck and verify:fast passed; scope reports gameplay_safe=true,
  visual_touched=true. Final validation is recorded in local files/floor3-\*.log.
- Read-only review-agent review: no findings, okay to check in.
- No files/guard-telemetry.jsonl existed to capture.
- Handoff lint reports three pre-existing missing retrospective subsections in
  2026-09-26-merge-train-synchronize-reevaluation.md; no findings in this handoff.

## Risks and remaining work

Palette changes are intentional, reversible rendering changes. Accessibility
beyond these colors and viewport checks is not claimed. Existing production
loss/keep-one rules remain covered by the Floor 3 victory-system tests.
The deterministic runner owns subsequent review, publication, and issue updates.

## Local-gate recovery — 2026-09-27

Verdict: recommended; estimate and actual effort: 1 apple. DevOps Engineer
persona for this validation-only repass. The attached review verdict passed;
the only local-gate finding was missing `tsx` in a fresh worktree before
`verify:fast` could start. The implementation remains in commit
`ac4a36c26ea76dd94775951b79dd0b03215602bf` without further runtime edits.

Recovery plan completed: run canonical preflight to install dependencies,
rerun the failed gate and focused feature checks, inspect the captured real
scene, and commit this evidence locally. `npm run preflight` installed 470
packages and passed. `npm run verify:fast` then exited successfully. No gate
or requirement was relaxed.

Fresh focused validation also passed:

- Unit: league view, victory system, and party HUD state — 38 tests.
- Headless: Floor 3 completion and poach/loadout — 6 tests.
- Browser: real MainGameScene party UX at all three supported viewports and
  deterministic league tracker/marker synchronization — 4 tests.
- `npm run scope`: gameplay-safe rendering change; visual coverage required.
- Inspected `files/floor3-auto-party-main-scene.png`: the Roster control is
  clear of the party panel, the standard tracker displays the Studio quest,
  and the standalone Studio counter is absent.

Logs are local runner artifacts at `.goobers/repass-verify-fast.log`,
`.goobers/repass-unit.log`, `.goobers/repass-headless.log`, and
`.goobers/repass-browser.log`. No guard telemetry file existed.

Authorization remains local implementation, validation, and commit only;
the runner owns pushing, PR creation, issue updates, and merging. If the
next stage creates another fresh worktree, it must run `npm run preflight`
before `npm run verify:fast`: installed dependencies do not transfer in Git.
The recovery adds documentation only and introduces no new gameplay risk.

## Repeated local-gate recovery — 2026-09-27

Verdict: recommended; estimate and actual effort: 1 apple. DevOps Engineer
persona. Both attached reviews passed. The second local-gate artifact repeats
the missing-tsx error in a different worktree: installing dependencies in the
implementer worktree cannot repair the deterministic stage's environment.

Completed plan: trace stage setup, repair the repository-owned omission, add
failure-path regression coverage, execute the actual stage, rerun focused
Floor 3 checks, review the complete diff, and commit locally.

Additional system touched: workflow-automation. The feature workflow's
`local-ci` stage now runs `npm ci --ignore-scripts` before `verify:fast`, matching
the existing remediation stage. It preserves `syncBase`, the local gate, and
fail-fast shell behavior. No gameplay code changed on this repass.
`tests/unit/goobers-local-ci.test.ts` executes both stages' configured shell
with stubbed npm effects to prove bootstrap ordering, installation failure
short-circuiting, and propagation of verification failures.

Validation:

- Canonical preflight passed from this fresh worktree.
- Executed the feature stage's actual YAML script: dependency installation and
  `verify:fast` passed; log: `.goobers/repass-local-ci.log`.
- Focused unit tests: 51 passed, including six new stage tests.
- Production Floor 3 headless completion: one passed.
- Browser: three supported party-control viewports and one league
  tracker/marker synchronization check passed. Logs:
  `.goobers/repass-browser.log`, `.goobers/repass-league-browser.log`.
- Captured real-scene image: `files/floor3-ux-after.png`.
- Scope, formatting, and diff whitespace checks ran. Independent read-only
  complete-diff review passed with no blocking or medium findings.
- Optional Goobers source-tree validation failed on unchanged coder config:
  installed validator reports HARNESS002, unknown Codex harness option
  `sandbox`. Artifact: `.goobers/repass-config-validation.json`. This is separate
  from the repaired dependency failure; no config requirement was weakened.
- No guard telemetry file existed.

Authorization remains local implementation, validation, and commit only;
do not push, publish a PR, change the issue, or merge. Runner stages retain
those responsibilities. The runner must consume the corrected workflow
definition; an active run may retain its original snapshot. This repass proves
the checked-in stage script passes, not that a live daemon reloads definitions.

## Frozen-stage command recovery — 2026-09-27

Verdict: recommended; estimate and actual effort: 1 apple. DevOps Engineer
persona. The third passing review is followed by the same missing-tsx artifact
from the original local-ci worktree. Changing the workflow definition alone did
not repair this active run's command. All supplied review and learning artifacts
were read; no gameplay review findings remain.

Completed plan: repair the npm command invoked by the frozen stage, cover cold
and warm dependency states and failure propagation, execute that command with
no node_modules, rerun focused feature checks, obtain a complete-diff review,
and commit locally. Additional system touched: agent verification bootstrap.

`npm run verify:fast` now enters a dependency-free Node wrapper through the
existing pinned-runtime launcher. If the actual tsx entrypoint is missing, it
installs lockfile dependencies with the pinned runtime's npm, without lifecycle
scripts, before invoking the unchanged Bash verifier. Warm worktrees skip the
install. Installation failures, missing payloads, spawn errors, and verifier
failures cannot report success. This does not depend on a workflow reload.
The native regression suite is also invoked from the existing unit gate.

Validation and real pipeline observation:

- Canonical preflight passed, including full-project typecheck.
- Moved node_modules to an ignored worktree backup and ran the exact previously
  failing command, `npm run verify:fast`. It installed 470 packages and passed
  the unchanged static and integrity checks, including size/weight simulations.
  The changed-test selector found no tests in that invocation; explicit focused
  tests below supplied regression coverage. Log: `.goobers/repass-cold-verify.log`.
- Native Node bootstrap/runtime tests: 23 passed, including eight new bootstrap
  tests covering cold/warm states, error paths, and package-command wiring.
- Focused unit tests: 45 passed, including stage ordering, the bootstrap suite
  wrapper, league view, party state, and victory/keep-companion behavior.
- Production Floor 3 headless completion: one passed.
- Four real MainGameScene browser checks passed: all three supported viewports
  and league tracker/marker synchronization. Inspected `files/floor3-ux-after.png`:
  Roster clears the party panel and the standard tracker replaces the standalone
  Studio counter. Log: `.goobers/repass-browser.log`.
- Warm `npm run verify:fast` also passed without reinstalling dependencies; log:
  `.goobers/repass-warm-verify.log`.
- Scope ran; package-command changes conservatively select gameplay/visual
  checks. Formatting, focused ESLint, and diff whitespace checks passed.
- Independent read-only review of the complete diff passed with no findings;
  the reviewer stated the change is okay to check in after validation.
- No guard telemetry file existed.

Authorization remains implementation, validation, and local commit only. Do
not push, publish a PR, change the issue, or merge; deterministic stages own
those actions. A fresh verification worktree now needs npm registry access or
cached lockfile packages. Warm execution adds no installation cost. No game
logic, acceptance criteria, or verification gates were relaxed. Live downstream
runner execution remains the deterministic stage's responsibility.

## Retrospective

### Lessons Learned

Companions retain Enemy for shared combat queries, so minimap allegiance must
check both Companion and Team. Draw telemetry alone does not prove a visible
pixel when the player glyph can cover an ally at the same position.

### Mistakes Made

The initial test probe checked only the Team store and classified neutral NPCs
as allies. Requiring the actual ECS components corrected the probe; no gameplay
state or acceptance threshold was relaxed.

### Opportunities for Future Improvement

A future accessibility pass can evaluate marker shapes as well as colors.
