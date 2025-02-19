# Handoff: Floor 2 Generated Equipment Instance Registry

## Date

2026-07-18

## Persona

Systems Engineer, with separate-model Reviewer validation.

## Systems touched

inventory, weapons, ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The slice stayed within one
world-owned registry and its shared serialization contracts, but required strict
unknown-boundary validation, deterministic hashing, immutable snapshots,
property coverage, and the full 3-apple review harness.

## Stack

- Child issue: #1289
- Branch: `nalfeo-generated-instance-registry`
- Planned PR base: `nalfeo-floor-2-equipment-contracts`
- A1 branch: `nalfeo-floor-2-equipment-contracts`
- A1 PR: #1276
- Exact A1 base and final fetched remote head:
  `4c11335a281842f82d206a4c42b23a28e2f40e91`
- Final merge-base:
  `4c11335a281842f82d206a4c42b23a28e2f40e91`
- A1 contract drift at final resync: none

## Summary

Slice B1 implements A1's generated-equipment identity and persistence boundary:

- added normalized v1 contracts for equipment base identity, resolved effects,
  frozen fields, complete active-weapon snapshots, generation provenance,
  generation policy, and registry snapshots;
- added stable `gei:v1:<runKey>:<ordinal>` instance keys;
- added dependency-free canonical JSON, synchronous SHA-256, and deep freezing
  for browser-safe deterministic fingerprints;
- added one opaque registry owned by each `GameWorld`, configured through an
  explicit immutable run key;
- added deterministic create, register, lookup, require, list, snapshot, and
  atomic restore APIs;
- added explicit fail-closed errors for unsupported versions, malformed payloads,
  duplicate instances, ordinal gaps, run-key mismatch, policy drift, and content
  fingerprint mismatch;
- preserved immutable global equipment and weapon definitions.

No bag or equipment movement, carryover, rewards, merchant stock, generator
catalog/formulas, source-owned ability behavior, weapon runtime consumption, AI,
or new ECS system was added. Because this is a registry service rather than an
exported `*System`, it has no lab or runtime-system wiring obligation.

## Contract and state decisions

1. A registry is unconfigured until the world receives an explicit
   `generatedEquipmentRunKey`; creation fails with `registry-unconfigured`
   otherwise.
2. Instance ordinals are contiguous and allocated only after full input
   validation, so rejected creates do not consume identity.
3. Registration accepts only the registry's next ordinal and rejects duplicate
   keys, cross-run instances, policy drift, and invalid content fingerprints.
4. Snapshot restoration validates the complete envelope and all records into
   temporary state before committing, preserving atomicity on any failure.
5. Generation-policy fingerprints cover only B1 frozen-content rules and
   versions. Economy, merchant, reward, AI, and later-slice tuning remain outside
   this contract.
6. Snapshot DTOs are plain, ordinal-sorted data with explicit schema version,
   run key, policy fingerprint, allocator state, and frozen instances.

## Review

- Plan review, `gpt-5.4`: four concerns resolved with minor divergence. The plan
  adopted pure-TypeScript SHA-256 with Node parity tests, explicit run identity,
  a narrow policy fingerprint, and plain ordered snapshot DTOs.
- Code review round 1, `claude-sonnet-4.6`: four concerns resolved. Two valid
  coverage gaps were fixed; two system-only lab/test-placement findings were
  deterministically inapplicable because the registry is not an ECS system.
- Code review round 2, `claude-sonnet-4.6`: cross-run isolation coverage was
  added for both registration and restore, then the confirmation pass was clean.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-17-generated-instance-registry.review-ledger.json`

## Validation

- Targeted registry unit/property tests: 15 passed.
- `npm run verify:fast`: 152 files and 1768 tests passed.
- Targeted ESLint over every changed TypeScript file passed.
- Review ledger validation passed as a complete 3-apple ledger.
- `npm run verify:pr-prereqs` passed.
- Offline and GitHub-backed read-only epic audits reported a valid schema/DAG,
  zero errors, zero warnings, and the expected blocked pre-release lifecycle.
- No guard telemetry artifact existed for this session.
- Apple record:
  `docs/knowledge/metrics/apples/2026-07-18-generated-instance-registry.json`

## Epic lifecycle and follow-up

Issue #1289 remains the live speculative ownership surface. B1 is still
canonically blocked; this session did not edit the Producer-owned `PLAN.md` or
`epic-state.json`. Structured claim and resync evidence is recorded on the
issue.

Open the ready stacked PR against `nalfeo-floor-2-equipment-contracts`. Do not
merge or arm auto-merge without coordinator authorization. After upstream
dependencies merge, rebase and retarget B1 in dependency order, rerun focused
validation, and let the Producer reconcile the canonical lifecycle.
