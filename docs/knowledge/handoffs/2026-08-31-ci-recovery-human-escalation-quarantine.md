# Session Handoff: CI recovery quarantines human-escalated review threads

## Date

2026-08-31

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

2🍎 exact (tooling-only: CI recovery automation scripts, tests, and one policy line)

## What Was Done

Diagnosed loop incident #3969 on PR #3958 and fixed the deterministic defect it exposed.

Evidence: on the single blocking thread
(https://github.com/nalfeo/Crawler/pull/3958#discussion_r3892532228) the CI review-validator
confirmed the reviewer's finding as VALID with a second model and replied
_"Leaving this thread UNRESOLVED and escalating to a human… Thread intentionally left
unresolved for human escalation."_ That is the validator's designed terminal outcome for a
finding whose fix is an owner-sized feature. `reconcile.mjs` had **no representation for
that state**: the thread stayed an ordinary unresolved `review-thread` blocker, so recovery
re-dispatched the identical task, exhausted both attempts, and filed a loop incident instead
of reaching a stable state. The pre-existing `isScopeMismatchReviewBlocker` quarantine did
not catch it either — the reviewer's phrasing ("adds only the planning ledger; none of the
runtime or test changes … are present") misses `scopeMismatchUnsupportedPattern`.

Fix (modelled on the protected-path quarantine from PR #3957):

- `state.mjs`: `isHumanEscalationDeclaration()` (conjunction of a human hand-off phrase and
  an explicit leaving-unresolved phrase, quoted lines stripped) plus
  `shouldQuarantineHumanEscalatedBlockers()`; `humanEscalationDeclared` now survives
  `normalizeBlockers`.
- `reconcile.mjs`: the in-thread recovery-reply scan records the escalation for the thread,
  the review-thread blocker carries `humanEscalationDeclared`, and a new quarantine branch
  moves the PR to `PHASE.QUARANTINED` with trigger `human-escalation-quarantined` and a
  `KEEP`/`ABANDON` operator comment. An owner `KEEP` overrides the escalation.
- `AGENTS.md`: documents the escalation reply contract and the quarantine it produces.

Observation (real artifact = the reconcile script itself, exercised end-to-end against a
mocked GitHub API): **before** — with `isHumanEscalationDeclaration` stubbed to `false`, the
new reconcile test fails, because reconcile walks into the dispatch path and tries to assign
Copilot again. **After** — the same fixture prints `quarantined human-escalation pr=#42`,
posts the quarantine comment, records trigger `human-escalation-quarantined`, and dispatches
no repair task. Full `state.test.mjs` + `reconcile.test.mjs` suite: 269/269 pass.

## Key Decisions Made

- **Quarantine, not incident suppression.** A human-escalated finding is a decision request,
  not noise; giving the owner a `KEEP`/`ABANDON` state is strictly more actionable than
  burning attempts and filing a loop incident.
- **Detect the declaration, not the finding.** Broadening the scope-mismatch regexes would
  have been phrase-chasing against one reviewer's wording and would not generalize to
  non-scope escalations. The validator's own escalation declaration is the reliable,
  intent-bearing signal.
- **Conjunctive detection + author trust.** Both a human hand-off phrase and an explicit
  "leaving unresolved" phrase are required, quoted lines are stripped, and only a known
  recovery-agent author in an unresolved thread can set it — so a passing "escalate to a
  human if this recurs" cannot park a repairable PR.
- **Terminal only when total.** Quarantine fires only when _every_ remaining blocker is
  escalated; any repairable blocker keeps normal dispatch alive.
- No gate was weakened: the escalated thread is never auto-resolved, and the review-thread
  merge gate still holds.

## What's Next / Blockers

- PR #3958 itself still needs an owner decision (its 5🍎 Ratings Ram slice is unimplemented
  while the PR declares `Fixes #3915`). With this change, the next reconcile sweep will
  quarantine it and ask for `KEEP`/`ABANDON` rather than looping.
- Worth considering later: a canonical escalation marker (e.g. `⚠️ Escalated to human:`)
  instead of regex-detected prose. That requires editing `.github/agents/**`, a protected
  path that ordinary sessions cannot touch — which is why prose detection was chosen here.

## Retrospective

### Lessons Learned

- CI recovery has four quarantine classes now (no-activity/superfluous, protected-path,
  scope-mismatch, and this one). They share an identical shape: detector in `state.mjs`,
  per-thread set in `reconcile.mjs`, blocker field through `normalizeBlockers`, quarantine
  branch before the dispatch path. Copying that shape is much cheaper than inventing a path.
- Follow-up review feedback added an implementation-missing repair prompt for trusted review
  threads that say a PR is effectively empty or did not implement the requested feature. Those
  threads stay repairable when they are not terminal scope-mismatch/human-escalation cases, but
  the next task now explicitly tells Copilot to implement production/test changes instead of
  stopping at uncertainty or editing only planning artifacts.
- `reconcile.test.mjs` fixtures assert-fail inside the mocked GraphQL handler when the code
  walks into the dispatch path — a negative-control run (stub the detector to `false`) is a
  cheap and convincing fail-to-pass proof, but it hangs for ~5 minutes on the assign path,
  so budget for that.

### Mistakes Made

- Initially considered widening `scopeMismatchUnsupportedPattern` to match the reviewer's
  wording. Early signal that it was wrong: the same PR would still have looped for any
  escalated finding that is not a scope mismatch. Detecting the _declared terminal state_
  instead of the _finding text_ is the general fix.

### Opportunities for Future Improvement

- The four quarantine branches in `reconcile.mjs` are near-identical ~50-line blocks; a
  single `quarantine({ reason, explanation, nextActions, keepOutcome, trigger })` helper
  would remove ~150 lines and one class of copy-paste drift.
- Loop-incident issues could name the terminal-state class they hit (escalation,
  protected-path, scope-mismatch) so the next diagnosis starts from the right branch.
