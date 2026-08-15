# ADR 0085: Shared run-bundle telemetry boundary

## Context

RunStats was assembled only by the headless runner, while the human Phaser
scene had no equivalent terminal artifact. The dev build is a static deploy
with no backend, so telemetry needs a stable in-memory bundle and an injection
point that later PRs can connect to persistence or upload without making the
engine depend on transport code.

## Decision

Define generic `RunBundle` and RunStats-assembly contracts in `src/shared/`.
Keep world-specific harvesting in `src/game/ai/`, inject the collector and
recorder through `MainGameScene` options, and emit bundles at terminal scene
paths through an `onRunBundle` callback. The production bootstrap defaults that
callback to a browser `crawler:run-bundle` event while allowing later callers to
replace it. Capture recent logs through a fixed-size, level-aware shared ring
buffer; preserve the headless RunStats object values byte-for-byte.

## Consequences

Positive:

- Human and headless pipelines share one stable bundle contract.
- Engine code remains independent of game-layer recorder implementations and
  future upload transports.
- Static dev builds expose completed bundles without requiring a backend.
- Log capture has a hard memory bound.

Negative and risks:

- Human-only analytical fields not yet harvested remain neutral placeholders.
- The recorder payload itself remains bounded by its existing event lifecycle and
  needs a follow-up persistence/size policy for unusually long runs.
- A quit action from an already-present terminal screen does not replace the
  terminal outcome; a future active-run quit screen can emit `quit`.

## Alternatives considered

- Importing `src/game` recorder and RunStats types directly into `src/engine`
  would violate layer boundaries.
- Building upload or local durable storage in this foundational PR would couple
  the scene to a transport and exceed the static-deploy scope.
- Keeping RunStats assembly exclusively in `headless-runner.ts` would prevent
  shape parity for human runs and duplicate terminal harvesting logic.
