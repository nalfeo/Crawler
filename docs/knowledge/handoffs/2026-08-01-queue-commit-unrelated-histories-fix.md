# 2026-08-01 — queue-commit unrelated-histories fix

## Summary

The Asset Request Pipeline failed at the "Publish selected variants" step with
`fatal: refusing to merge unrelated histories` when trying to merge `main` into
the `assets/queue` worktree. The `assets/queue` branch was an orphan (single
commit `61d824c28`, zero shared ancestry with `main`), so the plain `git merge`
call in `runQueueCommit` rejected it.

Fixed by adding a targeted fallback in `queue-commit.ts`: if the standard merge
fails with the "unrelated histories" diagnostic, retry once with
`--allow-unrelated-histories`. All other failures still throw immediately.

## Context

- Triggered while processing Wave 1 of Floor 2 mob sprite generation
  (14 issues #2503–#2516, 10 sprites successfully generated in Azure Blob Storage
  before the first run timed out; the second run generated the remaining 4 but
  then failed at publish).
- The `assets/queue` branch had been created/left as an orphan at some earlier
  point (likely from the icon-batch pipeline creating it with `--orphan` or a
  history squash).

## Files touched

- `scripts/sprites/queue-commit.ts` — fallback merge logic (~15 lines)
- `docs/knowledge/review-ledgers/2026-08-01-queue-commit-unrelated-histories.review-ledger.json`

## Verification

- `npx vitest run tests/unit/sprites/queue-commit` → 32/32 pass
- `npm run verify:fast` → ✅

## Unresolved issues

- The `assets/queue` branch is still an orphan. After this fix merges, the next
  successful pipeline run will produce a merge commit joining the two histories.
  Going forward the branch will share ancestry with `main`.
- Wave 1 sprite generation (14 mobs) ran but publish failed. After this fix
  merges, re-trigger with `gh workflow run "Asset Request Pipeline"` to publish
  the already-generated sprites.

## Recommended next steps

1. Merge this PR (fast CI, 1 file, pre-approved by tests).
2. Re-trigger `gh workflow run asset-request.yml` to publish the 14 Wave 1
   sprites that are waiting in Azure Blob Storage.
3. Open Wave 2 (13 issues) once Wave 1 closes.
