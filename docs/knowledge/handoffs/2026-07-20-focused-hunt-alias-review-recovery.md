# Handoff — focused-hunt alias review recovery

**Date:** 2026-07-20  
**Branch:** `nalfeo-fix-bat-ranged-dodging`  
**Estimate:** 2 apples 🍎🍎  
**Actual:** 2 apples (exact)

## Systems touched

ai-behavior-tree

## Summary

Recovered PR #1231 from the focused-hunt review blocker by deleting the dead
`planFocusedMeleeEngagement` alias path and routing focused hunt coverage through
the real `poll()` progress-target path instead of calling a private wrapper.

## Change

- Removed `ProgressTarget.engagementStyle` and the no-op focused/standard branch
  in `buildProgressBehavior()`.
- Deleted the private `planFocusedMeleeEngagement()` alias.
- Reworked the two focused-hunt regression tests to stub
  `findProgressObjective(...)`, run `poll()`, and assert on the resulting ENGAGE
  decision/reason. This keeps the tests on the same production route that Floor
  2 hunt objectives use.

## Validation

- Separate-model review-thread validation (`claude-sonnet-4.6`) confirmed the
  comment was still applicable and recommended collapsing the alias path.
- `npx vitest run tests/game/behavior-tree-ai.test.ts`
- `npm run verify:fast`

## CI notes

- `origin/main` was fetched/unshallowed first so local verification could find a
  merge base.
- GitHub Actions inspection showed the latest `CI Recovery Router`
  `action_required` run for this branch had zero jobs, so there was no code-side
  CI failure to repair before pushing the consolidated fix.
