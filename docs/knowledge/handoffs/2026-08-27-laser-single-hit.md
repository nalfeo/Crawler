# Handoff: Laser single-hit firing

## Date

2026-08-27

## Persona

Game Designer

## Systems touched

weapons

## Apples

Estimated: 3🍎. Actual: 3🍎. Verdict: exact — the runtime fix also required
tooltip and AI equipment-model alignment plus the three-apple review harness.

## Summary

Laser beams now damage each enemy at most once per firing. The beam continues
scanning during its lifetime, so enemies entering later can still be hit once,
and a later firing can damage the same enemies again.

## Implementation

- Added world-local, per-beam target hit maps keyed by target EID and generation
  to `beamSystem`.
- Clear beam hit state when a beam EID is spawned/reused and when its lifetime
  expires.
- Updated theoretical single-target DPS and AI equipment valuation from four
  same-target ticks to one hit per target.
- Recorded the cross-layer contract in
  `docs/knowledge/adr/2026-08-27-beam-single-hit-contract.md`.
- Replaced the repeated-hit test contract with deterministic coverage for
  same-beam deduplication, late entrants, later firings, and skill-event
  deduplication, including replacement enemies that recycle a hit target's EID.

## Observe before/after

- Before: the focused regression observed a 100 HP enemy at 94 HP after two
  3-damage ticks from one laser firing.
- After: the enemy remains at 97 HP for the beam's full lifetime; a late entrant
  is hit once, and both enemies reach 94 HP only after the next beam fires.
- Real artifact: the headless shared `runSimulationStep` beam broad-phase
  determinism guard passed for both grid and full-scan paths.

## Validation

- Focused laser runtime/model tests: 41 passed.
- Beam-related ECS, game, integration, and headless pipeline tests: 108 passed.
- `bash scripts/agent/verify-fast.sh`: passed.
- Secret scan of implementation, tests, and ledger: no secrets.
- Three-apple plan review: approved with minor plan additions; 7/7 concerns
  resolved.
- Code-review loop: clean in round 1.
