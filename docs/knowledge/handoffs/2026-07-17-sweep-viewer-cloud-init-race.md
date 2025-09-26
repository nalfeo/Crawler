# Handoff: Sweep viewer cloud initialization race

## Date

2026-07-17

## Persona

UX Designer

## Systems touched

devtools

## Apples

2🍎 estimated, 2🍎 actual (exact).

## What Was Done

- Added `isCurrentCloudGeneration()` to the sweep viewer state helpers so cloud-only state publication can be guarded by the captured refresh generation.
- Updated `.github/extensions/sweep-results-viewer/extension.mjs` so `initializeCloud()` now:
  - captures the active generation at cloud-switch start,
  - refuses to publish `context` / `runs` after async work if the user has already switched away from cloud,
  - exits before run selection when the generation/source is stale,
  - ignores aborted or stale initialization failures instead of overwriting newer local state with a cloud error.
- Added deterministic helper tests covering the active/stale cloud-generation predicate.

## Verification

- Separate-model review validation (`gpt-5.6-luna` code-review agent) marked the review thread as still applicable and recommended generation/source guards in `initializeCloud()`.
- `npm run test:sweep-viewer` — 31 passed.
- `npm run verify:fast` — passed.
- `npm run verify:pr-prereqs` — passed.
- `runtime-tools-secret_scanning` on all touched files — no secrets detected.

## Runtime / Behavior Note

Before the fix, a rapid Local → Cloud → Local switch could let an aborted cloud initialization publish a stale `Cloud initialization failed: Refresh cancelled.` error into the active local state. After the fix, only the still-current cloud generation may publish initialization results or failures; stale/aborted cloud inits are dropped.

## Unresolved Issues

None.
