# Session Handoff: Floor 2 speculative stacked-work protocol

## Date

2026-07-17

## Persona

Producer / Systems Engineer

## Systems touched

ci-policy, docs-tooling, agent-personas

## Apples

3 apples estimated -> 3 apples actual. Full JSON:
`docs/knowledge/metrics/apples/2026-07-17-floor-2-stacked-work-protocol.json`.

## What Was Done

Implemented the A0.1 control-plane follow-up without changing equipment gameplay
or A0 PR #1271:

- Bumped the Floor 2 epic state to `crawler-epic-state/v2` and added an
  orthogonal `stacked_work` model. Lifecycle remains `blocked`; speculative
  states never satisfy dependencies or enter the ready queue.
- Added durable stacked owner, issue, session, branch, prerequisite PR,
  stack-base, resync, dependent PR, material-drift, and rebase-to-main facts.
- Kept every unvalidated prerequisite head exact while treating the dependent
  branch's own `observed_head_sha` as a nullable GitHub cache. A committed
  self-head cannot be exact because the cache-refresh commit changes that same
  head.
- Added deterministic offline rejection for ineligible lanes, missing or
  conflicting ownership, incomplete prerequisite coverage, stale dependency
  heads/bases/resyncs, closed PRs, and invalid merge/rebase transitions.
- Added read-only GitHub reconciliation for owner and PR drift. It proposes
  cache patches and operator actions but never mutates lifecycle or completion.
- Made trusted `BLOCKED` comments revoke both normal and speculative ownership,
  so stale stacked metadata can be cleared without waiting for lease expiry.
- Expanded the focused suite to 39 tests, including nullable dependent-head
  caching, prerequisite closure, dependent drift, ownership conflicts, and
  GitHub-observed rebase head/base proof.
- Preserved the approved 37 delivery nodes. Protocol issue #1282 is the sole
  A0.1 tracker; #1281 and #1285 are closed duplicates. A1's authoritative issue
  remains #1279.

## Final State

A0 PR #1271 is still open at
`62ed78aa06240094f10e13bf47cdcc5fe569adbd`. A1 did not rebase before A0.1
publication, so its stale speculative lease was revoked with a trusted
`BLOCKED` comment and canonical A1 `stacked_work` was cleared. A1 remains
lifecycle `blocked`, and downstream readiness remains empty.

A0.1 is independently finalizable: after its ready PR is open, A1 may rebase
once onto the published A0.1 head, retarget PR #1276, and post fresh
`STACKED-WORK` evidence. A0.1 must not chase A1's resulting self-head in another
commit.

## Review and Validation

- Separate-model plan review: seven concerns, all adopted; divergence `minor`.
- Code-review round 1: two coverage gaps, both resolved.
- Code-review round 2: prerequisite-closure coverage and missing
  GitHub-observed-main-base completion proof, both resolved.
- Focused suite: 39 tests pass.
- `npm run verify:fast` passes.
- Offline and credentialed read-only GitHub audits are valid with zero errors,
  warnings, proposals, or operator actions and report `writes=false`.
- Review ledger:
  `docs/knowledge/review-ledgers/2026-07-17-floor-2-stacked-work-protocol.review-ledger.json`.

## Recovery

1. Read the canonical PLAN, schema, state, issue #1282, A0 PR #1271, and A1
   issue #1279.
2. Run `npm run epic:status -- floor-2-equipment`.
3. Run
   `npm run epic:status -- floor-2-equipment --github --reconcile` and confirm
   it remains read-only.
4. For each stacked node, require one live trusted owner, exact open
   prerequisite snapshots, one exact stack base, and stable dependent
   PR/branch/base identity. Treat `dependent.observed_head_sha` only as a
   nullable GitHub cache.
5. If the stack base merges, record exact merge facts and the GitHub-observed
   pre-rebase dependent head; rebase/retarget; require GitHub-observed new head
   and `base: main`; then clear stacked metadata.
6. Keep lifecycle blocked until every prerequisite is validated. Only normal
   readiness may advance the node afterward.

## What's Next

Open A0.1 as a ready PR targeting `nalfeo-floor-2-epic-control`. Verify its PR
head equals the remote branch head, then give that exact 40-character SHA and PR
number to A1 and the parent coordinator. Do not merge or arm auto-merge.
