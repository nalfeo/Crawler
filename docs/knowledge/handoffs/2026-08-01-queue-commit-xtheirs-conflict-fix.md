# Handoff: queue-commit `-X theirs` conflict fix (2026-08-01)

## Summary

Follow-up to the `--allow-unrelated-histories` fix (PR #2532). After that landed,
the asset pipeline publish step hit a second blocker: a **real merge conflict** on
`.github/agents/set-piece-designer.agent.md` between the orphan `assets/queue`
branch and `main`.

Root cause: the orphan `assets/queue` commit (`61d824c28`) included non-art files
that diverged from `main`. When `git merge --allow-unrelated-histories` runs with
no common ancestor, every file in both trees appears as "added" — if the same file
has different content on each side, git cannot auto-resolve it.

Fix: add `-X theirs` to the `--allow-unrelated-histories` retry so all conflicts
auto-resolve in favour of `main`. Art files that exist only on the queue branch
(new icons/sprites not yet in main) appear as "added by ours" only — no conflict,
no data loss.

## Files touched

- `scripts/sprites/queue-commit.ts` — added `-X theirs` to the fallback merge args
- `tests/unit/sprites/queue-commit.test.ts` — updated regression test expectation
- `docs/knowledge/review-ledgers/2026-08-01-queue-commit-xtheirs-conflict-fix.review-ledger.json`
- `docs/knowledge/handoffs/2026-08-01-queue-commit-xtheirs-conflict-fix.md` (this file)

## Verification

- `npx vitest run tests/unit/sprites/queue-commit.test.ts` → 29/29 pass
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
