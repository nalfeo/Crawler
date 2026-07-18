# Handoff: CI Recovery — `isOutdated` annotation re-land (issue #1624)

**Date:** 2026-07-18  
**Session slug:** ci-recovery-isoutdated-reland  
**Branch:** `copilot/fix-ci-recovery-loop-1624`  
**Related issue:** #1624 _(late issue-plan comment required a timing waiver; do not auto-close without maintainer sign-off)_  
**Apple estimate:** 2🍎

## Systems touched

ci-recovery

## Problem

The automated CI recovery pipeline filed a loop incident (issue #1624) after PR #1603 exhausted its 2-attempt retry budget without progress. The blocker was an unresolved review thread (`PRRT_kwDOSvo2Ms6R-rQq`) about a process compliance miss: the session that created PR #1603 skipped the required pre-code plan comment on the originating issue (#1595).

Recovery validator agents correctly identified that the thread had no retroactive code fix and required maintainer direction. Since no agent could post `✅ Addressed in <sha>`, the blocker fingerprint stayed constant across 2 consecutive runs (no new thread comments were added), and the stall counter hit the exhaustion threshold → loop incident filed.

## Root Cause

**No defect in the marker parser, permission grant, or thread-resolution path.** The CI recovery loop worked correctly: the loop incident is the designed escalation mechanism for threads that genuinely need human direction.

The underlying CI recovery code defect (fixed by this PR) was pre-existing: `reconcile.mjs` did not annotate `isOutdated` status for review-thread blockers in the recovery task body. PR #1603 contained the correct fix but was blocked by the process compliance finding (no plan comment on #1595).

## Fix (re-land of PR #1603 code changes)

Three surgical changes:

### 1. `state.mjs` — `normalizeBlockers` includes `isOutdated`

```diff
   ...(Number.isFinite(blocker.line) ? { line: blocker.line } : {}),
+  ...(blocker.isOutdated === true ? { isOutdated: true } : {}),
```

When a review thread transitions from `isOutdated: false → true`, the normalized blocker changes, the fingerprint changes, and the automation correctly detects "progress" — resetting the retry budget. Without this, the transition was invisible for file-level threads (no `line` field) and the budget would not reset.

### 2. `reconcile.mjs` — blocker push adds `isOutdated`

```diff
   summary,
+  isOutdated: thread.isOutdated === true,
   url: root?.url,
```

### 3. `reconcile.mjs` — task body annotates outdated threads

```diff
-  `${index + 1}. **${blocker.kind}** \`${blocker.id}\`${...path...}`
+  `${index + 1}. **${blocker.kind}** \`${blocker.id}\`${...path...}${blocker.isOutdated ? ' **(outdated — deterministic non-applicability candidate)**' : ''}`
```

Recovery agents now see explicit `**(outdated — deterministic non-applicability candidate)**` annotations for threads whose source lines have been modified/removed. The annotation is a triage hint only: a separate validator must still confirm deterministic non-applicability before the thread can be resolved.

## Regression Tests

**`state.test.mjs`** — new test `'normalizeBlockers preserves isOutdated flag and it is included in the fingerprint'`:

- Verifies `isOutdated: true` survives normalisation
- Verifies `isOutdated: false / absent` does NOT set the field
- Verifies fingerprints differ between outdated and fresh blockers (retry budget resets on transition)

**`reconcile.test.mjs`** — updated test `'live reconcile task comment annotates outdated threads and includes review-thread reply comment IDs'`:

- Tests with two threads: one outdated, one fresh
- Asserts outdated thread renders `**(outdated — deterministic non-applicability candidate)**` annotation
- Asserts fresh thread does NOT render the annotation
- Both threads still carry explicit reply target IDs

## Verification

- `node --test .github/scripts/ci-recovery/state.test.mjs` — 32/32 pass (up from 31)
- `node --test .github/scripts/ci-recovery/reconcile.test.mjs` — 86/86 pass (up from 85)
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-ci-recovery-isoutdated-reland.review-ledger.json` — valid 2🍎 ledger
- `npm run verify:pr-prereqs` — passes (`pr-review-ledger: ✅ valid review ledger`)
- `npm run verify:fast` — passes (1294 tests, 89 test files)
