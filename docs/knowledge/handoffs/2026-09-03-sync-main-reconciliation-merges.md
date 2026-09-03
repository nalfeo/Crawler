# sync-main reconciliation merge preservation

## Date

2026-09-03

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated, 3🍎 actual (exact).

## Summary

Updated `scripts/agent/sync-main.mjs` so ordinary clean authoring branches still use the existing rebase strategy, while shepherd/recovery branches that already contain mainline reconciliation merges use a merge-preserving `origin/main` update. The command now reports the selected strategy and deterministic reason, and the local sync evidence records the strategy fields for later inspection.

## Files touched

- `scripts/agent/sync-main.mjs` — added deterministic strategy selection, mainline reconciliation-merge detection, merge-preserving update/abort handling, and strategy reporting.
- `scripts/agent/sync-main.test.mjs` — added branch-history tests for repeated main advancement, preservation of prior semantic conflict resolutions, and unchanged ordinary-branch rebase behavior.
- `docs/knowledge/adr/0075-ci-conflict-scope-and-authoring-main-sync.md` — updated the existing sync-main decision to document the merge-preserving shepherd/recovery exception.
- `docs/knowledge/metrics/apples/2026-09-03-sync-main-reconciliation-merges.json` — recorded 3🍎 estimate/actual calibration.

## Verification run

- `bash scripts/agent/preflight.sh` — passed; branch already contained `origin/main`, dependencies installed, typecheck passed.
- `node --test scripts/agent/sync-main.test.mjs` — passed, 5/5.
- `npx prettier --check scripts/agent/sync-main.mjs scripts/agent/sync-main.test.mjs docs/knowledge/adr/0075-ci-conflict-scope-and-authoring-main-sync.md` — initially found formatting in `sync-main.mjs`; fixed with the existing formatter.
- `npx prettier --write scripts/agent/sync-main.mjs scripts/agent/sync-main.test.mjs docs/knowledge/adr/0075-ci-conflict-scope-and-authoring-main-sync.md` — applied formatting.
- `node --test scripts/agent/sync-main.test.mjs` — passed, 5/5 after formatting.
- `npm run sync:main -- --reason pre-publish` — passed; no branch change; reported `strategy: rebase` with ordinary-branch reason.
- `bash scripts/agent/verify-fast.sh` — passed; changed-test phase reported 812 files / 11,483 tests passed, followed by data-contract/integrity/coverage checks.
- `npm run verify:pr-prereqs` — first run failed only because this required handoff was not present; rerun after handoff is pending.
- Secret scan of changed files — passed before committing code changes.

## Unresolved issues

None known.

## Recommended next steps

Let CI rerun the normal gates on the pushed branch. For future shepherd/recovery branches, `sync-main` should now preserve deliberate prior reconciliation merges automatically once the branch already contains a mainline reconciliation merge.
