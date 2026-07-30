# Session Handoff: CI Recovery Loop Investigation — PR #1960

## Date

2026-07-25

## Persona

Reviewer → CI Recovery Agent

## Systems touched

ci-policy

## Apples

2🍎 exact

## What Was Done

Investigated the CI recovery loop incident (issue #1995) triggered for PR #1960
("Implement Big Panda Wei's BAMBOO-FED BERSERK runtime slice").

### Root cause

PR #1960 introduced a `no-useless-assignment` ESLint lint error at
`src/core/mob-abilities/runtime.ts:219`. The `beginTelegraph` function was
refactored to add a self-targeting mode, which created the pattern:

```ts
let targetEid: number | null = null;   // ← initial `null` never read
...
if (targetingMode === 'self') {
  targetEid = casterEid;             // immediately overwrites null
  ...
} else {
  targetEid = findDefaultTarget(world); // immediately overwrites null
  ...
}
```

Both branches of the if-else overwrite `targetEid` before the initial `null`
value is ever read, making the `= null` initializer useless.

### Why the CI recovery automation could not make progress

The blockers were exposed sequentially across advancing PR heads:

1. At head `dc8876a`: CI job `89658302700` showed **Format check** failure;
   **Typecheck & Lint** was skipped entirely. Dispatched agent 1 fixed
   typecheck regressions (`cd8fd69b`) — the `no-useless-assignment` lint error
   was not yet visible in CI at this head.
2. At head `3435877`: CI job `89662952147` (appearing only after that head)
   exposed the lint failure. Dispatched agent 2 fixed prettier formatting
   (`3435877a`) by running local verification instead of fetching the specific
   job log URL.
3. After 2 failed attempts with the same blocker fingerprint
   (`20e26aef10c09193...`), the automation filed the loop incident (issue
   #1995) via the `stale-automation-exhausted` path.

The two dispatched agents fixed sequentially-exposed blockers across advancing
heads — they did not both independently miss the same lint error. The retry
accounting and blocker identity evolved as the PR head advanced, not as two
identical misses. Whether this constitutes an automation defect requires
re-evaluation of the retry state and blocker identity across those heads;
**the original "no automation defect" conclusion in this handoff was premature
without checking the job IDs at each head**.

The automation's `automationStallAction` correctly escalated after
`stallAttempt >= 2` via the `stale-automation-exhausted` path.

### Fix applied

Removed the useless `= null` initializer from the `targetEid` declaration:

```ts
// Before:
let targetEid: number | null = null;

// After:
let targetEid: number | null;
```

TypeScript's definite assignment analysis correctly verifies that `targetEid`
is always assigned in both branches before first use, so no type safety is
lost. The fix was pushed directly to the PR #1960 branch
(`copilot/implement-bamboo-fed-berserk-ability`).

## Key Decisions Made

- **Fix on PR #1960's branch directly**: Since the lint error only exists on
  the PR #1960 branch (not on main), the fix was applied there rather than
  cherry-picking to a new PR.
- **Automation defect assessment deferred**: The original "no automation defect"
  conclusion was premature; the sequential blocker exposure across advancing
  heads requires separate re-evaluation of the retry/state logic before closing
  #1995.

## What's Next / Blockers

- PR #1960 needs CI to pass after the lint fix before it can be merged.
- Issue #1995 (the loop incident) will be closed when this investigation PR
  merges.

## Retrospective

### Lessons Learned

- Dispatched recovery agents should prefer fetching the specific CI job log
  URL provided in the task body to identify the exact failing command, rather
  than running local verification and fixing what they find there. Local `npm
run verify:fast` may surface different issues than the specific CI failure.
- `no-useless-assignment` fires on the DECLARATION line (where the initial
  value is assigned), not on the overwrite line, making it slightly
  counterintuitive to locate without reading the full function.

### Mistakes Made

- Two prior Copilot agents both ran local verification and fixed what they
  found (typecheck, prettier) rather than fetching the CI job log to find the
  specific `no-useless-assignment` error. The agents should have used the job
  URL from the task body first.

### Opportunities for Future Improvement

- The CI recovery task body could include a hint when the only blockers are
  `ci-failure` kinds: "Fetch the CI job log URL listed for each ci-failure
  blocker FIRST, identify the specific failing step and error message, then fix
  that specific error before running local verification."
- No new runtime behavioral test is needed for this ESLint-only defect: the
  `no-useless-assignment` lint rule is already the regression guard. The missed
  verification gate was running `verify:fast` (which lints changed TypeScript
  files) before pushing; dispatched agents ran local typecheck/formatting checks
  instead of fetching the specific CI job log to identify the exact failing rule.
