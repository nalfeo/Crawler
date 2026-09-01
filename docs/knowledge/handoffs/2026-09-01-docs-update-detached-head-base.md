# Session Handoff: docs-update detached-HEAD PR base

## Date

2026-09-01

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

Estimated 1🍎, actual 1🍎.

## What Was Done

Fixed the `Docs Update Loop` failure reported in CI incident #4040 (run 33537349094). Since
the loop moved to the `workflow_run` merge-train trigger it checks out
`github.event.workflow_run.head_sha`, which leaves HEAD detached on a bare commit.
`peter-evans/create-pull-request@v7` refuses to run in that state without an explicit base and
hard-fails with `When the repository is checked out on a commit instead of a branch, the 'base'
input must be supplied.` Both the primary and the retry PR steps hit it; the retry step has no
`continue-on-error`, so the job failed. Added `base: main` to both steps and a regression
assertion in `tests/unit/docs-update-workflow.test.ts`.

## Key Decisions Made

Kept the fix to the missing `base` input rather than reverting the checkout to a branch ref:
the payload gate deliberately classifies the exact landed merge-train commit, so the detached
checkout is the intended behavior. `main` is the only branch the loop can target, since the
`workflow_run` trigger is already restricted to `branches: [main]`.

## What's Next / Blockers

No known blockers. The next merge-train landing with a non-doc payload exercises the path.

## Retrospective

### Lessons Learned

`peter-evans/create-pull-request` infers its base from the checked-out branch; any workflow that
checks out a SHA must pass `base` explicitly. This failure mode is latent — it only surfaces on
runs that actually have docs changes to publish, so it can hide for weeks after the trigger
change that introduced it.

### Mistakes Made

I first tried to reproduce the failure by re-running the docs check scripts locally, which all
passed; the real signal was the run-page annotation, not the script exit codes.

### Opportunities for Future Improvement

Consider auditing other workflows for `actions/checkout` with a `ref:` SHA feeding an action
that assumes a branch checkout.
