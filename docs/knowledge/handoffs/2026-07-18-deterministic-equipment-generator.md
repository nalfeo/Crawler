# Handoff: Deterministic Equipment Generator

## Date

2026-07-18

## Persona

Systems Engineer, with separate-model plan and code review.

## Systems touched

inventory, weapons, ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The slice added one deterministic
generation facade over the existing registry, snapshot, and grant contracts,
with focused unit/property/runtime integration coverage and the full 3-apple
review harness.

## Authority and stack

- Authoritative issue: #1558
- Branch: `nalfeo-d1-deterministic-equipment-generator`
- Planned PR base: `nalfeo-active-weapon-snapshots`
- Exact consumed and final C1 head:
  `b5f88d9824c996fc025d1c2c0fec00f4ddae566d`
- Explicit second prerequisite C2, exact consumed and final head:
  `bdb0e8736afde5c2bfd70cd847e408f469c01e5c`
- Exact shared B1 ancestor:
  `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- C1/C2 convergence merge:
  `fc33e024b78c51214e32e15d68fb62bf138da2e8`
- Convergence parents:
  `b5f88d9824c996fc025d1c2c0fec00f4ddae566d` and
  `bdb0e8736afde5c2bfd70cd847e408f469c01e5c`
- Final pre-publication re-fetch found no C1 or C2 drift.
- Structured `STACKED-WORK` evidence:
  <https://github.com/nalfeo/Crawler/issues/1558#issuecomment-5009524397>

The only convergence conflict was the generated handoff index; it was
regenerated with `npm run docs:index`. All code and public contracts merged
without conflict. This session did not edit the Producer-owned epic PLAN or
`epic-state.json`.

## What changed

- Added `generateEquipmentInstance(world, request)` as the sole generation
  facade. It resolves canonical static equipment/weapon definitions and commits
  complete records only through B1's world-owned generated-equipment registry.
- Normalized existing static equipment definitions into the existing
  `GeneratedEquipmentBaseV1` shape without adding a parallel full-instance
  registry or mutating/freezing source definitions.
- Implemented canonical base -> item level -> inherent scaling -> rarity
  scalar/budget -> enhancement -> effects -> freeze ordering. Initial V1
  weapon and armor family curves are explicit 10%-per-level linear-percent
  curves; accessories have no inherent scaling.
- Enforced Common/Uncommon/Rare exact 0/1/2 effect-unit budgets, configured
  rarity scalars, enhancement `+0..+5`, and illegal enhancement rejection for
  bases without inherent damage or armor.
- Added a bounded immutable effect catalog with add-only one-unit stat affixes
  and known two-unit active/passive grants. Rare generation explicitly chooses
  between available one-major and two-minor shapes, then chooses one canonical
  legal combination. Duplicate and mutually exclusive combinations cannot be
  produced, and there is no reroll loop.
- Deferred the sole nearest-half-up damage/armor normalization until all level,
  rarity, enhancement, and resolved-effect math is complete.
- Froze deterministic display names, art keys, stats, grant lists, C1 active
  weapon snapshots, and B1 canonical fingerprints. C2 source ownership consumes
  generated effect ordinals unchanged.
- Kept save/carryover, rewards, merchants, UX, AI, Unique/above-Rare content,
  and all production generation sources outside this slice.

## Runtime observation

Before D1, B1/C1/C2 accepted caller-assembled registry inputs but there was no
public deterministic generator that resolved a static base into a complete
frozen instance.

After D1, `tests/integration/generated-equipment-runtime.test.ts` generates
through a configured real `GameWorld` registry, activates the resulting pistol
by registry identity, and observes its frozen damage through the real
`weaponSystem` projectile pipeline. The same suite generates both active and
passive grant items and applies/revokes them through C2's source-owned APIs.

## Review and validation

- Plan review, `gpt-5.4`: five concerns resolved with minor divergence. The
  implementation adopted explicit family curves, final-only normalization,
  explicit Rare budget-shape weighting, add-only V1 stat effects, and a scoped
  runtime integration proof without inventing an excluded production source.
- Code review round 1, `claude-sonnet-4.6`: four valid coverage gaps resolved
  for cross-kind fingerprint determinism, rare-accessory draw counts,
  non-weapon static immutability, and non-inherent base-stat preservation.
- Code review round 2, `claude-sonnet-4.6`: clean across correctness,
  determinism, contracts, security, runtime ownership, performance, and policy.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-18-deterministic-equipment-generator.review-ledger.json`
- Focused unit/property suite: 9 tests passed.
- Real runtime integration suite: 3 tests passed.
- `npm run verify:fast`: 22 files and 228 tests passed.
- No guard telemetry artifact existed for this session.

## Publication

Publish a ready, non-draft stacked PR targeting
`nalfeo-active-weapon-snapshots`. Record
`nalfeo-sourced-ability-grants` at
`bdb0e8736afde5c2bfd70cd847e408f469c01e5c` as the explicit second
prerequisite. Do not merge or arm auto-merge.

## Follow-up: strict test narrowing

A dependent preflight reproduced two `TS2339` errors on published head
`d858c905c074f77047d5b70d901c07d99ce0a443`: TypeScript did not retain the
`ResolvedEquipmentStatEffectV1` narrowing across separate `filter()` and
`reduce()` callbacks. The assertions now discriminate `effect.kind` inside each
reduction callback before reading `effect.value`, preserving the same runtime
coverage without a cast or weakened type contract.

`npm run typecheck` was the authoritative reproduction command. The pre-fix
`npm run verify:fast` invocation returned success despite the same typecheck
failure, so this follow-up keeps the D1 fix test-only and records that verifier
behavior for the coordinator rather than expanding into an unrelated
infrastructure change. A separate 1-apple ledger records the bounded follow-up:
`docs/knowledge/review-ledgers/2026-07-18-deterministic-equipment-generator-narrowing-followup.review-ledger.json`.
