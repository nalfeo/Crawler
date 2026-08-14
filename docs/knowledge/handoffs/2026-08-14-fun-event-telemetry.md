# Handoff: Deterministic fun event telemetry

## Systems touched: ai-combat-balance, weapons, inventory, quests, boss-rooms

## Apples

Estimated: 5🍎 — actual: 5🍎. Added an opt-in runtime activation collector,
headless acquisition/timestamp aggregation, three evaluator calculations, a
future-only meta-progression hook, tests, framework documentation, and ADR 0084.

## Summary

- `RunStats` now optionally carries `dopamineTelemetry`, `itemTelemetry`,
  `snowballSignals`, and the unpopulated future `metaProgression` hook.
- Weapon and successful ability activation choke points record deterministic
  item use without consuming RNG or owning timestamps.
- The headless runner records positive events, item opportunities/selections/use,
  safe-room-adjusted duration, and raw snowball features on normal and error paths.
- The fun evaluator now computes dopamine cadence, robust-MAD snowball frequency,
  and item viability, while legacy/mixed telemetry remains safely `unmeasured`.
- Meta progression remains explicitly deferred; no permanent power is fabricated.

## Architecture

ADR 0084 selects a hybrid observer plus optional activation-hook collector over
debug `SimEvent`, headless-only inference, or a global gameplay event bus.

## Verification

- Focused fun-score, collector, ability ownership, and headless telemetry tests.
- Typecheck, lint, `verify:fast`, and real multi-seed headless scoring.
- Same-seed telemetry equality through the actual headless pipeline.

## Follow-up

- Add a real `metaProgression` producer only when the Production Office/permanent
  upgrade system is implemented.
- Add future acquisition channels to the explicit item-opportunity observer.
