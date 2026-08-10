# Session Handoff: Floor 1 UX overlap/readability pass

## Date

2026-07-09

## Persona

Producer -> UX/Engine implementation pass

## Systems touched

hud-ux, mobile-ux, inventory

## Apples

4🍎 estimated, 4🍎 actual (on estimate). Full 4🍎 review harness recorded (adversarial plan review + code review + multi-model adjudication) in `docs/knowledge/review-ledgers/2026-07-09-floor-1-ux-review.review-ledger.json`.

## What changed

- Added scene-level UI coordination in `MainGameScene` so conflicting surfaces close before opening another surface.
- Enforced safer toggle behavior:
  - `[I]` opens inventory without keeping equipment open.
  - `[G]` opens equipment without auto-opening standalone inventory.
  - Map overlay can be replaced by panel toggles (I/G/B/V) instead of hard-locking input.
- Closed panel edge cases:
  - Inventory now auto-closes when leaving safe context (prevents stuck-open combat state).
  - Keyboard interaction (`E`) now respects blocking surfaces to prevent stacked modal/panel states.
- Strengthened minimap suppression:
  - `HudMinimap` no longer restores docked radar visibility from `Escape` while HUD is master-hidden by fullscreen panels.
- Improved readability/layout:
  - `AchievementsUI` row typography/spacing/reward-column readability improvements.
  - Tooltip placement now consistently treats anchors as center-based for left/right/above/below placement.
- Added HUD plumbing:
  - `HudMinimap` exposes `closeOverlay()`.
  - `HudUI` exposes `closeMapOverlay()`.
  - Ability-bar max scale cap reduced to reduce overlap pressure.
- Updated unit expectation in `tests/unit/hud-ui-layout.test.ts` for the new ability-bar cap.

## Validation

- `npm run verify:fast` passed after final fixes.
- Targeted inventory/equipment interaction test previously run in this session: `tests/e2e/inventory-flow.test.ts` passed.

## Key decisions

- Kept the fix scoped to runtime coordinator hardening instead of introducing a full UI state-machine refactor in this PR.
- Prioritized deterministic close-before-open rules and blocking-surface gating to remove overlap regressions without broad architecture churn.

## Follow-up opportunities

- Consolidate surface compatibility into a single explicit coordinator matrix to reduce boolean drift in future UI additions.
- Add targeted behavior tests for I/G/V/B/M/E transitions under mixed panel/modal states.
