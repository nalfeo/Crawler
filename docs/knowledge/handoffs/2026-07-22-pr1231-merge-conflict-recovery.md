# Handoff: PR #1231 merge-conflict recovery

## Date

2026-07-22

## Persona

Producer

## Systems touched

ci-policy, docs-tooling

## Apples

Estimated 2🍎, actual 2🍎.

## What changed

- Fetched the latest `origin/main` and merged it into `nalfeo-fix-bat-ranged-dodging` as merge commit `2b863cbb`.
- Resolved the only merge conflict in the generated `docs/knowledge/handoffs/INDEX.md` by regenerating the index from the merged tree with `npm run docs:index`.
- Fixed `scripts/agent/epics/epic-status-lib.ts` to use a minimal Ajv compatibility surface when validating the committed epic-status schema, avoiding transitive-version typing/runtime drift during `verify:fast`.
- Added this session's required 2🍎 tier-only review ledger at `docs/knowledge/review-ledgers/2026-07-22-pr1231-merge-conflict-recovery.review-ledger.json`.

## Observe before done

- Before: GitHub reported PR #1231 as `mergeable_state=dirty`, and a local merge of `origin/main` reproduced a content conflict in `docs/knowledge/handoffs/INDEX.md`.
- After: the branch contains a clean two-parent merge commit on top of current `origin/main`, the handoff index regenerates without conflict markers, and the merged branch is ready for final validation.
- Real artifact: repository merge state plus the generated handoff index (`docs/knowledge/handoffs/INDEX.md`).

## Verification

- `npm run docs:index`
- `github actions list_workflow_runs` for branch `nalfeo-fix-bat-ranged-dodging`
- `github get_job_logs` on `CI Recovery Router` run `29714509084` (`failed_jobs=0`, `total_jobs=0`)
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-22-pr1231-merge-conflict-recovery.review-ledger.json`
- `npm run verify:pr-prereqs`

## Notes

- There were no unresolved PR review threads at the time of recovery, so the required blocker order reduced to merge-conflict resolution → CI inspection → validation.
