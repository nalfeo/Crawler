# Session Handoff: Floor 2 equipment epic control plane

## Date

2026-07-17

## Persona

Producer / DevOps Engineer

## Systems touched

ci-policy, docs-tooling, agent-personas

## Apples

3 apples estimated -> 3 apples actual. Full JSON:
`docs/knowledge/metrics/apples/2026-07-17-floor-2-epic-control.json`.

## What Was Done

Implemented Slice A0 as a durable, resumable control plane without changing
gameplay:

- Added the canonical Floor 2 equipment plan, including its approved progression
  gate, rarity/economy rules, execution lanes, dependency waves, tests, release
  flags, recovery/change protocols, and stable 70-base sprite manifest.
- Added a committed JSON Schema and 37-node epic manifest covering every approved
  slice and cloud packet, with lifecycle, ownership, evidence, GitHub, merge, and
  reconciliation metadata.
- Added `npm run epic:status -- floor-2-equipment` for deterministic offline
  schema/DAG/readiness/evidence/drift validation, deterministic issue packet
  rendering, and optional read-only GitHub reconciliation proposals.
- Added nine focused unit tests and a scoped scheduled/manual GitHub drift audit
  workflow. Reconciliation reports patches and operator actions but performs no
  writes.
- Bootstrapped the parent epic issue and a structured A0 claim. Bulk child issue
  writes remain deliberately outside A0; the materialization plan is the
  acceptance path, and follow-up issue #1269 tracks confirmed, idempotent online
  automation.

## Durable Authority

Field-specific authority is:

1. merged git and PR facts;
2. deterministic commit-addressed evidence;
3. trusted issue ownership and structured comments;
4. `epic-state.json` as an index/cache.

The Producer is the sole writer of global epic state. Child agents update only
their issue and dated handoff. Conversation history and local worktrees are never
authoritative.

## Review and Validation

- Separate-model plan review: eight concerns, all adopted; divergence `minor`.
- Code-review round 1: fixed GitHub pagination, full-SHA validation for GitHub
  facts, and content-hash drift coverage.
- Code-review round 2: fixed shared parent/A0 issue caching so node-specific
  reconciliation metadata is not suppressed; dedicated regression coverage added.
- Focused suite: 9 tests pass.
- `npm run verify:fast` passes.
- Offline and credentialed read-only GitHub audits are valid with no errors or
  warnings and perform no writes.

## Recovery

A fresh Producer should read `PLAN.md`, the schema, and `epic-state.json`; run
the offline status command; inspect referenced issues/PRs/workflows/branches,
handoffs, and ledgers; then run:

`npm run epic:status -- floor-2-equipment --github --reconcile`

Apply any stronger-fact reconciliation as one reviewed Producer update, then
dispatch only validator-computed ready nodes whose child issues exist.

## What's Next

After A0 merges and is validated, materialize child issues from:

`npm run epic:status -- floor-2-equipment --materialization-plan`

Then record the issue references in one reviewed global-state update and dispatch
only the computed ready queue. Equipment gameplay remains entirely deferred to
the downstream slices.
