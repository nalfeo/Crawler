# Handoff: Floor 2 Equipment Contract Foundation

## Date

2026-07-17

## Persona

Producer coordinating Game Designer, Systems, and Reviewer concerns.

## Systems touched

inventory, weapons, quests, ai-behavior-tree, ci-policy

## Apples

3 apples estimated, 3 apples actual (exact). The slice remained contract-only
but required cross-system authority, an ADR, issue coordination, state
validation, and the full 3-apple review harness.

## Stack

- Base branch: `nalfeo-floor-2-epic-control`
- Latest rebased A0 commit: `de709e08e1be83472bc7ecfe5e35a9d959e78fe2`
- A0 PR: #1271
- A1 child issue: #1277
- A1 branch: `nalfeo-floor-2-equipment-contracts`
- A1 PR: #1276, ready-for-review against A0

## Summary

Slice A1 freezes the implementation contract for generated Floor 2 equipment
without adding runtime gameplay:

- added the constitutional 1.7x-2.3x median aggregate realized-DPS target for
  every five-level representative-build band, initially enforced independently
  for levels 1 -> 6 and 6 -> 11;
- defined one versioned generated-instance identity across inventory, equipped
  slots, immutable reward bundles, boss chests, shop stock, and carryover;
- froze the resolution order, rarity scalars/effect budgets, bounded +0..+5
  enhancement, source-owned grants, fingerprints, atomic claims/purchases, box
  affinities, achievement counts, shop/chest rules, catalog normalization,
  deterministic AI maintenance contract, feature-flag closure, and migration
  behavior;
- preserved immutable static `WeaponDef` templates and specified a complete
  per-instance `ActiveWeaponSnapshotV1`;
- recorded the cross-system decision and rejected alternatives in ADR 0065;
- created and linked the separate Unique-equipment follow-up, outside the
  current 37-node epic DAG;
- kept the machine-owned PLAN contract and all 37 dependency edges unchanged;
- fixed a docs path-checker false-positive caused by a literal WSL example in
  `AGENTS.md`.

## Key decisions

1. Full generated records live only in a versioned registry. All ownership
   surfaces store instance references.
2. Frozen fields, not a later static catalog revision, drive display, weapon
   runtime behavior, AI scoring, save/load, and carryover.
3. Common / Uncommon / Rare use inherent scalars 1.00 / 1.05 / 1.10 and exact
   effect budgets 0 / 1 / 2. No rarity above Rare is valid in this epic.
4. Enhancement is a legal atomic immutable-record revision under the same
   identity, capped at +5 and +25% post-rarity inherent damage/armor.
5. Ability/passive grants use
   `equipment:<instanceId>:<effectOrdinal>` source ownership. The existing
   active-ability limit remains 10.
6. Floor 2 boxes use 25% / 50% / 75% same-tier equipment affinity; Floor 1
   remains equipment-free. Achievement reward resolution happens at unlock and
   claim is all-or-nothing.
7. Player and AI purchases use one atomic shared API. AI maintenance uses
   deterministic ERV, latching, hysteresis, cooldown, and the existing objective
   route planner only.
8. Unknown future generated-instance or weapon-snapshot versions fail closed;
   supported migration is deterministic, idempotent, and no-reroll.

## Epic-state truthfulness

The state manifest still records A1 as `blocked`, with null ownership, issue, and
PR. The A1 child issue is now materialized, but A0 is not validated, so A1
remains unclaimable under the normal lifecycle. The state manifest will retain
its current canonical lifecycle fields until A0 lands the orthogonal speculative
stacked-work schema. A stacked ready-for-review PR does not create a trusted
issue claim or permit fabricated `claimed`, `in_progress`, or `pr_open` state.

Until that schema lands, the child issue and this handoff record the durable
speculative facts:

```text
status: stacked_pr_open
issue: #1277
session: 6f852b99-3c14-4037-b6b2-7ec3947fe4fc
branch: nalfeo-floor-2-equipment-contracts
pr: #1276
head_sha: tracked in issue #1277
a0_pr: #1271
a0_branch: nalfeo-floor-2-epic-control
a0_head_sha: de709e08e1be83472bc7ecfe5e35a9d959e78fe2
last_resynced_a0_head_sha: de709e08e1be83472bc7ecfe5e35a9d959e78fe2
last_resynced_at: 2026-07-17T14:33:00.9948565-07:00
future_base: nalfeo-floor-2-stacked-work-protocol
rebase_to_main_required: true
```

These fields are progress evidence only and do not satisfy A0.

After A0 validates, the Producer must follow the exact sequence:

1. let the validator compute A1 `ready`;
2. post a structured `CLAIMED` lease with session, scope, and base commit;
3. record heartbeat / `in_progress`;
4. attach the existing PR and immutable HANDOFF/ledger evidence;
5. advance cached normal-lifecycle state to `pr_open`.

The coordinator authorized this speculative protocol and requested that state be
updated only after A0 pushes the schema amendment.

## Review

- Plan review, `gpt-5.4`: 7 concerns resolved; minor divergence tightened
  authority and lifecycle sequencing without re-architecture.
- Code review round 1, `claude-sonnet-4.6`: one valid concern, the unfilled
  ledger scaffold; resolved by recording the review.
- Code review round 2, `claude-sonnet-4.6`: clean across correctness,
  lifecycle, API compatibility, determinism, security, ownership, and coverage.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-17-floor-2-equipment-contracts.review-ledger.json`

## Validation

- `npm run verify:fast` passed after the contract edit and after review updates.
- `npm run epic:status -- floor-2-equipment` reports a valid schema/DAG, zero
  errors, zero warnings, and the expected pre-release blockers.
- `npm run review:ledger -- validate
docs/knowledge/review-ledgers/2026-07-17-floor-2-equipment-contracts.review-ledger.json`
  passed.
- `npm run docs:check` now passes path checking after the A1 fix, then stops on
  15 stale missing-path references in three ADRs already present on the A0 base.
  Those unrelated planned-file references were not folded into this bounded
  contract slice.

## Follow-up

- When A0.1 reports a stable head, fetch/rebase A1 onto
  `origin/nalfeo-floor-2-stacked-work-protocol`, retarget PR #1276 to A0.1,
  rerun focused validation, and update `epic-state.json` with the permitted
  orthogonal facts.
- After the prerequisites merge, fetch and rebase A1 onto `origin/main`,
  retarget PR #1276 to `main`, rerun focused validation, and then perform the
  protocol-compliant normal-lifecycle A1 claim/state reconciliation above.
- Do not merge or arm auto-merge without explicit authorization.
