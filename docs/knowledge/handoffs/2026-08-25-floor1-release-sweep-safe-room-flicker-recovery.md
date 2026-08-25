# Handoff: Floor 1 release sweep — safe-room doorway-flicker recovery

## Systems touched

ai-behavior-tree

## Persona

Game AI Engineer

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact) — CI recovery on an existing 3🍎 PR: merge-conflict resolution, a targeted logic fix, a poll-sequence regression test, and full review-ledger completion.

## Summary

Recovered PR #3555 (`Recover all Floor 1 release sweep losses`) from four blockers:

1. **Merge conflict** with `main` — `main` had already landed a near-duplicate fix
   for the pre-exit loot-sweep `scanRadius` safety gate in PR #3528. Merged and
   took `origin/main`'s fuller comment for the resolved hunk.
2. **Doorway-flicker branch** (`src/game/ai/bt-ai-provider.ts`, "Set Progress
   State" NPC-approach threat-clear gate) — the enclosing `if` required
   `!ctx.world.playerInSafeRoom`, so the inner "preserve tracking across a
   flicker" branch was unreachable and the outer `else` always reset tracking
   whenever `playerInSafeRoom` flickered true for one frame. Relocated the
   safe-room check inside the guard (removed it from the outer condition, added
   it to the reset/engage branches individually) so a flicker frame now falls
   through without touching `npcApproachThreatNpcEid`/`npcApproachThreatNoProgressFrames`,
   while a genuine "no threat nearby" exit still resets unconditionally.
3. **CI failure** (`Headless Floor 1 Gate` / `ai-stuck-wiggle.test.ts` seed 6 ·
   sword) — resolved by the `main` merge (PR #3528's fix), confirmed by rerun.
4. **Stale review ledger** — completed the `code_review` (4 rounds; the built-in
   `code_review` tool caught a real merge-introduced duplicate seed-5 test case
   round 1, a maintainability nit round 2, and two rounds where it misread the
   fix as a regression before the diff/comments made the design intent
   unambiguous) and `independent_grade` stages (graded `pass`, 5/5 all criteria,
   by `gemini-3.1-pro-preview`, uninvolved in any other stage).

## Verification

- `npm run typecheck`, `npm run lint`: clean.
- `npx vitest run tests/game/behavior-tree-ai.test.ts`: 144/144 passed, including
  the two new regression tests.
- `npx vitest run tests/headless/ai-stuck-wiggle.test.ts`: 8/8 passed (confirms
  the CI failure is resolved by the main merge).
- `npx vitest run tests/headless/floor1-release-sweep-loss-regressions.test.ts`:
  10/10 passed (bow seed 5, sword seed 5, baseball-bat seeds 20/31, plus the
  prior five cases), after removing a duplicate `bow seed 5` entry the merge
  introduced.
- `npx vitest run tests/unit/ai/bt-loot-sweep.test.ts tests/integration/floor2-collapse-panic-exit.test.ts`:
  17/17 passed.
- `npm run review:ledger -- validate`: valid 3-apple ledger.
- `npm run review:grade -- record ...`: pass, 5/5 all criteria, 0 findings.

## Key decisions

- Did not re-litigate PR #3528's already-merged loot-sweep fix; took `main`'s
  version verbatim during the merge and scoped this session strictly to the
  doorway-flicker fix and CI/ledger recovery.
- Preservation only applies when a threat is genuinely still in range on the
  flicker frame (`nearestEnemy && nearestEnemy.distance <= npcThreatRadius`); the
  "no threat nearby" branch keeps resetting unconditionally, matching the
  pre-existing "resets NPC threat-clear progress when the nearby-threat gate
  exits" test.
- Added a parity test (`keeps a healthy projectile user travelling toward an NPC
while in a safe room, without engaging`) proving the decision output (state,
  target) is unchanged for the safe-room case vs. the healthy-projectile-weapon
  case — only the internal no-progress counter differs now.

## Next steps

- None outstanding; all four dispatched blockers (merge conflict, two review
  threads, one CI failure) are addressed and the review ledger + PR
  prerequisites are complete.

## Retrospective

### Lessons learned

When a reviewer says "this branch cannot work as written because the enclosing
guard shadows it," check both directions: the branch itself AND whatever `else`
picks up when the guard is false. Both needed fixing here.

### Mistakes made

The first fix attempt changed the reset condition inside the already-broken
`else if` without also fixing the "no threat nearby" case, which silently broke
an existing test (`resets NPC threat-clear progress when the nearby-threat gate
exits`) — caught by running the full test file before considering the fix done.

### Opportunities for future improvement

`git log -S` on the exact tuning-constant call site continues to be the fastest
way to confirm whether a "measured and shipped" comment is actually wired in;
worth automating a lightweight check for stale wiring claims in AI tuning files.
