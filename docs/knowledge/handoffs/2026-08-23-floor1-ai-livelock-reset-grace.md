# Session Handoff: Floor 1 NPC-approach threat reset grace

## Date

2026-08-23

## Persona

QA Engineer

## Systems touched

ai-behavior-tree

## Apples

2🍎 estimated / 2🍎 actual

## What Was Done

Recovered PR #3357 after CI/review feedback on the Floor 1 AI livelock fix.
The original bug was a `BehaviorTreeAI` NPC-approach threat-clear livelock: when
wounded ranged runs orbited near the 8 ft NPC-threat gate, a one-frame
out-of-radius flicker reset the no-progress escape valve before it could latch,
so the AI alternated between clearing local threats and approaching the
shopkeeper without net progress.

The repair keeps the bypass/progress tracking alive across brief empty-threat
flicker, but adds `NPC_APPROACH_THREAT_RESET_GRACE_FRAMES` so stale bypass state
is cleared once the nearby-threat gate stays empty for more than the grace
window. Regression coverage now checks both sides of the contract:

- empty gate past grace resets tracking and re-enters `ENGAGE` when a threat
  returns;
- one-frame radius flicker preserves the latched NPC-approach bypass and remains
  in `EXPLORE` toward the NPC.

## Validation

- `bash scripts/agent/preflight.sh` — passed.
- Different-model review-thread validation — finding validated as already
  addressed on current HEAD; the prior reviewer conflated the new one-frame
  flicker test with the past-grace reset test.
- CI log inspection for run `32618268470` — the named Unit Tests failure was the
  stale no-grace test expectation at the old head; the named Headless Floor 1
  failures were `floor1-economy-gate` median unspent and `sword seed 44` boss
  readiness at the old head.
- `npm test -- tests/game/behavior-tree-ai.test.ts` — 139/139 passed.
- `npm run test:headless -- tests/headless/floor1-economy-gate.test.ts tests/headless/floor1-legacy-death-regressions.test.ts` — 18/18 passed.
- `npm run ai:headless -- --seed 38 --weapon pistol --floor floor1 --max-frames 39600` — VICTORY at 540.9s / 32451 frames.
- `npm run verify:fast` — passed (144 files / 2368 tests plus checks).
- Secret scan on changed files — no secrets detected.

## What's Next / Blockers

- No known local blockers remain for the review thread or the two named CI
  failures. The branch was rebased onto current `origin/main`; publish the
  rebased head and reply to the review thread with the final pushed SHA.
- The broader release-sweep follow-up from the PR description remains a separate
  measurement task if desired; do not treat seed-specific fixes as a substitute
  for rate-based evidence.

## Retrospective

### Lessons Learned

- For radius-gated AI state, reset semantics need an explicit absence grace: a
  single empty perception frame can be normal orbit jitter, but sustained absence
  should clear stale bypass latches.
- When reviewing CI recovery comments, compare the named failure SHA against the
  current branch head before editing; this PR already had a later repair commit
  with the requested tests.

### Mistakes Made

- The first local targeted unit-test command used Jest's `--runInBand` flag;
  Vitest rejected it before running tests. Rerunning with `npm test -- <file>`
  passed.
