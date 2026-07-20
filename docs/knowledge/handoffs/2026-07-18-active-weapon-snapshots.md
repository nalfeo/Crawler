# Handoff: Immutable Active Weapon Snapshots

## Date

2026-07-18

## Persona

Systems Engineer

## Systems touched

weapons, inventory

## Apples

3🍎 estimated, 3🍎 actual (exact). Apple record:
`docs/knowledge/metrics/apples/2026-07-18-active-weapon-snapshots.json`

## Stack / dependency resync

- Issue: #1391
- Branch: `copilot/c1-add-immutable-active-weapon-snapshots`
- Dependency branch: `nalfeo-generated-instance-registry`
- Required dependency head: `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- This session merged the dependency branch first; final merge-base vs
  `origin/nalfeo-generated-instance-registry`:
  `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- Current head after the C1 implementation commit(s):
  `9a28e45228eb5b727bcfb419ed65818647fddc69`

## What changed

- Extended `ActiveWeaponSnapshotV1` so snapshots are now:
  - `WeaponDef`-compatible for existing runtime consumers,
  - stamped with `generatedEquipmentInstanceId`,
  - stamped with canonical class/type skill tags,
  - stamped with their own deterministic SHA-256 fingerprint.
- Added deterministic snapshot helpers in
  `src/core/generated-equipment-registry.ts`:
  - `createActiveWeaponSnapshotV1(...)`
  - `validateActiveWeaponSnapshotV1(...)`
  - `computeActiveWeaponSnapshotFingerprint(...)`
  - `requireGeneratedEquipmentActiveWeaponSnapshot(...)`
- Tightened generated-equipment validation so a frozen weapon snapshot must:
  - use the supported schema version,
  - carry a valid generated-instance id,
  - match the owning generated instance id during create/register/restore,
  - carry canonical skill tags derived from its class/type skill ids,
  - carry a content-matching fingerprint.
- Updated `src/core/active-weapon.ts` so snapshot inputs are resolved through the
  world registry and the registry-owned frozen snapshot becomes authoritative;
  stale or missing identities now fail closed instead of being silently accepted.
- Updated `src/game/weaponSystem.ts` switch handling to key off active-weapon
  generation changes rather than raw weapon id equality, so swapping between two
  snapshots with the same base weapon id still resets readiness/cooldown
  correctly.

## Key decisions

1. **Keep the seam narrow.** The runtime still consumes one active-weapon shape;
   generated snapshots were made `WeaponDef`-compatible instead of rewriting the
   broader combat stack.
2. **Registry authority beats caller copies.** When a snapshot is set active, the
   core seam validates the inbound object, then resolves and stores the
   registry-owned frozen snapshot by `generatedEquipmentInstanceId`.
3. **Identity for generated switches is content-aware.** Snapshot equality is
   based on `generatedEquipmentInstanceId + fingerprint`, not just the base
   weapon id, so same-base replacements do not inherit stale readiness.
4. **Producer-side generated equip flow remains deferred.** This slice only
   implements the immutable snapshot contract + runtime consumption seam; it does
   not add new inventory movement or generated-item equip APIs.

## Tests added

- `tests/unit/active-weapon-snapshot.test.ts`
- `tests/property/active-weapon-snapshot.property.test.ts`
- `tests/integration/active-weapon-snapshot-pipeline.test.ts`
- updated `tests/unit/generated-equipment-registry.test.ts`

The integration test proves the key runtime behavior change: two snapshots with
the same base weapon id now behave as distinct real switches and fire with their
own frozen combat stats.

## Validation

- Focused tests:
  - `npx vitest run tests/unit/active-weapon-snapshot.test.ts tests/unit/generated-equipment-registry.test.ts tests/property/active-weapon-snapshot.property.test.ts tests/integration/active-weapon-snapshot-pipeline.test.ts`
- `npm run verify:fast`
- `npm run epic:status -- floor-2-equipment`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-active-weapon-snapshots.review-ledger.json`
- `npm run verify:pr-prereqs`
- `parallel_validation` (Code Review + CodeQL): no valid C1 findings; CodeQL reported 0 alerts and noted the JS DB was skipped for size.

## Review harness

- Ledger:
  `docs/knowledge/review-ledgers/2026-07-18-active-weapon-snapshots.review-ledger.json`
- Plan review: `gpt-5.4`, divergence `minor`
- Code review: clean on the narrowed C1 diff from both `gpt-5-mini` and
  `claude-sonnet-4.6`

## Notes / blockers

- The maintainer explicitly requested posting the plan comment on issue #1391
  before coding. I attempted both `gh issue comment` and a direct GitHub API
  POST, but this sandbox blocks both routes (`gh` is unauthenticated against the
  local mirror remote and direct `api.github.com` POSTs were blocked by the DNS
  monitoring proxy). The same plan was still written in session chat, but the
  issue comment itself remains an environment blocker rather than a completed
  step.
- `files/guard-telemetry.jsonl` did not exist in this session, so no telemetry
  capture was required.
