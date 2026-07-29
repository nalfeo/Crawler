# CI Recovery Loop — PR #1939 Fix

**Date:** 2026-07-28  
**Session slug:** ci-recovery-loop-1939  
**Closes:** #2243  
**Supersedes:** #1939 (`copilot/pin-dependency-versions`)

## Systems touched

security, ci-recovery

## Summary

Investigated CI recovery loop issue #2243 for PR #1939. Identified root cause and
implemented the two code fixes that the automated CI recovery could not apply because
the Copilot CCA kept failing at session startup (`claude-sonnet-4.5` model deprecated).

## Root cause

The CI recovery automation for PR #1939 correctly identified two unresolved review
threads and dispatched the CCA twice to fix them. Both attempts failed at `session.create`
with: `Model "claude-sonnet-4.5" is not available — resolved model was "claude-sonnet-4.5"`.
After two failed attempts the automation correctly created this loop-incident (#2243).

There is **no defect** in the marker parser, thread-resolution path, permission grant, or
mutation sequence in `.github/scripts/ci-recovery/`. The automation behaved correctly.

The root cause is an external GitHub Copilot settings issue (model deprecation), not
fixable from repository code.

## Fixes applied

### 1. `isExempt()` version binding (`scripts/agent/security/check-exact-deps.mjs`)

**Problem (review thread 1):** `isExempt()` keyed on `field+name` only. A workspace alias
entry (`workspace:*`) would silently exempt a future `^1.2.3` range on the same package,
defeating the exact-dependency check.

**Fix:** Added `version` parameter to `isExempt(field, name, version)` and all callers
(`findRangeViolations`, `checkOverrides`). An exemption entry must now list a `version`
field and the value must match exactly.

### 2. `repoRoot()` cross-platform path (`scripts/agent/security/check-exact-deps.mjs`)

**Problem (review thread 2):** `URL.pathname` used directly as a filesystem path.
On Windows, paths with spaces produce percent-encoded segments (e.g. `%20`), breaking
`fs.readFileSync` calls.

**Fix:** Replaced `URL.pathname` with `fileURLToPath(import.meta.url)` from the Node.js
`url` module, then `path.dirname` / `path.resolve` to walk to repo root.

## Tests added

`scripts/agent/security/check-exact-deps.test.mjs` — 4 new regression tests:
1. Exact version+field+name match suppresses violation ✅
2. Version mismatch does NOT suppress violation ✅
3. Nested override path must be included in field key ✅
4. Nested override path mismatch does NOT suppress violation ✅

Total tests: 25 (all pass).

## PR structure

This session's PR (`copilot/fix-ci-recovery-loop-1939`) merges PR #1939's branch
(`copilot/pin-dependency-versions`) onto `main` with the additional fixes applied.
It supersedes PR #1939 and should be merged in its place.

Review threads on PR #1939 (`PRRT_kwDOSvo2Ms6Tt_4M`, `PRRT_kwDOSvo2Ms6Tt_4P`) have
been replied to with `✅ Addressed in 49db8298` markers.

## Verification

- `npm run verify:fast` passed (typecheck + lint + changed tests)
- All 25 `check-exact-deps` tests pass
- `parallel_validation` showed no CodeQL findings; code review tool unavailable (same deprecated model issue)
