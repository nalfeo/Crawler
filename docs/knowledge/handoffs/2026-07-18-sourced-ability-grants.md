# Handoff: Source-Owned Equipment Ability Grants

## Date

2026-07-18

## Persona

Systems Engineer, with separate-model plan and code review.

## Systems touched

inventory, weapons, ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The slice stayed within the
ability/equipment ownership boundary, but required versioned migration, atomic
multi-source state transitions, carryover reconstruction, property coverage, and
the full 3-apple review harness.

## Stack

- Authoritative child issue: #1393
- Branch: `nalfeo-sourced-ability-grants`
- Planned PR base: `nalfeo-generated-instance-registry`
- B1 PR: #1379
- Exact requested B1 dispatch head:
  `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- Final fetched B1 remote head:
  `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- Final merge-base:
  `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- B1 drift at final resync: none

The structured `STACKED-WORK` heartbeat on #1393 records the same issue,
session, branch, dependency PR/branch, base SHA, and dependency head. This
session did not edit Producer-owned `PLAN.md` or `epic-state.json`.

## Summary

C2 adds versioned source ownership for active and passive ability availability:

- active/passive ownership maps retain every independent learned, skill,
  equipment, or legacy source;
- generated-equipment sources use
  `equipment:<GeneratedEquipmentInstanceId>:<effectOrdinal>`;
- grant/revoke batches validate on cloned state and install atomically;
- duplicate grant/revoke is deterministic and idempotent;
- revoking one source preserves every other source and removes passive modifiers
  immediately only after the final source disappears;
- active ownership remains distinct from active loadout configuration, and the
  authoritative ten-slot limit is unchanged;
- equipment-granted actives fill open slots but remain known and inactive at the
  cap;
- level-five skill grants now record `skill:<skillId>:<level>` ownership;
- carryover serializes ordered ownership, reconstructs passive modifiers, and
  migrates plain IDs to learned/legacy ownership without guessing provenance;
- well-formed retired IDs remain in persisted ownership for round-trip
  compatibility but are filtered from runtime active, learned, and passive
  lists;
- malformed sources, source conflicts, known kind mismatches, unknown new grant
  requests, and unsupported ownership versions fail explicitly.

No inventory movement, generated content, weapon snapshots, rewards, merchant
logic, AI selection, or new abilities were added. No new exported `*System` was
added, so there is no new lab or runtime-system wiring obligation.

## Contract and state decisions

1. Ownership maps are authoritative for availability. Existing
   `equippedActiveAbilityIds` remains the runtime configuration surface.
2. Learned spell and passive lists are deterministic derived views. Retired IDs
   survive only in ownership serialization and cannot consume active slots,
   suppress rewards, affect achievements, or apply modifiers.
3. Public new grants validate registered ability kind strictly. Persisted
   migration tolerates a missing catalog definition so older saves can
   round-trip without activating unknown behavior.
4. Batch validation includes source format, ability kind, and the invariant that
   one source cannot own multiple ability IDs or kinds. Failed batches do not
   create holder state or alter existing state/modifiers.
5. Equipment grant resolves a real frozen B1 registry instance. Equipment
   revoke scans authoritative ownership by exact instance prefix, so registry
   teardown cannot strand a grant.
6. Passive carryover excludes derived passive modifiers and reconstructs them
   once from ownership after restore.

## Review

- Plan review, `gpt-5.4`: five concerns resolved with minor divergence. The
  resulting plan tightened closed write paths, immediate passive cleanup,
  missing-state atomicity, legacy-only migration, and carryover authority.
- Code review round 1, `claude-sonnet-4.6`: two concerns resolved. Registry-free
  revocation now removes authoritative sources, and normalized runtime reads use
  an allocation-free fast path.
- Code review round 2, `claude-sonnet-4.6`: persistence compatibility and
  snapshot purity were corrected. Focused `gpt-5.4` validation found and then
  confirmed the fix for retired IDs leaking into runtime-facing lists.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-18-sourced-ability-grants.review-ledger.json`
  validates as a complete 3-apple ledger.

## Validation

- Focused ability/equipment/skill/property/carryover suite: 67 tests passed.
- Real shipped visual pipeline observation:
  `tests/integration/fireball-pulse-shield-integration.test.ts` passed 3 tests,
  proving a learned source remains configured and activates through
  `createFloor1MainSceneOptions()` plus engine `runSimulationStep`.
- `npm run verify:fast`: 158 files and 1832 tests passed.
- `npm run scope`: `art_only=false`, `docs_only=false`,
  `gameplay_safe=false`; discretionary full/headless gates remain CI-owned.
- Offline epic audit: valid schema/DAG, zero errors, zero warnings.
- GitHub-backed read-only reconcile audit: valid, zero errors, zero warnings,
  no operator actions, and `writes_performed=false`.
- `npm run verify:pr-prereqs` passed.
- No guard telemetry artifact existed for this session.
- Apple record:
  `docs/knowledge/metrics/apples/2026-07-18-sourced-ability-grants.json`

## Publication and follow-up

Open a ready, non-draft stacked PR targeting
`nalfeo-generated-instance-registry`. Do not merge or arm auto-merge. C2 remains
canonically blocked while B1 is open. If B1 moves, stop, rebase once onto the
new exact dependency head, rerun focused validation and publication gates, and
post refreshed `STACKED-WORK` evidence on #1393 before updating the PR.
