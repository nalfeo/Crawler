# ADR 0067: Runtime-Aligned Equipment Loadout Scoring

## Status

Accepted

## Date

2026-07-21

## Estimated Complexity

🍎 x 3 — touches deterministic AI, core combat math, game runtime consumers, and
generated-equipment ability ownership.

## Context

Floor 2 AI needs to rank complete generated-equipment loadout transitions before
equipping or purchasing an item. The score must be deterministic, must not mutate
the world or candidate records, and must reflect the behavior the runtime can
actually realize.

Several formulas cross architectural layers. Player damage scaling, crit expected
value, armor mitigation, weapon accuracy, and weapon-skill prerequisites are
runtime contracts, but the evaluator also needs them for expected-run-value (ERV)
scoring. Duplicating those formulas inside `src/game/ai/` would let the planner and
combat runtime drift. The evaluator also consumes source-owned ability grants from
the generated-equipment system and must simulate the same grant revocation rules
as a real unequip.

The stakeholders are the deterministic AI planner, core combat systems, generated
equipment and ability ownership, balance tooling, and maintainers reviewing future
runtime mechanics.

## Decision

- **DEC-001**: Equipment scoring is a pure deterministic function over frozen
  generated-equipment instances, explicit encounter fixtures, stat inputs, and
  cloned ability-source maps. It does not read wall-clock time, consume RNG, mutate
  a `GameWorld`, or mutate caller-owned collections.
- **DEC-002**: Cross-layer combat formulas are extracted into pure functions in
  `src/core/combat-math.ts` and called by both runtime systems and the evaluator.
  Weapon-prerequisite matching is likewise shared through
  `src/shared/weapon-skills.ts`.
- **DEC-003**: ERV values only runtime-realizable behavior. Beam activations include
  the immediate hit and repeated duration ticks; arena-wall bounces do not count as
  enemy hits; skill-triggered activations are capped by both event arrival rate and
  cooldown capacity; effects whose backing stat has no runtime consumer contribute
  zero until that consumer exists.
- **DEC-004**: Loadout transitions mirror runtime source ownership. Displacing a
  generated instance removes both `equipment` and `generated-equipment` sources
  with the matching instance ID, while learned, skill, and unrelated equipment
  sources remain available.
- **DEC-005**: Candidate ordering is canonical and stable. Invalid occurrences do
  not reserve an instance ID, so the first legal occurrence remains eligible.
  Equal scores use stable deterministic identity ordering.

## Consequences

### Positive

- **POS-001**: Runtime and planner damage, armor, accuracy, and prerequisite formulas
  share one implementation, reducing balance drift.
- **POS-002**: Identical inputs replay to identical finite rankings without changing
  simulation RNG trajectories or caller state.
- **POS-003**: Ability grants and displacements are scored with the same ownership
  semantics used by actual equip and unequip transitions.
- **POS-004**: Runtime gaps remain visible instead of being hidden by speculative
  value assigned to unimplemented mechanics.

### Negative

- **NEG-001**: The evaluator must be updated whenever a scored runtime mechanic
  changes its realization model.
- **NEG-002**: Explicit encounter fixtures add configuration surface and require
  representative tuning data.
- **NEG-003**: Some future-facing stats intentionally score as zero until their
  runtime consumer lands, which can make generated items appear weaker in advance
  of that implementation.

### Risks

- **RSK-001**: A new runtime attack path could bypass the shared helpers and
  reintroduce formula drift. Focused parity tests and code review must verify each
  new consumer.
- **RSK-002**: Poor encounter fixtures can produce deterministic but strategically
  weak rankings. Fixture changes require balance evidence rather than seed-specific
  tuning.
- **RSK-003**: Tick-count or trigger-order changes in the runtime can stale ERV
  assumptions; regression tests must encode the realized pipeline behavior.

## Alternatives Considered

### Duplicate Runtime Formulas in the Evaluator

- **ALT-001**: **Description**: Reimplement damage, armor, accuracy, and weapon
  prerequisite formulas entirely inside `src/game/ai/`.
- **ALT-002**: **Rejection Reason**: Independent copies can silently diverge,
  allowing AI choices to optimize for combat behavior the game no longer uses.

### Score Static Item Budgets Instead of Simulated Loadouts

- **ALT-003**: **Description**: Rank candidates from rarity, item level, effect-unit
  budget, and raw stat totals without simulating displacement or encounters.
- **ALT-004**: **Rejection Reason**: Static budgets cannot represent whole-loadout
  opportunity cost, active-slot pressure, weapon replacement, source-owned grants,
  encumbrance, or encounter-specific value.

### Monte Carlo Combat Sampling

- **ALT-005**: **Description**: Run sampled combat simulations for every candidate
  and average the realized outcomes.
- **ALT-006**: **Rejection Reason**: Per-decision simulation is materially more
  expensive, consumes or duplicates RNG streams, and makes reproducibility and
  failure diagnosis harder than closed-form deterministic ERV.
