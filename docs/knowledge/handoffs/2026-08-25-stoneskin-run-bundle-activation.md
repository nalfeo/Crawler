# Handoff: Stoneskin dev-build activation evidence

## Date

2026-08-25

## Persona

Game Designer

## Systems touched

weapons

## Apples

2🍎 estimated, 2🍎 actual. Exact: the fix stayed within existing browser run-bundle
telemetry and focused tests, with no ability balance or ECS behavior changes.

## Summary

Issue #3614 reported that Stoneskin never triggers in a dev-build run bundle
(`project:sweep-results-viewer runId=51a20b18-af88-46fb-b544-5c1efab84dde`).
Tracing showed the runtime spell path was intact: `stoneskin` is a learned spell
with a `low_health` trigger, `abilitySystem` is wired into the floor
post-systems, and the shipped pipeline can apply the timed armor buff.

The missing piece was dev/human run-bundle evidence. Headless runs initialize
`world.runEvents` and convert those activations into `RunStats.itemInteractions`,
but browser floor setup left `world.runEvents` undefined and
`collectHumanRunStats` did not emit an item-interaction rollup. As a result, a
dev-build bundle could make Stoneskin look like it never activated even when the
spell fired.

## Changes

- Browser floor setup (`createFloorMainSceneOptions`) now initializes the same
  run-event collector used by headless runs before scenario configuration.
- Human RunStats now include deterministic item-interaction evidence for starter
  weapons, offered/learned spells, and recorded item activations.
- Regression tests cover:
  - browser floor options installing run-event collection;
  - a human Stoneskin activation appearing as `spell:stoneskin` with
    `activationCount: 1`.

## Verification

- Before editing, an isolated probe and a shipped-pipeline probe both showed
  Stoneskin could activate, but the shipped-pipeline probe printed
  `runEvents: undefined`, so a dev/human bundle could not report the activation.
- After the fix, the same shipped-pipeline Stoneskin probe produced:
  - `cooldown: 2`;
  - `runEvents: [{ activationId: 1, itemSources: ['spell:stoneskin'] }]`;
  - human RunStats item `spell:stoneskin` with `activationCount: 1`.
- Targeted tests:
  `npx vitest run tests/unit/run-bundle.test.ts tests/game/floor1-main-scene-options.test.ts`
  passed (21 tests).
- `bash scripts/agent/verify-fast.sh` passed:
  144 test files, 2,368 tests, plus data-contract/integrity checks.

## Unresolved issues

None.
