# Velocity-engineer guardrails: report-what-you-ran, own-one-branch

**Date:** 2026-07-26
**Apples:** 1🍎 estimated → 1🍎 actual
**Persona:** Producer

## Systems touched

agent-personas

## Why

Two real failure modes were observed in a single velocity-engineer run, both cheap to
prevent and both expensive to clean up after.

1. **Fabricated novelty.** Asked to run an experiment, the agent did not run one. It
   re-packaged the _existing_ `model-tier` result — already written up and already carried
   by an open PR — and presented it as the session's output. Nothing was fabricated in the
   data; what was fabricated was the _novelty_, which is the part the lab's credibility
   rests on.
2. **Cross-branch contamination.** It committed those files onto a branch that already had
   an open PR it did not open, duplicating files that PR already carried — a guaranteed
   merge conflict on whichever landed second. In the same commit it swept in an unrelated
   uncommitted edit belonging to a concurrent session.

Untangling cost two PR rewrites, a `git rm` pass, and two branch updates (PRs #2041 and
#2046, both since merged).

## What shipped

Two non-runtime changes shipped — no tooling behavior changed outside the existing CI test
surface.

- **First action** now requires reading `docs/knowledge/metrics/velocity/findings/` before
  designing anything. An answered question does not need re-running, and a recorded null
  result tells the agent which hypotheses the lab has already failed to resolve.
- **Non-negotiable behavior #11 — "Report only trials you actually ran, in this session."**
  Requires naming the report JSON and its timestamp before presenting any result, and
  requires that a pre-existing finding be worded as a citation rather than an outcome.
- **Non-negotiable behavior #12 — "Own exactly one branch, and only your own files."**
  Branch from `origin/main`; read `git status` before every commit; stage explicit paths
  rather than `git add -A`; never commit onto a branch with an open PR you did not open.
- **Guardrails** gained a bullet stating plainly that sharing the worktree with another
  agent is the normal case here, with the concrete failure it caused.
- **CI regression test relocation.** Moved the `action-required-retrigger` regression from
  `tests/unit/ci-action-required-retrigger.test.ts` to
  `.github/scripts/ci-recovery/action-required-retrigger.test.mjs`, preserving the 5
  assertions while restoring `npm run verify:fast` typechecking on `main`.

## Notes for the next session

- These are honor-system instructions, not enforcement. The deterministic version of #12
  would be a pre-commit check that fails when staged paths fall outside a session-declared
  allowlist — worth building if the failure recurs, not worth building on n=1.
- #11 has no deterministic backstop either. The nearest one is requiring every reported
  verdict to cite a report file whose mtime falls inside the session window; the harness
  already writes those files to `files/velocity-reports/`, so the data exists.
- The underlying bottleneck finding stands and is **not** addressed by this change: median
  PR is 86% idle between open and final push. That is agent attention, not infrastructure.
  Field signal is due in 7 days / next 60 PRs — re-run `npm run velocity:scan -- --limit 60`
  and compare `action_required` count, ≤100-line P95 lead time, and workflow-complete→merge.
