# Handoff: CI recovery PR #1271 in-thread guidance

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

Investigated CI recovery loop incident #1420 for PR #1271 and confirmed recovery made no progress because the generated recovery task allowed responders to post a top-level PR comment with `✅ Addressed` instead of replying in the exact review thread comments. The resolver only auto-resolves when the latest comment in that exact thread is a trusted marker naming the current head, so attempts churned and then exhausted.

## Files touched

- `.github/scripts/ci-recovery/reconcile.mjs`
- `.github/scripts/ci-recovery/reconcile.test.mjs`
- `docs/knowledge/review-ledgers/2026-07-18-ci-recovery-pr1271-thread-guidance.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-18-ci-recovery-pr1271-thread-guidance.md`

## What changed

- Hardened the recovery task instructions in `reconcile.mjs` to explicitly state that top-level PR comments are never sufficient for `review-thread` blockers and that markers must be posted on the exact thread comment.
- Extended the existing task-body regression test to assert the new explicit guidance is present in live reconcile task comments.
- Kept the fix minimal and fail-closed; no marker parser, trust policy, or mutation ordering logic was relaxed.

## Observe before done

- Before: recovery comments on PR #1271 included thread URLs and reply target IDs, but responders still posted top-level comments. No listed review threads received a final trusted marker reply, so `shouldResolveThread(...)` never resolved them and stale automation eventually released ownership after attempt exhaustion.
- After: task comments now explicitly reject top-level marker placement for review-thread blockers, reducing deterministic mis-execution of the required thread-resolution path.

## Verification run

- `node --test --test-name-pattern "live reconcile task comment includes explicit review-thread reply comment IDs" .github/scripts/ci-recovery/reconcile.test.mjs`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- init --apples 2 --slug ci-recovery-pr1271-thread-guidance --title "Clarify CI recovery in-thread addressed marker protocol"`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-ci-recovery-pr1271-thread-guidance.review-ledger.json`

## Unresolved issues

- Could not post the requested pre-coding plan comment to issue #1420 from this session environment because both `gh issue comment` and REST issue-comment POST returned `403 Forbidden`.

## Recommended next steps

1. Re-run CI recovery on PR #1271 with the updated task prompt so the assigned fixer replies with `✅ Addressed in <sha>` in each exact review thread.
2. If thread blockers persist after this prompt hardening, add a deterministic CI-recovery check that treats top-level marker comments as explicit non-progress evidence in incident output.
