# Floor 6 rehabilitation PR 1: player economy access

## Systems touched

floor6-scenario, scenario-presentation, hud-ux, main-game-scene, floor6-tests

## Summary

Recommended: restore human access to existing transactions without changing tower
roles, enemy behavior, economy values, or wave/boss pacing.

- Extended the renderer-neutral construction snapshot with action permissions,
  occupied tower inspection/refund data, upgrade effects/availability, Relay health,
  and route geometry. All requests call the existing scenario transactions.
- Occupied pads now open inspection with selling; both pads and the Relay expose
  the upgrade picker. Unaffordable and phase-locked actions explain availability.
- Added procedural Relay, marked pads, directional route arrows, three distinct
  tower silhouettes/tints, and selected tower range. World labels are tappable.
- Moved route/site/tower detail out of the dense status strip onto world markers
  and inspection, retaining phase, economy, danger, and objective HUD information.
- ADR 0108 records the expanded contract. No new ECS system or tuning was added.

## Persona routing and review

Producer coordinated one bounded PR. UX Designer owned scene controls/presentation;
Game Designer owned the scenario projection without changing mechanics. QA owns
fresh pointer-input acceptance evidence. Independent design review approved the
existing-transaction approach and identified touch click-through and picker
replacement as explicit validation cases.

## Observation

Before: a fresh production scene at `?floor=floor6&seed=606` showed a dense text
strip describing sites/routes, with no useful world markers. The occupied-site
handler explicitly rejected inspection; no sell or upgrade callback reached UI.

After: real-scene regression tests observe world labels, all three tower identity
textures, occupied tower inspection, and compact HUD layout at 1280x720 and 960x540.
The fresh seed-606 player starts with zero requisitions, walks the ingress/south
lane using mouse movement, collects natural drops, earns 6 requisitions, builds a
Signal Slinger for 2, inspects and sells by touch for a 1-requisition refund, and
purchases Faster Loader for 4, leaving 1. No state injection or direct transaction
calls are used. Primed legacy art tests are supplemental evidence only.

The cleaner Relay capture exposed quest-header click-through to the Relay label
behind it. Construction now respects Phaser's UI hit list and ancestor containers;
the normal-input acceptance test proves the header collapses without opening a
menu, then directly taps the Relay to open upgrades.

## Verification run

- Pinned Node 22.23.2 preflight passed after allowing required npm network access.
- Focused unit/headless: 5 files, 59 tests passed.
- Existing Floor 6 real-scene HUD/presentation E2E: 8 tests passed; supplemental
  three-tower captures rerun on-screen, 3 passed.
- Fresh normal-pointer acceptance: 2 tests passed, including 960x540 touch drag
  cancellation, unaffordable menu bounds, modal close, direct Relay access, and
  quest-header click-through regression.
- `npm run verify:fast`: passed, 75 files / 1,005 tests plus full typecheck,
  changed-file lint, data-contract/integrity/coverage checks.
- `npm run verify:pr-prereqs`: passed with Git Bash first on PATH (the default
  Windows bash selected unavailable WSL). Final title is checked at publication.
- Fresh local `codex review --uncommitted` (Ducky): no actionable defects.
  Independent design, post-diff, final input-delta, and visual reviews: no
  medium/high findings. Review passed; the change is okay to check in.
- Handoff lint passed. Broader ADR consistency scan finds an existing broken
  reference in unchanged ADR 0043 to removed `complexity-policy.md`; confirmed
  present in the baseline, unrelated to ADR 0108.
- Azure screenshot-review command could not run without deployment credentials;
  local screenshot inspection and independent model visual critique completed.
- No `files/guard-telemetry.jsonl` existed to capture.

## Evidence

Local acceptance captures are under `files/floor6-player-evidence/` (fresh currency,
earned currency, built world, inspection, offers, purchased upgrade, Relay world,
small-screen touch menu). Supplemental three-tower/HUD captures are under
`files/floor6-evidence/`; baseline is `files/floor6-before.png`.
The new acceptance test records normal pointer actions
and observes state through read-only probes; it must not seed funds, call scenario
transactions, advance the clock, or mutate simulation state.

## Unresolved issues and next dependency

Floor 6 PR 2 depends on this PR merging. Start its tower/enemy combat-role work
from the merged interaction seam and keep this mouse/touch acceptance gate green.
Wave/boss pacing remains a later PR. Placeholder art is intentional and authorized.
After ready-for-review publication, release local ownership to CI Recovery and
the repository merge train; do not enable auto-merge or wait locally for CI.
