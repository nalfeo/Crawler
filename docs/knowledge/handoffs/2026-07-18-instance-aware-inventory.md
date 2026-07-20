# Handoff: Floor 2 Instance-Aware Inventory

## Date

2026-07-18

## Persona

Systems Engineer, with separate-model plan and code review.

## Systems touched

inventory, weapons

## Apples

3 apples estimated, 3 apples actual (exact). The slice crossed shared inventory
contracts, equipment ownership, effective stats, encumbrance, UI compatibility,
and real-pipeline integration while preserving legacy static items.

## Stack

- Child issue: #1392
- Branch: `nalfeo-instance-aware-inventory`
- Planned PR base: `nalfeo-generated-instance-registry`
- B1 PR: #1379
- Exact consumed and final fetched B1 head:
  `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- Final merge-base: `4b03c88ce5a174eb823b96313520ce4eaf2bd48f`
- B1 contract drift at final resync: none
- CLAIM and STACKED-WORK evidence are recorded on #1392.

## Summary

Slice B2 implements exact generated-equipment ownership movement:

- added discriminated static-stack and generated-instance inventory entries while
  preserving the legacy `slots` lane;
- added exact-key bag helpers and world-wide duplicate ownership detection;
- widened equipped-slot identity to legacy numeric IDs or B1 generated keys;
- resolved generated records through the B1 world registry without copying them
  into the legacy equipment instance map;
- added atomic generated equip, swap, and unequip-to-bag transfers;
- preserved mixed static/generated swaps, multi-slot deduplication, requirements,
  effective stats, encumbrance, status cleanup, and legacy static behavior;
- updated equipment UI rendering, dirty signatures, generated tooltips, and
  unequip rebag responsibility for the new result contract.

## Atomicity and scope fences

All registry, ownership, requirement, displaced-item, and destination checks run
before transfer mutation. The commit path moves prevalidated occupants directly
and recomputes once, so no rollback can recreate or lose an exact key.

Generated active-weapon snapshots and ability/passive grants fail closed because
their owning slices have not landed. Floor carryover also fails closed when it
sees generated ownership until B3 persistence lands; this slice does not
serialize generated items. Rewards, merchants, generator/content, sourced
abilities, snapshots, and AI remain unchanged.

## Review

- Plan review, `gpt-5.4`: six concerns resolved with minor divergence.
- Code review round 1, `claude-sonnet-4.6`: four concerns resolved across UI
  rebag/render behavior, lab weight resolution, and carryover fail-closed
  handling.
- Code review round 2, `claude-sonnet-4.6`: one generated replacement-tooltip
  display concern resolved with regression coverage; terminal round clean.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-18-instance-aware-inventory.review-ledger.json`

## Validation

- Focused inventory/equipment/carryover/UI unit and property coverage passed.
- Real visual pipeline observation passed through
  `src/engine/sim/simulation-step.ts`: the exact key, +6 armor, and 18 lb
  equipped weight survived a full simulation step.
- `npm run verify:fast`: 141 files and 1686 tests passed.
- Review ledger validation passed as a complete 3-apple ledger.
- Offline epic audit reported a valid schema/DAG, zero errors, zero warnings, and
  the expected dependency-blocked pre-release lifecycle.
- No guard telemetry artifact existed for this session.
- Apple record:
  `docs/knowledge/metrics/apples/2026-07-18-instance-aware-inventory.json`

## Follow-up

Open the ready stacked PR against `nalfeo-generated-instance-registry`. Do not
merge or arm auto-merge. After B1 moves, rebase B2 in dependency order, rerun the
focused gates, and stop on any contract drift. Producer alone updates the global
PLAN and epic state.
