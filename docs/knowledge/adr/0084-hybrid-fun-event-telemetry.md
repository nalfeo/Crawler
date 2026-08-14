# ADR 0084: Hybrid deterministic fun event telemetry

## Status

Accepted

## Date

2026-08-14

## Estimated Complexity

🍎 x 5 — crosses core, game runtime, headless AI, evaluator policy, tests, and
game-design documentation while preserving gameplay behavior.

## Context

The deterministic fun evaluator could score only end-of-run aggregates. Dopamine
cadence needs active-play timestamps, item viability needs offers/selections and
authoritative use, and snowball classification needs comparable per-run features.
The headless runner can observe durable state transitions, but weapon and ability
activation queues are transient and cannot be reconstructed reliably after their
systems run. Conversely, gameplay systems must not own safe-room-adjusted time or
cross-run evaluation policy.

## Decision

Use a hybrid, opt-in capture boundary:

- `GameWorld.funTelemetry` is an optional data-only collector installed by
  `runHeadless`. When absent, runtime capture helpers are no-ops and consume no RNG.
- `weaponSystem` records committed weapon activations at `dispatchAttack`.
  `abilitySystem` records only successful active/spell activations and preserves
  learned-spell and generated-equipment ownership provenance.
- Runtime activation records are untimestamped. The headless runner is the sole
  owner of safe-room-adjusted active time.
- The headless observer records starter, boss-spell, Broker, Quartermaster, and
  generated-reward opportunities; selections from authoritative ownership; and
  generated-equipment equipped duration.
- Generated equipment is grouped across runs by base ID, rarity, sorted slots,
  effect/grant kinds, and source weapon. Run keys, ordinals, fingerprints, item
  levels, enhancement levels, and rolled numeric values are excluded.
- `RunStats` stores optional raw `dopamineTelemetry`, `itemTelemetry`, and
  `snowballSignals`. Cross-run thresholds stay in `fun-score-lib.ts`.
- `RunStats.metaProgression` is only a future before/after permanent-power hook.
  No producer is installed while the Production Office/meta-progression system
  remains deferred.

## Consequences

### Positive

- The three implemented-system criteria are deterministic and measurable from
  real headless runs.
- Gameplay systems expose authoritative usage without learning evaluator policy
  or safe-room timing.
- Legacy RunStats remain readable because all new fields are optional and mixed
  or malformed cohorts fail to `unmeasured` rather than silently biasing results.
- Multi-owner ability grants credit each viable item while one activation ID
  prevents duplicated snowball dominance.

### Negative

- The headless observer must keep opportunity definitions aligned with each
  acquisition channel.
- Successful player weapon/ability activations take one extra guarded branch
  when the collector is disabled.
- Generated-item grouping intentionally treats different numeric rolls of the
  same structural item as one catalog item.

### Risks

- A new item acquisition channel can be omitted from viability exposure capture.
  Focused channel tests and the explicit opportunity-key list mitigate drift.
- An ability source-ID contract change can break generated-item attribution.
  Ownership-source tests pin learned and generated multi-owner behavior.
- Robust snowball classification is population-relative. It requires at least
  ten official wins and treats zero-MAD features as non-evidence.

## Alternatives Considered

- **Extend `SimEvent`.** Rejected because it is an optional debug/event-log sink;
  always-emitted RunStats evidence must not depend on debug recording.
- **Infer all use in the headless runner.** Rejected because weapon and ability
  activation state is transient and multi-source ownership is authoritative only
  at the activation choke point.
- **Add a global gameplay event bus.** Rejected as substantially broader than the
  telemetry need, with unnecessary migration and ownership risk.
