# Session Handoff: Require Detailed Plan Comment from Issue-Assigned Copilot

## Date

2026-07-13

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

1🍎

## What Was Done

Updated `ISSUE_INTAKE_BODY` in `.github/scripts/ci-recovery/issue-intake-lib.mjs` to include explicit instructions for Copilot to post a detailed plan comment on the issue before writing any code.

The kickoff comment now instructs Copilot to:

1. Post a plan comment on the issue with high-level design, key decisions, and a checklist of steps — **before writing code** — so the maintainer can review the plan.
2. Include the same high-level summary in the PR description when it opens the PR.

## Key Decisions Made

- Updated the constant (`ISSUE_INTAKE_BODY`) rather than anything runtime — the kickoff comment is already the right mechanism to deliver instructions to Copilot at session start.
- Kept the change minimal: only the instruction body changes; no workflow, GraphQL, or test logic is modified.
- Tests still pass because they import `ISSUE_INTAKE_BODY` by reference (the updated string propagates automatically).

## Files Changed

- `.github/scripts/ci-recovery/issue-intake-lib.mjs` — extended `ISSUE_INTAKE_BODY` with plan-comment instructions

## Verification

- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs` → 2 pass, 0 fail

## What's Next / Blockers

None. Auto-merge is armed.
