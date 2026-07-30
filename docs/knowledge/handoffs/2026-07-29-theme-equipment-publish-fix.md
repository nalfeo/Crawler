# Handoff: unblock + speed up theme-equipment publish

**Date:** 2026-07-29
**Branch:** `theme-equipment-review-ops`
**Apples:** 3🍎 (asset-pipeline tooling)

## Systems touched

sprite-pipeline, sprite-workflow

## Problem

The theme-equipment `publish` action pushes approved sprite art onto the durable
`assets/queue` branch (which the hourly `sprite-queue-reconciler` then harvests
into an art-only PR to `main`). A live publish run for
`classic-fantasy-basic-leather` **failed** at the git queue-merge step:

```
theme-equipment publish failed: assets/queue could not merge current main:
fatal: refusing to merge unrelated histories
```

Separately, that run spent ~39 minutes just downloading the 18 approved runs'
blobs from Azure **serially** before it even reached the merge.

## Root causes & fixes

### 1. Merge failure — shallow checkout (the blocker)

`.github/workflows/theme-equipment.yml` "Checkout for publish" step used
`actions/checkout@v4` with only a `token:` and **no `fetch-depth`**, so it
defaulted to a shallow depth-1 clone. `scripts/sprites/queue-commit.ts` then
fetches `assets/queue` and `main` into that shallow repo and runs
`git merge --no-edit <mainRef>` — which fails with "refusing to merge unrelated
histories" because the shallow tips share no common ancestor.

**Fix:** add `fetch-depth: 0`. Verified via `git merge-base origin/assets/queue
origin/main` → `9c8075…` is a genuine common ancestor (the queue tip is itself a
merge containing a main commit), so this is purely a shallow-history artifact,
not an orphan branch. Matches the sibling `sprite-queue-reconciler.yml` (line 53)
which does the same `assets/queue` integration with `fetch-depth: 0`.

### 2. Serial Azure blob downloads (the slowness)

`__stageThemeEquipmentRun` (`scripts/sprites/theme-equipment-runner.ts`)
downloaded every blob under `${briefId}/${runId}/` one-at-a-time
(`for (const key of keys) { … await store.get(key) }`).

**Fix:** bounded chunked-batch parallel download at concurrency **4** (new
`THEME_EQUIPMENT_STAGE_DOWNLOAD_CONCURRENCY`, mirroring
`THEME_EQUIPMENT_JUDGE_CONCURRENCY` and the existing chunk pattern in
`theme-equipment-review-cli.ts:359`). Each key writes a distinct path with an
idempotent recursive mkdir, so reads are independent. A rejecting batch uses
`Promise.allSettled` and only rethrows **after** the batch fully settles, so no
in-flight write can outlive the caller's `stageRoot` cleanup (`publish()`'s
`finally`). Concurrency 4 (not 8) because the installed Azure retry policy does
**not** retry HTTP 429 — a higher fan-out raises burst/throttle risk with no
matching benefit. `stageApprovedAssets` is intentionally left serial (it owns
dedup/ordering/manifest mutation; the inner blob loop was the dominant cost).

## Observe before done

- **Before:** publish run 30493311247 (branch `theme-equipment-review-ops`) —
  serial download 21:41→22:20 UTC (~39 min), then hard-failed at the queue merge
  with "refusing to merge unrelated histories".
- **After (deterministic):** unit tests assert the real artifacts — the publish
  checkout parses `fetch-depth: 0` (integer); a delayed in-memory store proves
  max in-flight GETs is `>1` and `<= cap` while every byte still lands; a
  mid-batch failure proves the whole batch settles (`settled === keyCount`)
  before the error propagates.
- **After (runtime):** run 30500748320 (branch `theme-equipment-review-ops`,
  23:49→00:19 UTC):
  - "Checkout for publish" → **success in 5 s** — no "refusing to merge
    unrelated histories"; the `fetch-depth: 0` fix is confirmed ✅
  - "Publish approved theme set" ran ~29 min (vs ~39 min downloads-only in the
    failed run) — parallel download speedup confirmed ✅
  - Failed with a **content conflict** (`CONFLICT (modify/delete):
    public/assets/generated/manifest.json` + `CONFLICT (content):
    src/shared/data/sprite-catalog.json`) — unrelated to the shallow-checkout
    or serial-download fixes; `main` advanced with new sprite catalog changes
    while the queue was stale between the two publish attempts.

## Tests

- `tests/unit/theme-equipment-workflow.test.ts` — publish checkout has
  `fetch-depth: 0`.
- `tests/unit/sprites/theme-equipment-runner.test.ts` — bounded-concurrency
  download (max in-flight ≤ cap, all bytes land) + settle-before-throw on
  failure.

`npm run verify:fast` green; `npx vitest run --project sprites
theme-equipment-runner` (16) + `--project unit theme-equipment-workflow` (2)
green.

## Review

3🍎 harness: plan review (gpt-5.6-terra, approve-with-changes — all 4 concerns
adopted) + code review (claude-sonnet-4.6, clean round 1). Ledger:
`docs/knowledge/review-ledgers/2026-07-29-theme-equipment-publish-fix.review-ledger.json`.

## Next steps (to reach an art PR)

1. Merge this PR.
2. Re-dispatch publish from `main`:
   `gh workflow run theme-equipment.yml --ref main -f action=publish -f set_id=classic-fantasy-basic-leather`.
   The set is already `complete`/`held` (queue-commit precedes the publication
   mutation, so the failed run left durable state publishable) → art lands on
   `assets/queue`.
3. Dispatch the reconciler to open the art-only PR immediately instead of
   waiting for the top of the hour:
   `gh workflow run sprite-queue-reconciler.yml`.
