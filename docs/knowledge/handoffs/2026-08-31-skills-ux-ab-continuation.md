# Skills UX A|B continuation

## Systems touched

hud-ux, devtools

## Summary

Added complete visual-review coverage for the real Phaser
`AbilityLoadoutUI` in `abilities-lab` without changing runtime presentation or
gameplay values.

- Expanded the default-state setup to declare the panel, list, footer, and each
  visible row's tile, details, description, and action regions.
- Added a selected/toggled-state setup that opens the loadout, moves selection
  to the second row, toggles that ability, verifies the state change, and
  declares the same complete region hierarchy.
- Region IDs use stable ability IDs rather than row indexes.
- The tile and action boxes are derived from the authored row geometry and the
  live list scale; text boxes come directly from the live probe.

## Observe before done

Real artifact: `abilities-lab` rendering the shipped `AbilityLoadoutUI` at
1280x720.

- Before/default (`before/live-dev/ability-loadout-default`): 80.0/100, zero
  deterministic blockers, zero evidence-backed blockers. The prior setup
  exposed only six coarse regions.
- After/default (`after/v1.0.0/ability-loadout-default`): 80.0/100, zero
  deterministic blockers, zero evidence-backed blockers, with 18 measured
  regions.
- Selected/toggled (`before/live-dev` and
  `after/v1.0.1/ability-loadout-selected-toggled`): 80.0/100, zero
  deterministic blockers, zero evidence-backed blockers, with 18 measured
  regions. The setup requires the exact second-row ID to become selected and
  verifies that its equipped state flips before capture.

Artifacts are under
`files/visual-review/{before,after}/{live-dev,v1.0.0,v1.0.1}/ability-loadout-*.{png,review.json}`
and were reviewed in the Screenshot Viewer. Judge spacing suggestions were
classified as task-specific advisory taste notes because deterministic
geometry is clean and no runtime presentation change was requested.

## Verification

- `npm run review:visual:deterministic` — pass, 36/36 tests.
- `npm run verify:fast` — pass.
- `npm run scope` — pass; inherited branch scope is gameplay/visual rather than
  docs-only or art-only.
- Both `review:visual:llm` scenarios — visual verdict pass at 80.0/100 with zero
  blockers. On Windows, the runner exits after writing successful artifacts
  with the existing libuv `UV_HANDLE_CLOSING` assertion.

## Apples

Estimated 3 apples, actual 3 apples: exact. The work added a second stateful
review scenario and complete deterministic region coverage while preserving
the existing UX.

## Caveats

- The setup contract derives tile/action bounds from
  `AbilityLoadoutUI`'s authored 716px list width and row inset constants because
  the current probe exposes only row/details/description bounds. If those
  authored constants change, update these setup regions in the same change.
- No gameplay values, ability behavior, `HudAbilityBar.ts`, or runtime UI code
  changed.
