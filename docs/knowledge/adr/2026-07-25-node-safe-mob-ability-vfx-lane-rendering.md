# ADR: Node-safe mob-ability VFX lane rendering

## Status

Accepted

## Date

2026-07-25

## Estimated Complexity

2 apples - focused CI recovery touching engine rendering, typed tests, and validation metadata

## Context

The Big Mama Bufo tongue-repossession follow-up changed `MobAbilityVfx.ts` to import the
runtime Phaser module so the lane telegraph could pass `Phaser.Math.Vector2` instances into
`Graphics.fillPoints(...)`. That satisfied one browser-side typecheck complaint, but it also
caused Node-side test environments to evaluate Phaser's browser globals while importing the
renderer. As a result, renderer-adjacent unit tests and an integration test crashed in CI
with `ReferenceError: window is not defined`.

The same recovery also needed the E2E arena probe and one unit harness signature to narrow
their new typed lane data correctly under strict TypeScript.

## Decision

Render the committed lane telegraph with `Graphics` path primitives instead of
`fillPoints(Vector2[])`, and keep the renderer's Phaser dependency type-only.

- **DEC-001**: Use `beginPath`/`moveTo`/`lineTo`/`closePath`/`fillPath` to draw the exact
  same committed lane polygon without constructing runtime `Phaser.Math.Vector2` objects.
- **DEC-002**: Keep `MobAbilityVfx.ts` on `import type Phaser from 'phaser'` so importing
  the renderer from Node-side tests does not require browser globals.
- **DEC-003**: Narrow lane-geometry probes explicitly in the E2E observer and type the
  tongue-repossession harness AI parameter as `AI_TYPE` so strict TypeScript matches the
  real runtime contracts.

## Consequences

### Positive

- **POS-001**: Renderer-facing unit and integration tests can import `MobAbilityVfx` in
  Node without crashing on missing `window`.
- **POS-002**: The committed lane telegraph remains deterministic and visually identical in
  the real renderer because it still uses the locked four-corner polygon.
- **POS-003**: The stricter E2E/test typings align CI typechecking with the actual lane
  runtime data shape.

### Negative

- **NEG-001**: The lane telegraph test now asserts path-building calls instead of
  `fillPoints(...)`, so the unit stub carries a few more Graphics methods.

### Risks

- **RSK-001**: If Phaser's path-fill semantics diverge from `fillPoints(...)` in a future
  engine update, the lane telegraph could regress visually even though Node-side imports stay
  safe.

## Alternatives Considered

### Keep the runtime Phaser import and polyfill browser globals in tests

- **ALT-001**: **Description**: Preserve `fillPoints(Vector2[])` and patch the Node test
  environment to provide the browser globals Phaser expects.
- **ALT-002**: **Rejection Reason**: This would widen test-only environment setup for a
  renderer implementation detail and hide an avoidable browser-only import in production code.

### Cast plain objects to `Phaser.Math.Vector2`

- **ALT-003**: **Description**: Avoid the runtime import by forcing structural casts back to
  `Vector2`.
- **ALT-004**: **Rejection Reason**: The original CI failure was a strict typecheck error
  specifically rejecting plain-object vertices, so this would reintroduce the same problem.
