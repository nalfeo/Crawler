# Responsive quest tracker and minimap

**Date:** 2026-07-13
**Persona:** UX Designer
**Apples:** 3 estimated -> 3 actual

## Systems touched

hud-ux, mobile-ux

## Summary

- Added a shared responsive layout contract for the docked radar and quest tracker.
- Rebuilt the tracker as an independently scaled, bounded blue-steel panel with
  deterministic wrapping and truncation for multiple long objectives.
- Restyled docked/fullscreen minimap chrome in the EquipmentUI/InventoryUI language
  while preserving pan, zoom, keyboard, and accessible close controls.
- Suppressed the tracker and existing direction arrows while the fullscreen map is
  open.
- Added pure regressions for tracker fitting and radar placement.

## Verification

- `npm run verify:fast`
- Pure responsive-layout assertions cover the 1280x720 primary and 960x540
  secondary viewports, including maximum tracker/radar clearance and Floor 2
  family-reservation clearance at both sizes. Floor 2 uses the upper-left
  navigation lane at both viewports so a maximum-height tracker cannot intersect
  the existing family HUD.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-13-navigation-hud-polish.review-ledger.json`
- `npm run verify:pr-prereqs`

## Scope boundary

This is the 10-file base slice, including required telemetry. `HudFamilyRelationships` is untouched. The layout
contract retains a conservative Floor 2 family-panel reservation derived from the
existing fixed geometry so the dependent direction-arrow slice can avoid that HUD
without changing or coupling to the family widget.

Direction-arrow fanning and the pure reservation test move together in the first
dependent follow-up. Visual-review probes/setup and the cross-surface browser
regression move together in a second dependent follow-up.

## Runtime observation

Clean docked/fullscreen captures were taken at both required viewports after
explicitly closing the UX lab's default Guide dialogue:

- `files/navigation-hud/split-base-clean-1280x720-{docked,fullscreen}.png`
- `files/navigation-hud/split-base-clean-960x540-{docked,fullscreen}.png`

The earlier captures with dialogue over the map/bottom HUD were fixture
contamination, not intentional stress evidence. A real `MainGameScene` test using
physical `m` input during active dialogue passed at 1280x720 and 960x540 on current
`main`: `HudUI` is hidden and the minimap's `masterHidden` guard blocks the toggle.
No runtime exclusivity defect is established; a separate investigation will only
produce a fix PR if it reproduces a distinct event ordering.
