# Handoff: queue-commit orphan-branch conflict fix v3 (2026-08-01)

## Summary

Follow-up to the `--allow-unrelated-histories` fix (PR #2532). After that landed,
the asset pipeline publish step hit a second blocker: a **real merge conflict** on
`.github/agents/set-piece-designer.agent.md` between the orphan `assets/queue`
branch and `main`.

Root cause: the orphan `assets/queue` commit (`61d824c28`) included non-art files
that diverged from `main`. When `git merge --allow-unrelated-histories` runs with
no common ancestor, every file in both trees appears as "added" — if the same file
has different content on each side, git cannot auto-resolve it.

**v2 attempt** (superseded): `-X theirs` on the retry merge auto-resolved
conflicts in `main`'s favour, but would silently discard any queued art if a sprite
filename existed on both branches with different content — unsafe.

**v3 (this PR)**: Instead of any `-X` flag, on an "unrelated histories" condition:

1. `git reset --hard mainRef` — bring the working tree to a clean `main` state,
   discarding all non-art files from the orphan commit.
2. `git checkout baseRef -- public/assets/generated` — layer the queued art files
   back from the orphan tip on top of the clean main tree.
3. `git add public/assets/generated` — stage only the art surface.

No merge commit is needed. This approach is semantically cleaner: it never touches
non-art files from the orphan branch, and it cannot conflict on art files (we
explicitly check out the queued art we want).

## Files touched

- `scripts/sprites/queue-commit.ts` — replaced `-X theirs` retry with reset+checkout approach
- `tests/unit/sprites/queue-commit.test.ts` — rewrote regression suite (4 tests; covers reset path, non-reset path, pathspec error treated as empty queue, pathspec error re-thrown on unexpected error)
- `docs/knowledge/review-ledgers/2026-08-01-queue-commit-xtheirs-conflict-fix.review-ledger.json`
- `docs/knowledge/handoffs/2026-08-01-queue-commit-xtheirs-conflict-fix.md` (this file)

## Verification

- `npx vitest run tests/unit/sprites/queue-commit.test.ts` → 30/30 pass
- `npm run verify:fast` → ✅ Fast verification passed

## Unresolved issues

- Wave 1 (14 mob sprites) still needs to complete after this fix merges
- Once the fix lands on `main`, retrigger the asset pipeline via issue edit
- After Wave 1 publishes, open Wave 2 (13 issues)

## Recommended next steps

1. Merge this PR
2. Retrigger asset pipeline: `gh issue edit 2503 --body "$(gh issue view 2503 --json body --jq '.body')\n<!-- retrigger: $(date -u +%FT%R) -->"`
3. Wait for the publish step to succeed (two-run drain: ~50 min total)
4. Verify `asset-checkin` issues created for all 14 Wave 1 sprites
5. Run `npm run sprites:asset-pr` locally to batch into one art PR
6. Open Wave 2 (13 issues) after Wave 1 issues close
