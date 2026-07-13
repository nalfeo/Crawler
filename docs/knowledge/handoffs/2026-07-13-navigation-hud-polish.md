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
  family-reservation clearance.
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
