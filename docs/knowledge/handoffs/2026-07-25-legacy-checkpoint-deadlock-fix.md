# Handoff: Fix legacy asset-request checkpoint deadlock

**Date:** 2026-07-25
**Persona:** DevOps Engineer (sprite pipeline reliability fix)
**Apples:** 3 estimated, 3 actual (tooling-only cap)

## Systems touched

sprite-pipeline, sprite-workflow

## Outcome

The Asset Request Pipeline was fully deadlocked: run 30142823820 logged 250 invalid
checkpoint skips and published 0 assets, with 18 open asset-request issues stuck
forever. Root cause was commit 49d133cea introducing a strict v1 checkpoint schema
(`{version:1, stage, updatedAt, stages: Record<...>}`) for the resumable 8-stage
pipeline, while every issue open before that merge still had a "legacy" flat checkpoint
blob (`{issueNumber, fingerprint, stage, updatedAt, details?}`, no `version`/`stages`)
at the same blob-store key. Two independent bugs both keyed off that same legacy shape:

1. The ingester's dedup logic saw legacy `stage:'completed'` and treated the issue as
   permanently done, so it was never re-enqueued — even though the new pipeline never
   actually completed or published it.
2. The worker's checkpoint loader strictly parsed every checkpoint and threw a permanent
   `checkpoint-invalid` error on any legacy blob it did reclaim, with no recovery path —
   matching the reported symptom of issue #1313 failing twice with `checkpoint-invalid`
   before the drain exited 1.

Both are fixed. A legacy checkpoint can no longer permanently deadlock ingestion, worker
resume, or publication: the ingester now falls through to its existing heartbeat-staleness
check for legacy `completed` docs (instead of a blanket short-circuit), and the worker now
recognizes a narrow, structurally-verified legacy shape and reinitializes it to a fresh v1
checkpoint — triggering a full, safe re-run under the new pipeline rather than synthesizing
fake successful stage output. The publisher was already fail-closed on invalid checkpoints
and required no code change.

## What changed

- **New module** `scripts/sprites/sidecar/issue-status-key.ts`: extracted the
  `ISSUE_STATUS_KEY_PREFIX` blob-key-prefix constant into its own dependency-free module.
  This breaks a former circular-import constraint (`issue-pipeline-checkpoint.ts` used to
  import this constant _from_ `issue-ingester-controller.ts`), so the ingester can now
  safely import `ISSUE_PIPELINE_CHECKPOINT_VERSION` from the checkpoint module
  one-directionally. `issue-ingester-controller.ts` still re-exports the constant from its
  own path for backward-compatible imports (tests, `ingest-once-cli.ts`).
