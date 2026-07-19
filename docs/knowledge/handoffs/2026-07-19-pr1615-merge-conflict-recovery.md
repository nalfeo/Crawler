# Handoff: PR #1615 merge-conflict recovery

## Date

2026-07-19

## Persona

DevOps Engineer

## Systems touched

ci-policy, docs-tooling

## Apples

Estimated 2 apples, actual 2 apples.

## What changed

- Merged `origin/main` into `copilot/fix-ci-recovery-loop-1503`.
- Kept `main`'s newer epic-status fixture/test updates for Floor 2 equipment, including the newer immutable evidence snapshot.
- Preserved the branch's still-relevant ci-recovery regression coverage by re-adding the outdated-thread fingerprint test in a form that matches current `main` behavior (`isOutdated` thread with no reply target stays a blocker but must not perturb the fingerprint when `line` flips between `10` and `null`).
- Fixed a newly failing `main` regression test so stale-marker blocker coverage matches the newer auto-marker flow: stale outdated threads with **no** reply target still emit the recovery hint, but replyable outdated threads are auto-marked and resolved instead of dispatched.

## Observe before done

- Before: merging `origin/main` produced conflicts in `reconcile.test.mjs`, `epic-state.json`, `epic-status.test.ts`, and the outdated-thread handoff file, and the inherited stale-marker regression expected an unresolved blocker even though current `main` auto-posts trusted markers for replyable outdated threads.
- After: the merge keeps `main`'s newer fixture/doc state, retains fingerprint coverage for unresolved outdated blockers, and the ci-recovery targeted suite plus repo verification pass on the merged branch.

## Verification run

- `node --test .github/scripts/ci-recovery/reconcile.test.mjs`
- `npm run test:unit -- tests/unit/agent/epic-status.test.ts`
- `npm run epic:status -- floor-2-equipment`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- `parallel_validation`

## Notes

- `files/guard-telemetry.jsonl` was not present, so no telemetry capture was required.
