# Already-landed PR detector

**Date:** 2026-07-28
**Session slug:** already-landed-detector
**Closes:** #2227
**Apple estimate:** 2🍎 (tooling-only, capped at 3🍎 per AGENTS.md)

## Summary

Added a deterministic "content already on main" detector to the CI recovery sweep.  
Open PRs whose entire diff is byte-identical to `main` are automatically labeled  
`ci-already-landed` and closed.  Partial matches and regression candidates are  
flagged with a comment and label but left open for human triage.

## Problem

Four open sprite PRs (#2057, #1975, #2112, #2124) sat `DIRTY` for days because  
their art had already landed via other routes.  They could never self-resolve  
because every art check-in touches shared registries (`manifest.json`,  
`sprite-catalog.json`), creating permanent conflicts.  This detector removes  
content-free zombie PRs automatically.

## Approach

**Key insight:** Git blobs are content-addressed.  The GitHub REST API exposes each  
file's blob SHA in both `pulls.listFiles` (PR HEAD) and `repos.getContent` (any ref).  
Equal SHAs ↔ byte-identical content — no git worktrees, no cloning required.

**Algorithm (pure module `already-landed.mjs`):**
1. For each file in the PR (`pulls.listFiles`), fetch its blob SHA at PR HEAD.
2. Fetch the same path's blob SHA at `main` HEAD (`repos.getContent`).
3. Classify each file with `classifyFile()` → `FILE_STATUS` enum.
4. Aggregate file statuses into a `VERDICT` via `analyzeFiles()`.

**Verdict priority (conservatism invariant — never auto-close when uncertain):**
- `REGRESSION_CANDIDATE` — any `DIFFERS` file: flag for human, never close.
- `ALL_LANDED` — all files `LANDED` or `DELETION_LANDED`: comment + label + close.
- `PARTIAL` — some landed, none differ: comment + label, leave open.
- `NOT_LANDED` — nothing landed: no action.

## Systems touched

ci-recovery, ci-automation

## Files changed

| File | Change |
| ---- | ------ |
| `.github/scripts/ci-recovery/already-landed.mjs` | **New** — pure analysis module |
| `.github/scripts/ci-recovery/already-landed.test.mjs` | **New** — 36 tests |
| `.github/scripts/ci-recovery/markers.mjs` | Added `ALREADY_LANDED_COMMENT_MARKER`, updated `MANAGED_COMMENT_MARKERS` |
| `.github/workflows/ci-pr-disposition.yml` | Added "Detect content-identical (already-landed) PRs" step |

## Tests

36 new tests in `already-landed.test.mjs`:
- All five `FILE_STATUS` values (including edge cases: null prFile, null mainBlobSha).
- All four `VERDICT` values with conservatism invariant checks.
- Golden fixtures for all four issue PRs (#2057 → ALL_LANDED, #1975 → REGRESSION_CANDIDATE, #2112 → ALL_LANDED, #2124 → PARTIAL).
- `renderAlreadyLandedComment()` output checks for all verdict branches.

Pre-existing failure: `router.test.mjs` fails due to missing `yaml` npm package in  
the local environment — unrelated to this work.  504 of 505 ci-recovery tests pass.

## Design decisions

1. **Pure module pattern** — follows `duplicate-detect.mjs` convention; all async  
   code stays in the workflow script, keeping the analysis module trivially testable.
2. **Blob SHA comparison** — single REST API call per file, no worktrees.
3. **Scope filter** — draft PRs and PRs already labeled `ci-already-landed`,  
   `ci-lifecycle-quarantined`, or `ci-lifecycle-abandoned` are skipped (idempotent).
4. **Re-validate before close** — re-fetch PR head SHA before closing to guard  
   against TOCTOU (PR updated between scan and close).
5. **Comment idempotency** — upsert via `ALREADY_LANDED_COMMENT_MARKER`.
6. **No partial auto-close** — aligns with issue spec: only `ALL_LANDED` gets closed.

## Handoff notes

- The `ci-already-landed` label is created by the step if absent (color `bfd4f2`).
- The label name `ci-already-landed` and comment marker `<!-- crawler-ci-already-landed:v1 -->` are stable identifiers.
- If a PR is re-opened after being auto-closed, the label removal is not automatic — that would require a separate `reopened` event hook.
- The regression-candidate branch explicitly does NOT close and is flagged with  
  different comment text and emoji (⚠️ vs ✅/🔵).
