# Session Handoff: Floor 5 Slice 8 release-gate telemetry and achievements

## Date

2026-09-03

## Persona

Producer → QA Engineer / Playtester

## Systems touched

quests, ai-behavior-tree, devtools

## Apples

5🍎 estimated, 5🍎 actual.

## Summary

- Added a Floor 5 `releaseGate` manifest contract with provisional numeric thresholds
  for completion rate, median/p95 duration, Command Post floor, Ram survival
  floor, terminal live-hostile/path-stall/frame-cost caps, stall backstop, and
  clean-sweep health floor.
- Extended Floor 5 run telemetry to project release-gate diagnostics:
  phase durations, terminal-integrity counters, Command Post health cushion,
  Ram survival-at-breach, structural violation counters (unreachable objectives,
  phase-order, allegiance, navigation mismatch, spawn debt, non-terminal).
- Plumbed observed frame-cost telemetry from `runHeadless` into Floor 5 run
  stats.
- Added Floor 5 achievements (`breach-opened`, `castle-captured`,
  `clean-sweep`), wired catalog registration, and added Floor 5 fact projection
  (`floor5WallBreached`, `floor5CastleCaptured`, `floor5CleanSweep`) including
  clean-sweep thresholding from the manifest.
- Added Floor 5 release-gate and achievement tests:
  - `tests/headless/floor5-release-gate.test.ts`
  - `tests/unit/achievement-floor5-facts.test.ts`
  - extended manifest schema + catalog/property coverage for new contracts.

## Verification run

- `npm test -- tests/unit/floor5-manifest-schema.test.ts tests/unit/achievement-floor5-facts.test.ts tests/unit/achievements.test.ts tests/property/achievement-facts-properties.test.ts tests/headless/floor5-release-gate.test.ts`
- `npm test -- tests/headless/floor5-siege-foundation.test.ts tests/headless/floor5-release-gate.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Unresolved issues

- The release-gate smoke panel intentionally uses the deterministic finale chip
  probe harness (same style as existing Floor 5 finale observation tests) so
  the gate remains deterministic while full autonomous Floor 5 finale strategy
  work is still pending.

## Recommended next steps

- Replace the chip-probe release panel with fully autonomous strategy sweeps
  once throne-marker navigation and finale combat strategy are production-ready.
- Add a Floor 5 real-scene e2e gate for HUD/capture presentation once the
  Floor 5 scenario HUD strip is wired through `ScenarioDefinition.getHudSnapshot`.
