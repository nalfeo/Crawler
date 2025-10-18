# Handoff: CI recovery thread reply target hints

## Date

2026-07-18

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 2 apples, actual 2 apples.

## What changed

- Added deterministic extraction of review comment IDs from review-thread URLs (`#discussion_r<id>`) in `.github/scripts/ci-recovery/reconcile.mjs`.
- Hardened CI recovery task-body generation so each `review-thread` blocker now includes an explicit `Reply target comment ID` hint for `reply_to_comment`.
- Added subprocess regression coverage in `.github/scripts/ci-recovery/reconcile.test.mjs` proving live reconcile task comments include the expected reply target ID for unresolved review-thread blockers.

## Observe before done

- Before: task comments listed review-thread URLs but not an explicit comment ID target, so repair sessions could miss replying in-thread and leave blockers unresolved.
- After: live task comments include a machine-usable review comment ID hint aligned to the exact thread URL, improving deterministic thread-reply routing.
- Verified via the reconciler subprocess test that inspects the posted task comment payload.

## Verification run

- `node --test --test-name-pattern "live reconcile task comment includes explicit review-thread reply comment IDs" .github/scripts/ci-recovery/reconcile.test.mjs`
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-ci-recovery-thread-reply-target.review-ledger.json`
- `npm run verify:pr-prereqs`

## Unresolved issues

- Could not post the requested pre-coding plan comment to issue #1297 from this session environment because GitHub write auth for issue comments returned `403 Forbidden`.
