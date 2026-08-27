# ADR: Beam activations hit each target once

## Status

Accepted

## Date

2026-08-27

## Estimated Complexity

🍎 x 3 — an existing core combat system plus its core tooltip model, game-layer
AI equipment model, focused tests, and review-harness artifacts.

## Context

A laser activation creates one `LineDamage` entity that persists for 300 ms and
scans every 100 ms. The scan interval lets the beam discover enemies that enter
after it appears, but `beamSystem` previously damaged every enemy on every scan.
The theoretical DPS calculator and AI equipment evaluator mirrored those four
same-target hits.

The player-facing contract is one hit per enemy per firing. Periodic discovery,
deterministic target ordering, recycled ECS entity IDs, tooltip DPS, and AI
equipment valuation must remain consistent across the core and game layers.

## Decision

- Each beam entity keeps a world-local map from target entity ID to the target's
  entity generation when it was damaged.
- `beamSystem` continues its configured periodic scans but skips targets already
  recorded for that beam. A target entering later is absent from the set and can
  be hit once.
- Beam hit state is cleared both when a beam EID is created/reused and when its
  lifetime expires.
- Single-target DPS and AI equipment valuation count one hit per target for each
  beam activation. This bug fix does not retune laser damage or cooldown.

## Consequences

### Positive

- One firing cannot repeatedly damage or award weapon-skill XP for the same
  enemy.
- Enemies entering an active beam can still be hit.
- New beam entities start with empty hit state and can damage prior targets.
- A new enemy that recycles an already-hit target EID has a new generation and
  can be hit by the still-active beam.
- Runtime, tooltip, and AI equipment scoring share the same hit-count contract.

### Negative

- Laser single-target damage and skill progression are lower than under the
  unintended four-hit behavior.
- Active beams retain a small set containing each geometrically hit target until
  expiry.

### Risks

- Removing a beam outside `lifetimeSystem` must also clear its hit state. The
  beam spawner defensively clears recycled beam EIDs, and target generations
  prevent stale target entries from suppressing replacement enemies.
- Fewer `applyDamage` calls change the seeded RNG stream for laser runs. The
  grid/full-scan headless determinism guard verifies both real pipeline paths
  remain equivalent.

## Alternatives Considered

- **Increase `beamTickMs` to the full duration.** Rejected because the beam would
  stop discovering enemies that enter after its initial scan.
- **Shorten beam duration or lower damage.** Rejected because tuning reduces the
  symptom without enforcing one hit per target.
- **Store hit history in tooltip and AI model code.** Rejected because runtime
  collision state belongs to the core beam system; consumers should model its
  contract rather than duplicate its state.
- **Add a new ECS component/store for variable target lists.** Rejected because
  the established world-local hit-set pattern used by melee and area attacks is
  deterministic, lifecycle-safe, and smaller.
