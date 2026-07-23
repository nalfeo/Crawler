# Handoff: Equipment Carryover Persistence

## Date

2026-07-18

## Persona

Systems Engineer, with separate-model plan and code review.

## Systems touched

inventory, weapons, boss-rooms, ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The slice crossed the generated
equipment registry, inventory/equipment ownership, sourced abilities, frozen
weapon runtime state, versioned persistence, and the real floor-transition
pipeline.

## Stack

- Authoritative issue: #1556
- Branch: `nalfeo-equipment-carryover-persistence`
- PR base: `nalfeo-instance-aware-inventory`
- B2 PR: #1555
- Exact consumed B2 head:
  `169b744eaf2211633e4c66f4a79fda1d4398b7a0`
- Final fetched B2 head:
  `169b744eaf2211633e4c66f4a79fda1d4398b7a0`
- Final merge-base:
  `169b744eaf2211633e4c66f4a79fda1d4398b7a0`
- B2 contract drift at final resync: none
- CLAIM and STACKED-WORK evidence are recorded on #1556.

## Summary

Slice B3 implements exact generated-equipment persistence across JSON save/load
and Floor 1 to Floor 2:

- added `player-carryover/v1` plus deterministic migration for unversioned
  static-only snapshots;
- snapshots and atomically validates the one B1 registry before restoring it
  through the public registry API;
- persists exact generated bag keys, unique equipped keys, and unopened
  reference-only reward bundles without copying or reconstructing records;
- replays equipped generated instances through B2 bag/equip APIs so frozen slot,
  stat, grant, and weapon behavior remains authoritative;
- projects generated active weapons directly from their frozen snapshot, using
  the generated instance key as runtime identity and never consulting the
  current static weapon catalog;
- tracks active/passive grants by
  `equipment:<instanceId>:<effectOrdinal>`, preserving independently owned
  grants after the final equipment source is removed;
- propagates one immutable generated-equipment run key from production world
  creation through the Floor 2 restart options;
- rejects unsupported versions, duplicate physical owners, duplicate slots,
  dangling registry keys, and missing or mismatched grant sources before
  destination mutation;
- preserves legacy static inventory/equipment behavior and Floor 2 scenario
  modifiers, quests, goals, and mandatory feature unlocks.

## Scope fences

Floor 1 gains no equipment reward exposure. B3 adds no generation, rerolls,
reward claim behavior, merchant behavior, catalog reconstruction, alternate
instance containers, or Producer-owned PLAN/epic-state edits. Reward bundles are
stored as immutable registry references only.

## Runtime observation

`tests/integration/floor-transition-carryover.test.ts` exercised the production
`createFloorMainSceneOptions('floor1').onFloor1Cleared` callback, the returned
Floor 2 restart options, fresh world creation with the propagated run key, and
the real Floor 2 `configureWorld`/`initializeFloor2Scenario` restore path. The
exact registry, equipped instance key, frozen active weapon identity, sourced
ability grant, unopened bundle, active Floor 2 quest, and destination goal state
all survived.

## Review

- Plan review, `gpt-5.4`: six concerns resolved with minor divergence, covering
  production run-key wiring, B2 public API replay, sourced grant ownership,
  static migration, reward-bundle ownership, and production-path coverage.
- Code review round 1, `claude-sonnet-4.6`: clean across correctness, lifecycle,
  compatibility, ownership, determinism, security, runtime wiring, and
  regression coverage.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-18-equipment-carryover-persistence.review-ledger.json`

## Validation

- Focused unit, ECS, property, and integration coverage passed.
- `npm run verify:fast`: 158 files and 1,851 tests passed.
- Full lint and TypeScript typecheck passed.
- Review ledger validation passed as a complete 3-apple ledger.
- No guard telemetry artifact existed for this session.
- Apple record:
  `docs/knowledge/metrics/apples/2026-07-18-equipment-carryover-persistence.json`

## Follow-up

Publish a ready stacked PR against `nalfeo-instance-aware-inventory` and do not
merge or arm auto-merge. Producer alone updates the global PLAN and epic state.
