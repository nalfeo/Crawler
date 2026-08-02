# Handoff: velocity conflict-scan CI recovery

## Date

2026-08-02

## Persona

DevOps Engineer

## Systems touched

ci-policy, docs-tooling

## Apples

Estimated 2🍎, actual 2🍎.

## Summary

- Fixed the `scripts/agent/velocity/conflict-scan.ts` direct-execution helper so it narrows `argvEntry` before calling `pathToFileURL()`, matching the spaced-path behavior without tripping TypeScript.
- Re-formatted the velocity scanner and its unit test so `format:check` passes.
- Restored `docs/knowledge/handoffs/INDEX.md` to the branch baseline so the generated index is no longer carried in the feature PR.
- Added the required 2🍎 review ledger for this code-touching branch.

## Why this change

The failing CI run reduced to a single `Lightweight Checks` failure: Prettier rejected the touched velocity files, and TypeScript rejected `isDirectExecution()` because `Boolean(argvEntry)` did not narrow `string | undefined` before `pathToFileURL()`. The aggregate `ci` and `Merge gate` jobs failed only because they depend on that job.

## Verification

- `npx prettier --write scripts/agent/velocity/conflict-scan.ts tests/unit/velocity/conflict-scan.test.ts` ✅
- `npx vitest run tests/unit/velocity/conflict-scan.test.ts` ✅
- `npm run typecheck -- --pretty false` ✅
- `bash scripts/agent/verify-fast.sh` ✅
- `npm run verify:pr-prereqs` ✅ after adding this handoff, the review ledger, and restoring `docs/knowledge/handoffs/INDEX.md`
- `runtime-tools-secret_scanning` on touched files ✅

## Workflow artifacts / notes

- Investigated failing workflow run `30733569727`.
- Inspected failing jobs `91458034677` (Lightweight Checks), `91458998534` (ci), and `91458988973` (Merge gate).
- Local dependency install required a temporary, uncommitted rewrite of lockfile tarball hosts from the unreachable Visual Studio feed to `registry.npmjs.org` so validation tools could be installed in this sandbox; `package-lock.json` was restored before finalizing the branch.

## Unresolved issues

- None in the repaired velocity scanner path.

## Recommended next steps

1. Push the repaired branch and let CI re-run the normal required checks.
2. If sandbox setup keeps failing in future sessions, consider a documented local-only bootstrap path for lockfiles that carry unreachable mirror URLs.
