# Handoff: PR #1598 merge-conflict recovery

## Date

2026-07-18

## Persona

Producer

## Systems touched

ci-recovery

## Apples

Estimated 2🍎, actual 2🍎. Verdict: exact.

## Summary

Merged `origin/main` into `copilot/fix-ci-recovery-loop-1516` and resolved the only semantic overlap in the CI recovery reconciler.

- Preserved this branch's `(outdated)` review-thread annotation and current-head validation guidance.
- Preserved `main`'s stale-marker lineage handling so unreachable `✅ Addressed in <sha>` markers still produce a targeted blocker hint.
- Kept the merge scoped to `.github/scripts/ci-recovery/reconcile.mjs` plus the already-auto-merged regression coverage in `.github/scripts/ci-recovery/reconcile.test.mjs`.

## Validation

- `node --test --test-name-pattern "live reconcile annotates outdated review threads in task body|stale-marker thread includes recovery hint in blocker summary|transient compare failure does not produce a stale-marker hint" .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Notes

- `gh workflow run ci-recovery.yml ... operation=lease-acquire` returned `403 Forbidden` in this session, so the local merge repair proceeded without updating the GitHub lease comment.
