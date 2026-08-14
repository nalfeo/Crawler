# Reserve navigation arrow HUD space

**Date:** 2026-07-13
**Persona:** UX Designer
**Apples:** 3 estimated -> 3 actual (exact)

## Systems touched

hud-ux, mobile-ux

## Summary

- Restored the pure direction-arrow reservation layout from the original navigation
  HUD work while keeping this dependent slice limited to arrow behavior.
- Arrow pointers and labels now avoid the parent layout's critical HUD regions,
  docked radar, and live quest tracker bounds.
- Floor 2 family space comes only from the conservative rectangle already owned by
  `resolveNavigationHudLayout`; `HudFamilyRelationships` remains untouched and
  `getNavigationBounds().familyPanel` reports `null`.
- Restored compact distance formatting, bounded two-line labels, blue-steel label
  backgrounds, and automation bounds for the later browser probe.

## Coverage

- Preserved every existing arrow assertion and added pure coverage for forbidden
  regions, compact long distances, and bounded label wrapping.
- Layout coverage exercises the authored 1280x720 canvas and the 960x540 acceptance
  viewport through `computeUiScale`.
- Actual browser proof is intentionally owned by the next probe/E2E slice; this
  stacked PR provides the pure reservation behavior and bounds contract it needs.

## Verification

- `npx vitest run tests/unit/hud-direction-arrows.test.ts tests/unit/navigation-hud-layout.test.ts`
- `npm run verify:fast`
- Separate-model plan review and clean code-review round
- `npm run review:ledger -- validate`
- `npm run scope`
- `npm run verify:pr-prereqs`

## Scope boundary

The PR changes four implementation/test files and three governance files. No
session-local `files/guard-telemetry.jsonl` source was present, so no telemetry
capture was fabricated. The branch is stacked on `nalfeo-polish-navigation-hud`;
auto-merge remains disabled for parent review.
