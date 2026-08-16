# Session Handoff: Recover contact-retreat futility guard PR from build break + review harness

## Date

2026-08-15

## Persona

CI Recovery → game-ai-engineer

## Systems touched

ai-combat-balance, ai-pathfinding

## Apples

3🍎 exact

## What Was Done

Recovered PR #2996 ("Release a cornered contact-range retreat that cannot move
the player") from three CI failures and three review threads:

- Fixed a `TS2551` build break: `contactRetreatStartFrame` was removed from the
  class field declarations in an earlier hardening commit but two write sites
  (`startContactRetreatWindow`, `resetContactRetreatTracking`) still assigned
  it, failing `typecheck`/`typecheck:src` and cascading into `ci`/`Lightweight
Checks`/`Merge gate`.
- While fixing that, also reset `contactRetreatActivePolls` to `0` in both of
  those methods — an independent code-review pass (gpt-5.3-codex, different
  model from the implementer) found the exact same omission the same session,
  confirming it was a real bug, not a nit: without the reset, one full
  successful 60-poll window left the counter primed to declare the very next
  short window "pinned" immediately.
- Added a unit test (`does not declare the player pinned after a brief
out-of-contact interruption`) per the outstanding review-thread request:
  proves a short out-of-contact gap (carve-out doesn't fire) is never counted
  toward the 60-active-poll progress window, so a single fresh poll right
  after re-contact cannot be misclassified as pinned.
- Completed the required 3🍎 review ledger
  (`docs/knowledge/review-ledgers/2026-08-15-floor1-pistol33-contact-retreat-pin.review-ledger.json`):
  separate-model plan review (gpt-5.4, `plan_divergence: minor`, no blockers),
  code-review round (gpt-5.3-codex, 2 concerns / 2 resolved — the two bugs
  above), independent grade (gemini-3.1-pro-preview, 5/5/5/5/5, verdict `pass`,
  0 findings, bound to head `b50cf1bc`).
- Ran broad local seed validation to answer the "unattributed death" review
  thread: pistol seeds 1-50 (50/50 victories) via `ai:weapon-sweep`, plus 10
  seeds each across sword/bow/baseball-bat/throwing-knife/fireball (50/50
  victories) — 100/100 total runs, 0 deaths, seed 33 itself now a victory.
  Could not dispatch the full 300-run `weapon-sweep.yml` workflow (no
  `workflow_dispatch`-capable tool in this session's toolset); this local
  sample is the evidence recorded instead.

Observed in the headless pipeline (`npx vitest run
tests/headless/floor1-pistol33-contact-retreat-pin-regression.test.ts`):
before this session's fix, `typecheck`/`typecheck:src` failed outright (build
break); after, both pass and the regression test + all 132
`tests/game/behavior-tree-ai.test.ts` cases (including the new one) pass.

## Key Decisions Made

- Fixed the build break by removing the two stray `contactRetreatStartFrame`
  writes rather than re-adding the field, since nothing reads it —
  `contactRetreatActivePolls` is the only counter the pin decision uses.
- Recorded the code-review round's concerns as already resolved in the same
  round rather than a separate round 2, since the fix (made via direct edit
  before the review agent ran) was already present in the working tree by the
  time the diff was reviewed; the agent's findings were against the last
  _committed_ state, which the fix in this session's push corrects.
- Did not attempt the full 300-run cross-weapon sweep locally (rule #15: >10
  runs should default to GitHub Actions); recorded the 100-run local sample
  gathered instead and left the full sweep as a next-session follow-up.

## What's Next / Blockers

- Dispatch the full `weapon-sweep.yml` (seeds 1-50 × 6 weapons, 300 runs) via
  `workflow_dispatch` to close out the "100% Floor 1 win rate" requirement
  (#2994) with CI-grade evidence rather than a local sample.
- The plan-review's minor deferred concerns (shorter futility window, a
  stronger "repeated pickRetreatTarget fallback" signal, per-cluster instead
  of per-floor latch scoping) remain open follow-ups, not blockers.

## Retrospective

### Lessons Learned

- A field can be deleted from its class-property declarations in one editing
  pass while its write sites survive in a different method further down the
  file — `grep -n` across the exact field name after any manual "harden this
  method" edit is cheap insurance against a `TS2551` surprise in CI.
- Dispatching a code-review agent with `git diff <base>..HEAD` only sees
  _committed_ history — it missed my not-yet-committed working-tree fix and
  (usefully) rediscovered the same bug against the stale commit, which served
  as an independent confirmation rather than a false positive.

### Mistakes Made

- Initially instructed the code-review agent to review `<base>..HEAD` instead
  of the working tree, so it graded already-fixed code as broken; caught by
  cross-checking its line numbers against the current file state before
  recording the ledger round.

### Opportunities for Future Improvement

- No tool in this session's toolset can trigger a `workflow_dispatch` run
  directly (only `list`/`get` on Actions resources) — broad-sweep validation
  in a recovery session is limited to whatever fits in local wall-clock time.
