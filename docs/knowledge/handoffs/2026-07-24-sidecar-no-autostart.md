# Session Handoff: Remove sidecar azure-queue auto-start (issue #1879)

## Date

2026-07-24

## Session Slug

sidecar-no-autostart

## Apples

🍎🍎 (Small) — actual 🍎🍎, verdict: exact

## Systems touched

sprite-pipeline, sprite-sidecar

## Problem

The local sprite sidecar (`scripts/sprites/sidecar/cli.ts`) automatically called
`worker.start()` and `issueIngester.start()` whenever the queue backend was
`azure-queue` (the sidecar's default production path). This caused any
long-running sidecar to silently race the `asset-request.yml` CI workflow for
production queue messages — generating art locally, outside CI's security gates.

Evidence: a stale sidecar (running since 2026-07-22) grabbed the #1307 quarterstaff
canary queue message at 06:38:07 on 2026-07-24, before CI run 30072835574 could
drain it. The sidecar completed generation locally at 06:43:14.

## What Was Done

### `scripts/sprites/sidecar/cli.ts`

Removed the `if (queue.backend === 'azure-queue') { worker.start(); issueIngester.start(); }`
block that ran after `app.listen()`. Replaced it with log messages directing operators
to use the on-demand HTTP API routes (`POST /api/workflow/worker/start`,
`POST /api/workflow/issues/start`) or the devtools UI.

The `worker` and `issueIngester` controllers are still:
- Constructed in `cli.ts` and passed to `buildServer()` (needed by the API routes)
- Available on-demand via the existing HTTP routes in `server.ts`
- Used by CI via `sprites:ingest-once` (explicit, single-poll, one-shot)

### `tests/unit/sprites/sidecar-cli-no-autostart.test.ts`

Added a source-string regression guard that reads `scripts/sprites/sidecar/cli.ts`
and asserts it does NOT contain `worker.start()` or `issueIngester.start()`. This
prevents the auto-start from being re-introduced silently.

## Unchanged (intentionally)

- `scripts/sprites/worker-cli.ts` (`sprites:worker`): already defaults to noop
  queue; requires explicit `SPRITES_ASSET_QUEUE=azure-queue` to hit production.
  Used by CI in drain mode (`SPRITES_WORKER_DRAIN=true`). No change needed.

- `scripts/sprites/ingest-once-cli.ts` (`sprites:ingest-once`): designed for CI
  (single-poll, no background timer). Already gated via explicit env vars. No change
  needed.

- `scripts/sprites/sidecar/server.ts`: worker/ingester API routes remain intact;
  operators can still manually start them via the devtools UI.

## Acceptance Criteria Verification

- ✅ Starting the sidecar (`sprites:gallery`) does NOT auto-start the worker or
  issue ingester against the production azure-queue backend.
- ✅ `worker.start()` and `issueIngester.start()` are absent from `cli.ts`; they
  only appear in `server.ts` HTTP route handlers.
- ✅ Gallery / sprite-review UX unchanged (server routes intact).
- ✅ Regression guard test added in `tests/unit/sprites/sidecar-cli-no-autostart.test.ts`.

## Files Changed

- `scripts/sprites/sidecar/cli.ts` — removed auto-start block, updated banner
- `tests/unit/sprites/sidecar-cli-no-autostart.test.ts` — new regression guard
- `docs/knowledge/review-ledgers/2026-07-24-sidecar-no-autostart.review-ledger.json` — ledger (2🍎)
- `docs/knowledge/handoffs/2026-07-24-sidecar-no-autostart.md` — this file

## PR

Closes nalfeo/Crawler#1879
