# Handoff: Floor 6 Relay pressure evidence

## Systems touched

floor6-scenario, headless-runner, floor6-tests

## Summary

Added durable Floor 6 telemetry for the lowest Relay health observed in a run,
plus a terminal economy snapshot that preserves evidence after the live
run-scoped ledger is correctly reset. The production headless strategy remains
enabled by default; a new explicit opt-out exists only for deterministic
pressure-observation and regression runs.

The focused headless acceptance now proves both sides of the defense loop:

- an idle Crawler with no construction strategy receives authored route pressure,
  damages the Relay, and reaches one `DEFEAT` terminal outcome;
- the normal seeded strategy earns requisitions from pickups, spends them through
  the existing construction/upgrade transactions, deals tower damage, keeps the
  Relay alive, and reaches one `VICTORY` terminal outcome.

No wave, damage, health, economy, or pacing values changed.

## Observation

Before this change, terminal cleanup reset the live Floor 6 requisition ledger,
so final `RunStats` could not demonstrate the player-earned currency path even
though the gameplay transaction had occurred. Relay pressure also had no
retained lowest-health value.

After this change, the real headless pipeline records both pieces of evidence
without retaining usable economy state after the terminal reset. The existing
real-scene normal-pointer acceptance remains the visual proof for player
movement, requisition collection, build, inspection, sell, and upgrade choices.

## Verification

- `npx vitest run --project unit tests/unit/floor6-wave-director.test.ts tests/unit/floor6-towers.test.ts` — passed (47 tests).
- `npx vitest run --project headless tests/headless/floor6-economy-obs.test.ts` — passed (3 tests).
- `npm run typecheck:src` — passed.
- `npx vitest run --project e2e tests/e2e/floor6-player-loop.test.ts` required elevated Chromium launch in this Windows environment; its initial sandbox attempt was blocked at browser spawn (`EPERM`).

## Follow-up

Run the full PR verification and browser acceptance in the publishing environment if their inherited process permissions differ. Numeric balance remains covered by the existing Floor 6 human gate; this change intentionally adds evidence only.
