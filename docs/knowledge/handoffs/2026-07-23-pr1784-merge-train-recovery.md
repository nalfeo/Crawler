# Handoff: PR #1784 merge-train recovery

## Date

2026-07-23

## Persona

DevOps Engineer

## Systems touched

ci-policy, sprite-workflow

## Apples

3🍎 estimated, 2🍎 actual. The diff was downward-rescored to 2🍎 in the review ledger once the recovery collapsed to a single test-only flake fix, so no apple JSON file was required.

## What Was Done

- Investigated the live blocker from PR #1784's CI-recovery task comment and followed the required order: merge state inspection, review-thread inspection, CI failure diagnosis, then repair.
- Confirmed there were no still-open Copilot review threads on the PR; the live blocker was merge-train validation run `29986271817`.
- Used GitHub Actions logs to isolate the exact failing job: `Candidate sprite tests (4/4)`, which failed only at `tests/unit/sprites/caching-run-store.test.ts` in `an authoritative list() blocks on inner.list even when a fresh snapshot exists`.
- Made the smallest repair in that test file:
  - added a deterministic `firstListStarted` signal to the test-only `GatedListStore` helper;
  - replaced the scheduler-sensitive `waitUntil(() => gated.lists >= 1)` polling in the authoritative-list test with `await gated.firstListStarted`;
  - kept the load-bearing assertions that the authoritative call stays unresolved before the gate opens and returns the fresh `[SHEET, RAW]` listing after release;
  - released the gate in a `finally` block so a failing assertion does not strand the in-flight test promise.
- Recorded the required 3🍎 review ledger in `docs/knowledge/review-ledgers/2026-07-23-pr1784-merge-train-recovery.review-ledger.json`.

## Validation

- GitHub Actions diagnosis:
  - `Merge Train Validation` workflow run `29986271817`
  - failed job: `Candidate sprite tests (4/4)`
  - failing assertion: `tests/unit/sprites/caching-run-store.test.ts:844`
- Separate-model plan review (`gpt-5.4`) completed and recorded.
- Separate-model code review (`claude-sonnet-4.6`) completed clean and recorded.
- Local verification attempts were environment-limited in this sandbox:
  - `bash scripts/agent/verify-fast.sh` failed because the worktree's dependency install is incomplete (`vitest`, local TypeScript, and ESLint package resolution unavailable), so the script fell back to transient `npx` tools and then failed resolving repo dependencies.
  - targeted Vitest execution was also unavailable because `node_modules/.bin/vitest` is missing and `npm install` could not repair the install due blocked package-host DNS.

## Next / Follow-up

- Push the repair commit so PR #1784 gets a fresh branch head and new merge-train / PR validation.
- After push, run:
  - secret scan on changed files,
  - review-ledger validation,
  - `npm run verify:pr-prereqs` (best effort in this sandbox; expect the same dependency limitation unless the install is repaired),
  - `parallel_validation`,
  - then let GitHub re-run the authoritative CI and merge-train validation.
