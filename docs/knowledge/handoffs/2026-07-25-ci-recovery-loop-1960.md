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

The automation itself worked correctly throughout:
1. Dispatched Copilot agent 1: fixed typecheck regressions (`cd8fd69b`) —
   missed the lint error
2. Dispatched Copilot agent 2: fixed prettier formatting (`3435877a`) —
   missed the lint error
3. After 2 failed attempts with the same blocker fingerprint
   (`20e26aef10c09193...`), filed the loop incident (issue #1995)

The dispatched agents accessed the CI failure URL for the `Lightweight Checks`
job but fixed adjacent issues (typecheck and prettier) instead of the primary
lint failure. The task body correctly listed the job URL
(`89662952147`) where the specific error was visible.

**No defect was found in the marker parser, permission grant,
thread-resolution path, or mutation sequence.** The automation's
`automationStallAction` correctly escalated after `stallAttempt >= 2` via the
`stale-automation-exhausted` path.

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
- **No automation defect**: The CI recovery automation behaved correctly and no
  changes to `reconcile.mjs` or `state.mjs` were needed.

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
- A regression test for `beginTelegraph` covering the self-targeting mode could
  have caught this at development time by running `npm run lint` as part of PR
  verification.
