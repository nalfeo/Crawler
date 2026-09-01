# 2026-09-01 coverage release CI recovery

## Summary

Recovered PR #4037 from review and CI blockers after moving PR-time coverage reporting to release deploy.

## Systems touched

ci-policy

## What changed

- Updated `tests/unit/ci-workflow-overhead.test.ts` so the overhead regression now asserts the removed `ci-coverage` PR job stays absent and deploy owns release-time unit coverage reporting.
- Changed `scripts/agent/ci/format-release-coverage-comment.mjs` to write malformed-summary diagnostics to stderr, keeping stdout limited to the PR comment fragment captured by `COVERAGE_LINE=$(...)`.
- Added `tests/unit/format-release-coverage-comment.test.ts` covering valid, missing, and malformed coverage summaries with stdout/stderr separation.
- Removed the stale `advisory coverage` entry from CI recovery's advisory check-name allowlist because the job-level Advisory coverage job no longer exists.

## Verification

- `npx vitest run --project unit tests/unit/ci-workflow-overhead.test.ts tests/unit/deploy-workflow-gating.test.ts tests/unit/format-release-coverage-comment.test.ts --reporter=dot`
- `npx eslint tests/unit/ci-workflow-overhead.test.ts tests/unit/deploy-workflow-gating.test.ts tests/unit/format-release-coverage-comment.test.ts scripts/agent/ci/format-release-coverage-comment.mjs .github/scripts/ci-recovery/reconcile.mjs .github/scripts/ci-recovery/reconcile.test.mjs --max-warnings 0`
- `npm run test:guards`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- Code review: first pass found a missing-file path portability issue, fixed; second pass had no actionable finding after source/test verification.
- CodeQL checker: JavaScript reported 0 alerts; analysis noted the database was too large and skipped.

## Notes

- Preflight and pre-publish `sync:main` both attempted sync but aborted cleanly because commit signing failed during rebase with a remote signing `Bad Request`; branch state remained intact.
- `verify:fast` skipped the local silent merge-revert guard because history was not resolvable in this shallow clone; CI runs that guard with `fetch-depth: 0`.

## Follow-up: Security checks recovery

- GitHub Actions job `99976268483` failed in `npm run security:audit` on high-severity `browserslist` advisories affecting `<=4.28.6`.
- Added exact npm overrides for `browserslist@4.28.7` and its browser-data dependencies at non-quarantined versions so the repo's proxy quarantine lock-integrity gate passes.
- `runtime-tools-gh-advisory-database` was attempted for `browserslist@4.28.7` but failed because the tool had no GitHub token; validation used the repository's `security:audit`/`security:check` gates.

## Follow-up verification

- `npm run security:audit`
- `npm run security:check`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`
- Code review: clean.
- CodeQL checker: no analyzable code changes for dependency-only repair.
