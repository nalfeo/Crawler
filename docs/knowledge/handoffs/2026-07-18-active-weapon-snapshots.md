# Handoff: Immutable Active Weapon Snapshots

## Date

2026-07-18

## Persona

Systems Engineer, with separate-model Reviewer validation.

## Systems touched

inventory, weapons, ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The slice stayed within the
generated-equipment registry and active-weapon seam, with deterministic
fingerprinting, fail-closed validation, property coverage, and the full 3-apple
review harness.

## Stack

- Child issue: #1391
- Branch: `nalfeo-active-weapon-snapshots`
- Planned PR base: `nalfeo-generated-instance-registry`
- Exact B1 dispatch base: `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- Final fetched B1 head and merge-base:
  `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- B1 contract drift at final resync: none

## What Was Done

- Evolved B1's unpublished stack-only snapshot contract into the first complete
  `ActiveWeaponSnapshotV1`, carrying generated instance identity, base weapon
  identity, every runtime-consumed combat field, canonical class/type skill IDs,
  and a deterministic fingerprint.
- Added a separate create-input DTO whose override surface is limited to legal
  combat fields. Static names, weapon types, base IDs, and canonical skill tags
  continue to come from immutable `WeaponDef` data.
- Finalized snapshots only after deterministic generated-instance allocation,
  deep-froze the complete stored graph, included the finalized snapshot in the
  parent instance fingerprint, and added explicit errors for illegal overrides,
  missing identity, unsupported versions, and fingerprint drift.
- Added registry-only generated activation to the core active-weapon seam.
  Existing consumers still see an immutable `WeaponDef`-compatible view whose
  `id` remains the static base weapon ID, while an internal generated
  instance-plus-fingerprint key distinguishes same-base copies.
- Updated the existing, already-wired `weaponSystem` switch seam without adding a
  new exported system. Static weapon behavior and live-tune refresh semantics are
  preserved.
- Added unit, property, and integration coverage for immutability, validation,
  deterministic equality, per-field fingerprint sensitivity, static regression,
  and same-base generated-instance switching.

Observed in
`tests/integration/active-weapon-snapshot-runtime.test.ts` through the real
`weaponSystem` pipeline: before, B1 exposed only static weapon-ID activation so
two generated copies of one pistol had no distinct runtime switch identity;
after, switching between two registry instances with the same base ID advances
the weapon generation and applies each immutable snapshot's combat fields.

## Key Decisions Made

1. Generated activation accepts only an authoritative registry instance ID;
   caller-authored snapshots cannot cross the public active-weapon boundary.
2. Runtime `WeaponDef.id` stays the base/static ID for HUD, ability, and AI
   compatibility. Internal switch identity is separate:
   `static:<weaponId>` or
   `generated:<instanceId>:<snapshotFingerprint>`.
3. Snapshot fingerprints hash canonical JSON excluding only their own
   `fingerprint`; parent instance fingerprints include the complete finalized
   snapshot, including its nested fingerprint.
4. B1 and C1 jointly define the first published V1 contract. B1 has no
   production persistence caller, so introducing a synthetic V2 and migration
   path for an unpublished stack-only shape would misstate compatibility.
5. Source-owned abilities, inventory movement, generator/content policy,
   rewards, merchants, and AI remain outside this slice.

## Review and Validation

- Plan review, `gpt-5.4`: four concerns resolved with minor divergence. The plan
  adopted registry-only activation, separate compatibility/switch identities,
  explicit unpublished-B1 V1 evolution, and precise nested hash boundaries.
- Code review round 1, `claude-sonnet-4.6`: one schema-version concern was
  deterministically resolved as inapplicable to the unpublished stack contract.
- Code review round 2, `claude-sonnet-4.6`: complete confirmation pass clean.
- Focused unit/property/integration suite: 5 files and 24 tests passed.
- `npm run verify:fast`: 157 files and 1,799 tests passed.
- Offline and GitHub-backed read-only epic audits: valid schema/DAG, zero errors,
  zero warnings, and expected pre-release blockers.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-18-active-weapon-snapshots.review-ledger.json`
- Apple record:
  `docs/knowledge/metrics/apples/2026-07-18-active-weapon-snapshots.json`
- No guard telemetry artifact existed for this session.

## What's Next / Blockers

Open a ready, non-draft stacked PR against
`nalfeo-generated-instance-registry`. Do not merge or arm auto-merge. Issue
#1391 remains the ownership surface; the Producer owns canonical epic lifecycle
state. If B1 moves, stop on contract drift, rebase in dependency order, and
repeat focused validation before updating the stacked PR.

## Retrospective

### Lessons Learned

A static base weapon ID and a generated runtime switch identity serve different
compatibility contracts. Keeping them separate preserves existing readers while
making same-base generated copies observable to cooldown state.

### Mistakes Made

The initial dispatch named #1392 because parallel issue-creation results were
returned out of order. The mismatch was caught before edits by comparing the
issue scope against the requested exclusions; work resumed only after the
Producer explicitly corrected authority to #1391.

### Opportunities for Future Improvement

A follow-on equipment/inventory slice can add its public equip command on top of
the registry-only activation API. It should preserve this seam rather than
accepting serialized or caller-authored snapshots.
