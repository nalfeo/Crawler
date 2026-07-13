# Floor 2 family HUD fullscreen-map gate

## Date

2026-07-13

## Persona

UX Designer

## Systems touched

hud-ux

## Apples

- Estimated: 3 apples
- Actual: 3 apples
- Verdict: exact

## What changed

- Added a master visibility gate to `HudFamilyRelationships` that composes with
  Floor 2's world-derived visibility.
- Made `HudUI.sync()` reconcile the family gate against both whole-HUD hidden
  state and the live fullscreen-map state, covering M, Escape, close-button, and
  programmatic close paths without changing `HudMinimap`.
- Extended the existing production-mounted `main-scene-probe-lab` to boot Floor
  2, activate reputation through the shipped Broker callback, and report
  deterministic family-panel visibility and bounds.
- Added a real-`MainGameScene` E2E matrix at exactly 1280x720 and 960x540.

## Observe before done

- Before: after the Broker callback activated Floor 2 reputation,
  `mapOverlayOpen:true` still reported `visible:true` with unchanged family-panel
  bounds at both required viewports.
- After: docked and restored states report `visible:true` with identical bounds;
  the fullscreen-map state reports `visible:false` and `bounds:null`.
- Screenshots are stored in the session artifacts as
  `before-fix-<viewport>-{docked,map-open}.png` and
  `after-fix-<viewport>-{docked,map-open,restored}.png` for 1280x720 and 960x540.
  No 844-wide evidence was captured.

## Verification

- `npm run verify:fast`
- `npm run lint:dead-code`
- `npx vitest run --project e2e tests/e2e/main-game-scene-family-hud-map.test.ts`
  with the session lab server
- 3-apple separate-model plan review and clean code-review round
- `npm run scope` (`gameplay_safe=true`)

## Notes

- Guard telemetry was captured in
  `docs/knowledge/metrics/guard-telemetry/2026-07-13-fix-family-hud-fullscreen-map.json`.
- The CI Advisory pass exposed the probe as the final consumer of the deprecated
  `createFloor1GameConfig` compatibility export. The probe now preserves that
  wrapper for its default Floor 1 path while using the generic config for Floor 2.
- No ADR was needed: this is a local HUD visibility correction, not a
  cross-system decision.
