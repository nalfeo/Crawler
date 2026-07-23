# Handoff: Floor 2 Weapon Wave A

## Date

2026-07-20

## Persona

Producer coordinating Game Designer, Systems Engineer, QA Engineer, and Reviewer concerns.

## Systems touched

weapons, inventory, ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The implementation introduced a
generator-only weapon catalog, deterministic integration, focused coverage, and
the required two-round review harness.

## Summary

Delivered exactly 25 Floor 2 weapon base definitions across all ten canonical
weapon families:

- blade: 3;
- axe: 3;
- bludgeon: 3;
- polearm: 3;
- bow: 3;
- firearm: 2;
- thrown: 2;
- magic-focus: 2;
- beam: 2;
- trap: 2.

The bases are immutable generator inputs rather than globally equippable static
inventory entries. Stable `weapon.*` base IDs resolve through the landed
generated-equipment contracts, while each generated instance freezes the
canonical runtime art key and active weapon snapshot. Existing legacy base lookup
and generic art fallback behavior remain intact.

## Hard asset boundary

No sprite or asset work was generated, judged, approved, checked in, queued,
labeled, reopened, or mutated. No Azure resource, asset workflow, asset issue,
asset catalog, or asset pull request was changed. This slice only references the
already-landed stable runtime art-key contract and preserves the existing generic
fallback.

## Design decisions

1. A separate generator-only Wave A catalog prevents generated bases from
   leaking into the static inventory enumeration.
2. An explicit 25-ID allowlist makes stable-ID normalization auditable and keeps
   the existing 50-ID art manifest unchanged.
3. Common bases carry no baked stat bonuses. Common, Uncommon, and Rare
   generated instances continue to use the constitutional rarity scalars and
   exact effect budgets from the shared generator.
4. Every authored weapon remains available through `getWeaponDef` so frozen
   active weapon snapshots use the same deterministic combat definition as the
   generated base.

## Review

- Plan review, `gpt-5.4`: six concerns resolved; `major_fork` replaced direct
  static registration with the generator-only catalog.
- Code review round 1, `claude-sonnet-4.6`: no implementation defects; one
  process sequencing concern was resolved by recording the incomplete stage
  honestly.
- Code review round 2, `claude-sonnet-4.6`: clean across correctness, edge cases,
  state lifecycle, deterministic generation, API compatibility, security,
  runtime wiring, performance, regression coverage, and repository policy.
- Review-thread follow-up: deterministic generated-snapshot combat coverage now
  proves all 25 Wave A IDs spawn the intended production attack kind, and
  representative fixtures realize damage through melee, collision, returning,
  beam, and trap pipelines. This also fixed the `storm-sling` ranged bounce
  branch to honor its authored `bounceCount`.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-20-floor-2-weapon-wave-a.review-ledger.json`.

## Validation

- Focused Wave A tests cover the exact 25-ID roster, ten-family distribution,
  unchanged 50-ID manifest, generator-only inventory isolation, deterministic
  legal rarity generation, stable art keys, frozen weapon snapshots, all 25
  attack-spawn contracts, and representative production-pipeline damage
  realization.
- The existing constitutional aggregate realized-DPS integration gate still
  covers its legacy representative cohort; this slice now supplements that gate
  with explicit Floor 2 Wave A generated-snapshot combat coverage instead of
  claiming the DPS harness already exercised those IDs.
- `npm run typecheck` passed during implementation.
- `npm run verify:fast` passed after implementation and review.
- Review-ledger validation and `npm run verify:pr-prereqs` passed before PR
  creation.

## Commits

- `36882f1b` — implementation and focused tests.
- `e26ad67d` — review round 1 ledger record.
- `ec1d3187` — production-pipeline coverage and ranged bounce-path fix.

## Follow-up

Subsequent weapon waves may add the remaining planned bases using the same
generator-only catalog boundary. Asset production remains an independent
workflow and was intentionally excluded from this task.
