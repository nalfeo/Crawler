# Handoff: Deterministic AI Loadout Scoring

## Date

2026-07-18

## Persona

AI Content Engineer / Game Designer, with separate-model plan and code review.

## Systems touched

ai-behavior-tree, inventory, weapons, ci-policy

## Apples

3 apples estimated, 3 apples actual. The slice adds one pure loadout-transition
evaluator, narrow shared production-math seams, and focused
unit/property/runtime integration coverage.

## Authority and stack

- Authoritative issue: #1568, `Build deterministic AI equipment loadout
scoring`.
- Issue #1567 is I1 and was not implemented. Parallel issue creation originally
  returned the numbers in the opposite order; the live #1568 body was verified
  before publication.
- Branch: `nalfeo-ai-loadout-scoring`.
- Planned PR base: `nalfeo-d1-deterministic-equipment-generator`.
- Exact updated D1 head:
  `23bdec65ee7a8689d229dd1b7d67e922e5e0bc6b`.
- Exact C1 ancestor:
  `b5f88d9824c996fc025d1c2c0fec00f4ddae566d`.
- Exact C2 ancestor:
  `bdb0e8736afde5c2bfd70cd847e408f469c01e5c`.
- After fetching, local D1, remote D1, H1 pre-implementation HEAD, and
  merge-base all matched the updated D1 head exactly. Explicit ancestry checks
  confirmed both C1 and C2.
- H1 did not carry a workaround for D1's test narrowing failure. D1 published
  the test-only fix first; H1 rebased onto it and then passed authoritative
  `npm run typecheck`.

## What changed

- Added `evaluateEquipmentLoadoutCandidates`, a pure deterministic evaluator for
  complete legal transitions over canonical generated instances.
- Validates current slot legality and candidate records, displaces every
  conflicting equipped instance, removes exact equipment-owned ability sources,
  applies candidate grant sources, and preserves/fills active configuration
  under the production ten-slot cap.
- Scores next-minus-current expected run value across named offense, defense,
  mobility, active ability, passive ability, encounter fit, affinity,
  encumbrance, and purchase-cost components.
- Uses immutable C1 weapon snapshots and C2 source ownership plus production
  effective-stat, cadence, cooldown, scalable output, armor, accuracy,
  encumbrance, and weapon-prerequisite contracts.
- Extracted pure combat-math seams and a weapon prerequisite predicate, then
  rewired the existing runtime consumers through the same helpers to prevent
  evaluator/runtime formula drift.
- Ranks by score descending, fingerprint ascending, then instance ID ascending;
  map/set inputs are normalized before scoring.
- Performs no equip, inventory, purchase, ability-configuration, routing,
  pathfinding, safe-room, achievement, or world mutation and exports no ECS
  system.

## Runtime observation

Before H1, D1 generated immutable equipment and C1/C2 exposed weapon snapshots
and source ownership, but no production consumer could compare a whole legal
loadout transition or emit an ERV breakdown.

After H1,
`tests/integration/equipment-loadout-evaluator.integration.test.ts` generates
and registers a real D1 pistol in a configured `GameWorld`, passes that exact
frozen instance and C1 weapon snapshot into the evaluator, observes positive
offense and affinity values, and confirms the registry and generated instance
remain unchanged. Unit/property coverage additionally proves reordered
candidate equivalence, AOE versus single-target shape, active/passive equipment
sources, defense/encumbrance tradeoffs, displacement and purchase cost, legal
filtering, finiteness, replay determinism, and non-mutation.

## Review and validation

- Plan review, `gpt-5.4`: seven concerns resolved with minor divergence,
  including explicit encounter/config inputs, full-transition optimization,
  production formula reuse, exact C2 ownership semantics, and stable
  fingerprint/instance tie-breaking.
- Code review round 1, `claude-sonnet-4.6`: two coverage gaps resolved with
  direct boundary/property tests for shared combat math and weapon prerequisite
  matching.
- Code review round 2, `claude-sonnet-4.6`: clean across correctness,
  determinism, contracts, security, runtime ownership, performance, and policy.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-18-ai-loadout-scoring.review-ledger.json`.
- Focused evaluator/runtime/formula regressions: 136 tests passed.
- Authoritative `npm run typecheck`: passed after rebasing onto updated D1.
- `npm run verify:fast`: 168 files and 1,906 tests passed.
- No guard telemetry artifact existed for this session.

## Publication

Publish a ready, non-draft stacked PR targeting
`nalfeo-d1-deterministic-equipment-generator`. Do not merge or arm auto-merge.
