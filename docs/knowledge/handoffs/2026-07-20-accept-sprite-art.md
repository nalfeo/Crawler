# Session Handoff: Atomic sprite acceptance

## Summary

Added one-click `Accept & queue` support to the Sprite Generation Workflow
canvas. Acceptance is owned by one sidecar operation that approves the chosen
variant, selectively projects only that asset, and creates or reuses its durable
`asset-checkin` issue. The canvas immediately renders accepting, queued, retry,
and actionable failure states.

## Systems touched

`sprite-pipeline`, `sprite-workflow`, `devtools`

## What changed

- Added token-gated canvas mutation and a workflow-to-sidecar acceptance client.
- Added a process-wide sidecar mutation lock spanning accept, approve, and
  legacy check-in routes.
- Added content-addressed open-issue reconciliation, duplicate-path conflict
  detection, and selective manifest/catalog/PNG projection.
- Preserved the browser gallery check-in button with an exact allowlist for this
  worktree's deterministic lab/devtools origins; arbitrary loopback and external
  origins remain rejected.
- Fixed workflow extension YAML loading through a repository-root
  `createRequire`.
- Added atomic acceptance, reconciliation, projection, CSRF, renderer, client,
  and mutation-token regression coverage.

## Runtime observation

Before the change, the real workflow canvas exposed generated variants but no
acceptance action. After the change, it exposed `Accept & queue`; accepting the
selected `iron-cleaver-v1` variant created asset issue 1710, a retry reused that
issue, and the canvas rendered `Already queued`.

After the final Origin-policy adjustment, the restarted real sidecar accepted
`http://localhost:8502` far enough to run check-in reconciliation and rejected
`http://localhost:9999` with `403 forbidden-origin`.

## Verification

- Focused sidecar suite: 108 tests passed.
- Changed sprite/workflow suites: 197 tests passed.
- `npm run verify:fast` passed.
- Final focused independent review of the trusted-origin delta was clean.

## Durable decisions

- Atomic accept belongs to the sidecar, not the canvas extension or a spawned
  CLI process.
- Open `asset-checkin:v1` issue payloads are the durable queue source.
- Same-path content mismatches and legacy hashless queued entries fail closed.
- `/accept` never trusts browser origins. `/checkin` trusts only exact
  per-worktree gallery origins or no-Origin server-side callers.

## Unresolved issues

Issue 1710 predates content hashes, so future reconciliation treats that payload
as legacy/ambiguous until the issue is closed or updated. This does not affect
the already-queued art or retry idempotency observed before hash enforcement.

## Apples

Estimated: 4🍎. Actual: 4🍎.
