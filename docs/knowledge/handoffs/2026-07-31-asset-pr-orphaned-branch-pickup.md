# Handoff: Harvest orphaned assets/checkin-\* branches in asset-pr and reconciler

**Date:** 2026-07-31  
**Session slug:** asset-pr-orphaned-branch-pickup  
**Apple estimate:** 🍎🍎  
**Systems touched:** sprite-pipeline

## Summary

63 `assets/checkin-*` branches had accumulated on the remote since June 27 with
no open PRs and no `asset-checkin` labeled issues. Both `npm run sprites:asset-pr`
(the local dev consolidation tool) and the hourly `sprite-queue-reconciler` only
inspected the issue queue / `assets/queue` branch — neither ever looked at bare
`assets/checkin-*` branches. This session wired both pipelines to auto-harvest
those orphaned branches.

## Root cause

The old check-in pipeline pushed `assets/checkin-<slug>` branches AND filed
`asset-checkin` labeled issues. At some point the issue-filing step was dropped or
issues were closed manually, leaving branches stranded. Neither downstream consumer
(`asset-pr` / reconciler) had a fallback that operated on branches alone.

## Files touched

- `scripts/sprites/asset-pr.ts` — added `scanOrphanedCheckinBranches`; extended
  `PlanConsolidationInput`, `ConsolidationPlan`, `planConsolidation`,
  `renderPrBody`, and `runAssetPrConsolidation` to discover and overlay orphaned
  branches alongside issue-backed sources
- `scripts/sprites/reconcile-queue.ts` — exported `scanOrphanedCheckinBranches`;
  extended `runReconcile` (step 2b/3b), noop check, and worktree overlay to fold
  orphaned branches; updated `buildPrContent` to report orphan count
- `tests/unit/sprites/reconcile-queue.test.ts` — 8 new `scanOrphanedCheckinBranches`
  unit tests (Layer 2b, faked exec)
- `.github/skills/asset-pr/SKILL.md` — updated steps 2/3
- `.github/skills/asset-pr/references/playbook.md` — rewritten What-it-does section;
  added §Recovery: Orphaned branches entry
- `docs/knowledge/review-ledgers/2026-07-31-asset-pr-orphaned-branch-pickup.review-ledger.json`

## Verification

- `npx tsc --noEmit` — clean (exit 0)
- `npx vitest run tests/unit/sprites/asset-pr.test.ts tests/unit/sprites/reconcile-queue.test.ts`
  — 60/60 tests pass (including 8 new `scanOrphanedCheckinBranches` tests)
- Prettier check passed on push

## Design decisions

- **Non-fatal scan:** `scanOrphanedCheckinBranches` returns `[]` on any query
  failure (ls-remote or gh pr list). Conservative: more branches get harvested;
  the trust-boundary guard (`assertArtSurfaceOnly` / `assertArtSurfaceModes`)
  still validates every staged path before commit/push.
- **AM-only overlay:** orphaned branches contribute only `--diff-filter=AM` paths
  within `ASSET_SURFACE_PATHS` (same as queue). Deletions are never promoted to
  avoid reverting art that arrived via an independent flow.
- **Last-writer semantics:** later branches win on collision, consistent with the
  queue union. Issue-backed sources are overlaid first, orphaned branches second.
- **Guard still validates:** both the queue checkout guard and the orphan overlay
  run inside the existing `assertArtSurfaceOnly` + `assertArtSurfaceModes` checks.

## Unresolved issues

- PR #2358 (`assets/promote`) was passing CI but had a stale `ci-recovery-waiting`
  label. It should be armed: `gh pr merge 2358 --auto --squash`.
- PRs #2083 and #2089 are superseded old-style Copilot asset PRs — they should be
  closed with a note.
- After this PR merges, trigger `workflow_dispatch` on `sprite-queue-reconciler.yml`
  to immediately fold the 63 orphaned branches into `assets/promote`.

## Recommended next steps

1. Merge this PR (arm: `gh pr merge <n> --auto --squash`)
2. `gh pr merge 2358 --auto --squash` — arm the existing promote PR
3. Close #2083 and #2089 with: `gh pr close 2083 --comment "Superseded by the new queue pipeline"`
4. Dispatch `sprite-queue-reconciler.yml` via GitHub Actions → the reconciler will
   pick up all 63 orphaned branches on its next run
