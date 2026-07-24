# Handoff — Durable asset-queue reviewer-finding fixes (PR #1872 follow-up)

**Date:** 2026-07-24
**Branch:** `nalfeo-sprite-worker-session`
**Persona:** DevOps Engineer
**Apple estimate:** 3🍎 (tooling-only — sprite/asset pipeline + devtools glue; no shipped
game data or runtime gameplay behavior changed, so the 3🍎 tooling cap applies)

## Systems touched

sprite-pipeline, sprite-workflow, devtools

## Why this PR exists

PR #1872 introduced the durable sprite-edit persistence primitive: approving/tagging a
sprite runs a `queue-commit` step that commits the asset PNG(s) + catalog metadata to a
long-lived `assets/queue` git branch so edits survive across worktrees/sessions. GitHub's
`copilot-pull-request-reviewer` raised **8 findings** on that PR, but PR #1872
**squash-merged to main before the fixes landed** (merge race at `69f728a12`). This branch
is the follow-up that lands the 8 confirmed fixes plus the hardening surfaced by re-review.

## What shipped

**Fixes for the 8 reviewer findings** (`#0 #2 #3 #4 #5` were sound as originally written;
`#1 #6 #7` needed real code):

- **#1a — metadata-route read-modify-write race** (`scripts/sprites/sidecar/server.ts`,
  `/api/workflow/metadata`). The route previously ran the (slow) metadata provider OUTSIDE
  the `withCheckinMutationLock` serializer and then wrote the **stale full catalog snapshot**
  back INSIDE the lock, clobbering any catalog edit that landed while the provider ran. Fix:
  keep the provider call outside the lock (it's slow and side-effect-free), but INSIDE the
  lock **re-read the fresh catalog from disk and merge only the changed entries** via a new
  pure helper `mergeChangedCatalogEntries(fresh, updated, changedIds)`
  (`scripts/sprites/metadata-pipeline.ts`). Falls back to `result.updated` if the fresh read
  fails to parse.
- **#1 — the metadata route now actually runs the durable queue-commit** for changed
  `generated:` entries (maps each changed id → its manifest asset → `runQueueCommit`), and
  returns the `queueCommit` status to the client. Previously the Tag button's re-queue never
  reached queue-commit, silently dropping the edit across worktrees.
- **#1c/#7 — client durability dishonesty** (`src/devtools-main.ts` Tag handler + new pure
  helper `metadataDonePatch` in `src/devtools/sprite-workflow-queue.ts`). Previously ANY
  non-`failed` queue-commit status was coerced to a green `'ok'`, so a no-op re-queue
  (`queueCommit: null`) or a ci-refused `skipped` fabricated a "durable / ready to use" state
  the tag never earned — erasing a real prior `'failed'`. Fix: `committed`/`noop` → `'ok'`;
  `failed` → `'failed'` (+ warning baked into `metadataSummary` so it survives recompute);
  `null`/`skipped`/unknown → **preserve** the item's prior durability.
- **#6 — approve-cli idempotent retry** (`scripts/sprites/approve-cli.ts`). An
  already-approved variant used to dead-end on a bare 409, permanently stranding an asset
  whose earlier durable push failed with no way to retry. Fix: on `ApproveError` kind
  `already-approved`, load the stored manifest entry via `loadApprovedEntry(...)`; if found,
  print a retry message and fall through to the **same CI-gated queue-commit block** the
  fresh-approve path uses, so a previously-failed push is re-attempted.
- **#2** — `assertSafeAssetPaths` guards the `generated/` prefix; **#3** — orphan
  `--asset`/`--manifest-key` flags rejected; **#4** — ADR plain-fast-forward wording;
  **#5** — handoff wording. (These were sound as merged into #1872's diff and carried forward.)

**New regression tests:**

- `tests/unit/sprites/sidecar-server.test.ts` — the `/api/workflow/metadata` route executes
  queue-commit for a changed generated entry (deterministic `status:'failed'` in the non-git
  temp root proves the durable push was reached), and returns `queueCommit:null` when nothing
  changed (no false durability).
- `tests/unit/sprites/sprite-metadata-pipeline.test.ts` — `mergeChangedCatalogEntries`
  (RMW-race guard: preserves concurrent adds, drops concurrent deletes of changed ids, no-op
  passthrough) + `changedIds` assertions on `runMetadataPipeline`.
- `tests/unit/devtools-sprite-workflow-queue.test.ts` — `metadataDonePatch` durability
  transitions, including the core #1c/#7 regression that a `null`/`skipped` re-queue
  **preserves** prior durability instead of fabricating green.

## ⚠️ Behavior change to note

`scripts/sprites/approve-cli.ts`: an **already-approved** variant now **exits 0** (was 1)
when `loadApprovedEntry` finds the stored entry, because that path is now a successful
durable-push retry (matching the fresh-approve path's exit-0-with-warning-on-failed-push
semantics). It still exits with the old error code when the entry cannot be loaded. No
`approve-cli.test.ts` exists, so no test asserts the old code.

## Known gap — surface to maintainer (separate follow-up, NOT fixed here)

**#1b client-id mismatch (pre-existing).** The Tag button sends
`ids: [item.kebabName]` (`src/devtools-main.ts`), where `kebabName` is a brief slug
(e.g. `baseball-bat-v1`), but generated catalog IDs are `generated:<brief>-var-N`. So
`targetIds.has('generated:...-var-0')` is always false and the Tag re-queue changes 0 entries
— the whole re-queue is inert via the Tag button. This is a **context line** in this diff
(not a `+`), i.e. pre-existing, so per rule #16 it belongs in its own PR. The #1a/#1 fixes
make the route *correct when it is given a real id*; wiring the button to pass the resolved
`generated:` id is the remaining efficacy fix.

## Observe-before-done

Deterministic, no live sidecar/DOM needed: the new sidecar-server route test drives the REAL
`/api/workflow/metadata` handler (`buildServer` + `app.inject`) end-to-end through the RMW
merge and the durable queue-commit, asserting the `queueCommit` status the client reads. The
`metadataDonePatch` tests prove the exact durability strings/verdicts the render path
consumes. `verify:fast` green (146 tests).

## Validation

- `npm run typecheck` → clean.
- `npm run verify:fast` → green (146 tests; typecheck + lint + changed unit tests +
  physics/size/weight coverage).
- Targeted: `sidecar-server.test.ts` (127) + `sprite-metadata-pipeline.test.ts` +
  `devtools-sprite-workflow-queue.test.ts` (109) all pass.
- Review harness (3🍎): separate-model plan review (gpt-5.6-sol) + code-review loop
  (round 1 gemini-3.1-pro-preview, round 2 claude-sonnet-4.6). Ledger:
  `docs/knowledge/review-ledgers/2026-07-24-sprite-queue-reviewer-fixes.review-ledger.json`.

## Follow-ups

1. **#1b** — wire the Tag button to pass the resolved `generated:<brief>-var-N` id (separate PR).
2. Consider an `approve-cli.test.ts` covering the already-approved retry exit-0 path.
