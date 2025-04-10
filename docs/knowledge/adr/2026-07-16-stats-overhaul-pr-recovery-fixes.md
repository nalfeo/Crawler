# ADR: PR #1203 recovery fixes for stat-overhaul regressions

## Status

Accepted

## Date

2026-07-16

## Estimated Complexity

🍎🍎

## Context

PR #1203 introduced a broad stat-system overhaul. Follow-up review and CI surfaced five concrete regressions/blockers:

- equip/unequip eager recomputation updated `effectiveStats.maxHp` without applying the corresponding `Health.max/current` delta immediately;
- timed buff modifier magnitudes remained bare numbers, violating the scalable-metadata contract for magical outputs;
- equipment `weightLb` lacked API-boundary validation for non-finite/negative values;
- generated sprite manifest still used `mana-flask` naming after catalog rename to `recharge-tonic`;
- the stats spec listed stale `maxHp` base value;
- deterministic headless collision parity goldens drifted due intentional combat semantics changes on this branch.

## Decision

1. Introduce a shared helper (`src/core/derived-max-hp.ts`) that applies derived-max-HP deltas onto `Health.max/current` additively and reuse it from both eager equipment recompute and per-frame `statSystem`.
2. Change timed buff modifiers to scalable metadata (`{ base, scalesWithIntelligence }`) in shared types, schema validation, runtime resolution, and authored spell registry values.
3. Enforce finite, non-negative `weightLb` validation inside equipment definition validation before equip succeeds.
4. Rename the generated placeholder sprite artifact and manifest entry from `mana-flask` to `recharge-tonic` to align runtime item IDs with generated art lookup.
5. Correct the spec table base value for `maxHp` to match implemented constants.
6. Rebaseline `tests/headless/collision-pair-parity.test.ts` fingerprints to the deterministic values produced by the updated combat semantics on this branch.

## Consequences

### Positive

- Constitution-based max HP changes now apply immediately during equip/unequip and remain consistent with frame-loop behavior.
- Timed buff outputs now satisfy the same explicit scaling contract as other magical numeric fields.
- Invalid equipment weights cannot poison encumbrance calculations.
- `recharge-tonic` resolves generated art deterministically.
- CI headless parity gate reflects the intended deterministic behavior of this branch.

### Risks / Trade-offs

- Collision-parity baseline updates require careful auditing whenever gameplay semantics change; false-positive drift still needs explicit investigation.
- Timed buff schema changes require all authored buff modifiers to use the new scalable shape.

## Alternatives Considered

- **Do nothing and wait for per-frame stat sync:** rejected; players can act in the same frame as equip/unequip and would see stale health values.
- **Restrict scalable metadata to damaging/healing spell fields only:** rejected; it conflicts with the approved “every magical numeric output” contract.
- **Sanitize invalid `weightLb` at aggregation time only:** rejected; validation should fail closed at the equipment API boundary.