- **`scripts/sprites/issue-pipeline-checkpoint.ts`**: added `isLegacyIssueRunStatusShape()`
  — a narrow structural detector requiring absence of `version`/`stages` AND presence of a
  positive-integer `issueNumber`, non-empty `fingerprint`/`stage` strings, and a parseable
  `updatedAt`. `loadIssueCheckpoint()` now checks this detector on schema-parse failure:
  - If the doc matches the legacy shape and its `issueNumber`/`fingerprint` match the
    requesting controller's identity, it returns a freshly-initialized v1 checkpoint
    (`stage:'queued'`, empty `stages`) instead of throwing. This is not persisted
    immediately — the next `runCheckpointStage` call durably overwrites the legacy blob.
  - If the identity does not match, it still throws `checkpoint-invalid` ("belongs to a
    different issue request"), same as for a valid-but-foreign checkpoint.
  - If the doc does not match the legacy shape at all (genuinely malformed/corrupt
    current-schema JSON), it still throws `checkpoint-invalid` exactly as before — this
    fail-closed path is unchanged and not weakened.
  - A documented, accepted tradeoff: a corrupt current-schema blob that happens to be
    missing exactly `version`+`stages` while keeping valid values for the other four
    fields is indistinguishable from legacy and will be treated as one. Noted in a code
    comment; considered acceptable since every current-schema writer always includes both
    fields.
- **`scripts/sprites/sidecar/issue-ingester-controller.ts`**: `readCompletionStage()` now
  also returns `isCurrentSchemaCheckpoint` (`version === ISSUE_PIPELINE_CHECKPOINT_VERSION
&& typeof stages === 'object' && stages !== null`). `isClaimStale()`'s short-circuit for
  `stage === 'completed'` now additionally requires `isCurrentSchemaCheckpoint`, so a
  legacy `completed` doc falls through to the existing heartbeat-staleness check instead of
  blocking reclaim forever, while a genuine v1 completed checkpoint still short-circuits to
  "not stale" even if its heartbeat is old.
- **`scripts/sprites/asset-request-publisher.ts`**: unchanged. `discoverReadyCheckpoints`
  already fail-closed skips any checkpoint that fails the strict zod parse; only a new
  regression test was added.
- **Tests** (all passing): `tests/unit/sprites/issue-pipeline-checkpoint.test.ts` (legacy
  reinit; runs a stage fresh and durably overwrites the legacy blob; identity mismatch on
  `issueNumber` and on `fingerprint` still throws; genuinely malformed current-schema JSON
  still throws; garbage JSON still throws), `tests/unit/sprites/issue-ingester-controller.test.ts`
  (legacy completed doc reclaims once its heartbeat is stale; legacy completed doc with a
  fresh heartbeat still blocks reclaim; a real v1 completed checkpoint still blocks reclaim
  forever even with a stale heartbeat), `tests/unit/sprites/asset-request-publisher.test.ts`
  (a legacy-shaped doc is skipped by `discoverReadyCheckpoints`).

## Verification run

- `npx vitest run tests/unit/sprites/issue-pipeline-checkpoint.test.ts
tests/unit/sprites/issue-ingester-controller.test.ts
tests/unit/sprites/asset-request-publisher.test.ts` — 38/38 passed.
- `npm run verify:fast` — typecheck, lint, and 242 changed unit tests all passed, plus
  physics-defs/size/weight coverage checks (all `0 blocking`).
- `npm run verify:pr-prereqs` — passed (review ledger valid; this handoff satisfies the
  handoff-required check).
- Separate-model plan review (rubber-duck, `gpt-5.5`): 1 blocking issue (the originally
  proposed ingester discriminator, bare `hasStages`, was too weak) resolved by requiring
  `version === ISSUE_PIPELINE_CHECKPOINT_VERSION && typeof stages === 'object'`; 4
  non-blocking suggestions all incorporated (tightened legacy detector, identity-mismatch
  tests, fresh-heartbeat-still-blocks test, documented residual ambiguity).
- Code-review loop (round 1, `claude-sonnet-4.6`): clean, no concerns — confirmed no new
  import cycle (`madge --circular` clean), no duplicate-publish/data-loss path (publisher's
  strict parse + existing conflict detection remain the backstop), and no gameplay/`src/core`
  `/src/engine`/`src/game` files touched.
- Review ledger: `docs/knowledge/review-ledgers/2026-07-25-legacy-checkpoint-deadlock.review-ledger.json`
  (valid 3-apple ledger: `plan_review`, `code_review`).

## Unresolved issues / recommended next steps

- No manual re-trigger is needed after this PR merges. The next scheduled/triggered
  `asset-request.yml` run will naturally pick up all 18 currently-stuck issues via the
  ingester's existing reclaim path (their claims are already older than the stale-claim
  TTL) and reprocess them fresh under the v1 pipeline.
- Two requests that were already shipped through other means (#1361 void-rapier, #1372
  chain-hauberk) were closed by the requesting session prior to this fix and are excluded
  from that count.
- No generated art or Azure state was touched by this PR, per the explicit requirement.
- This session does not wait locally for CI/review; the parent "Process asset issues"
  session will resume the asset wave once `main` contains this fix.
