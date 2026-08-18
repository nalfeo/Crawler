# 2026-08-18 — Asset ingest/reconcile duplicate-churn fix

## Systems touched

sprite-pipeline, asset-manifest

## Problem

Maintainer reported: "Asset ingesting/reconciliation PRs are churning and
adding new versions of the same sprites over and over." Live evidence: PRs
#3081→#3091 (hourly `sprite-queue-reconciler.yml` runs) each added NEW
`-var-N`-suffixed files with incrementing `N` but IDENTICAL `contentHash` to
files already on `main` (e.g. `cactusfolk-boss`, `molefolk-elite-pit-boss`,
`ratfolk-elite-underboss`, `warding-bell` each had 3-6 duplicate-content
variant slots).

## Root cause (two parts)

1. **Stale naming lineage on `assets/queue`.** Commit `2896a4b77` (PR #3050,
   "fix(sprites): normalize brief IDs and merge variants") migrated `main`'s
   manifest/asset naming from `<brief>-v1-var-N` to bare `<brief>-var-N`
   (`sprite-name-taxonomy.ts` / `normalize-sprite-names.ts`). That migration
   ran ONLY against `main` — `assets/queue` (`git merge-base --is-ancestor
2896a4b77 origin/assets/queue` → false) still held ~470 entries under the
   old `-v1-var-N` names, many with pixel content byte-identical to what
   `main` already had approved under a bare name. Every hourly reconcile diffed
   `assets/queue` against `main` by PATH; since `main`'s history never
   contained a blob at the `-v1-` path (even though it had the identical BYTES
   at a different path), the existing ping-pong guard
   (`filterPromotablePaths()`, PR #2771, path/blob-hash based) never caught it
   — it reasons per-path, not per-content-across-paths. Each cycle re-promoted
   these stale files as "new".
2. **Missing cross-variant dedup at approve time.** `approveVariant()` in
   `scripts/sprites/approve.ts` only blocked re-approval when the EXACT target
   `variantId` (`briefId-var-N`) already existed with a matching
   `contentHash`. It never checked whether the same content already existed
   under a DIFFERENT variant index of the same brief, so re-promoting the
   stale queue content under a fresh index sailed through and minted a
   permanent duplicate slot on `main` — the reconciler could never converge
   for the affected assets.

## Fix

- `scripts/sprites/approve.ts`: added `findExistingVariantWithContentHash()`
  (scans sibling `entries/<briefId>-var-*.json` shards, guarding against
  brief-prefix false positives like `rat` vs `rat-fink`) and a new dedup check
  in `approveVariant()` that throws `ApproveError('already-approved')` when the
  content already exists under a different variant slot of the same brief,
  unless `allowReapprove` is set. This stops FUTURE duplicate approvals
  regardless of which pipeline triggers them (reconciler-fed queue, G2-B
  harvest, asset-request publisher).
- `tests/unit/sprites/approve.test.ts`: added 3 tests — cross-variant dedup
  throws `already-approved` referencing the colliding variant id; genuinely
  different content across variants still succeeds; `allowReapprove` bypasses
  the new check.
- `scripts/sprites/prune-stale-queue-duplicates.ts` (new, one-off tool): prunes
  `assets/queue` entries whose `contentHash` already exists on `main`, then
  runs the existing `normalizeSpriteNames` migration over the remainder so any
  genuinely novel content also loses its stale lineage tag. **Already run and
  pushed directly to `origin/assets/queue`** (commit `1c1243b06`): pruned 516
  duplicate entries (shard + PNG), 0 residual renames needed on the remaining
  124 entries (already canonical).
- `scripts/sprites/prune-duplicate-variants.ts` (new, hash-aware cleanup tool):
  applied to `main`'s generated asset tree and removed 61 same-brief,
  same-contentHash duplicates across `cactusfolk-boss`,
  `molefolk-elite-pit-boss`, `ratfolk-elite-underboss`, and `warding-bell`.
  It preserves every distinct content hash, including all legitimate cactus
  boss variants; only the higher-index copy of a repeated hash is removed.

## Verification

- `npx tsc --noEmit` — clean.
- `npx eslint scripts/sprites/approve.ts scripts/sprites/prune-stale-queue-duplicates.ts tests/unit/sprites/approve.test.ts` — clean.
- `npm run test:sprites -- tests/unit/sprites/approve.test.ts` — 52/52 passing (49 pre-existing + 3 new).
- `bash scripts/agent/verify-fast.sh` — full pass, 252 tests, asset-integrity check reports 695 shards / 577 contentHash values verified against PNG bytes, 0 blocking findings.
- Confirmed post-cleanup `assets/queue` has zero `-v1-var-N`/`-v2-var-N` style paths remaining (`git ls-files public/assets/generated | grep -v-var-` → 0 matches) and manifest entry count dropped from ~470 to 124.
- `npx tsx scripts/sprites/prune-duplicate-variants.ts --dry-run` after
  applying the cleanup reports 497 distinct hashes retained and 0 remaining
  duplicate groups.

## Follow-ups (not done in this session)

- Did not fully pin down which exact pipeline step was minting the fresh
  bare-name duplicate slots on `main` (only that it goes through
  `approveVariant`, which the fix directly covers regardless of caller).
- `g2b-harvest-approve.yml` has never actually run (empty `gh run list`) —
  confirmed NOT the active source of this churn, though it shares the same
  `approveVariant()` dedup path and benefits from the fix if ever invoked.
