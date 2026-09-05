# Goobers terminal-label idempotency

## Systems touched

goobers-automation, ci-workflows

## Persona

DevOps Engineer · 2🍎 estimated / 2🍎 actual

## Problem

Goobers issue-event run
[33938863082](https://github.com/nalfeo/Crawler/actions/runs/33938863082)
processed issue #4140 to the no-work disposition `completed-existing-work`, then
`Handle no-work disposition` died at:

```
label with name "goobers/status:completed-existing-work" already exists; use `--force` to update its color and description
##[error]Process completed with exit code 1.
```

The step never reached the `gh issue edit` that applies the terminal label and
removes `goobers/status:in-review`, so #4140 sat OPEN, unassigned,
`goobers:approved` + `goobers/status:in-review`, with no terminal label and no
Goobers PR — permanently reserved at the head of scheduled recovery. Issue #3541
was hit by the same defect earlier.

## Root cause

The existence probe was `gh label view <name> || gh label create <name>`.

`gh label` exposes `clone`, `create`, `delete`, `edit`, `list` — **there is no
`view` subcommand**. The probe therefore _always_ exited non-zero, so
`gh label create` ran on every single `completed-existing-work` disposition, and
on the ordinary already-exists path `gh` exits 1. Under the step's
`set -euo pipefail` that killed the whole step before the disposition landed.

PR #4260's lane refactor later appended a blanket `|| true`, which stops the
abort but keeps issuing a doomed create every run and silently swallows a
genuine permission/rate-limit failure.

## What changed

- `.github/workflows/goobers-run.yml`: replaced the broken probe with an
  `ensure_repository_label()` helper that mirrors the repo's established
  create-if-missing pattern (`scripts/sprites/asset-request-publisher.ts`):
  `gh label list --search <name> --json name` exact-match probe, create only
  when missing, treat an `already exists` create as success (concurrent slot /
  stale search index), and report anything else as a `::warning::` naming the
  exact `gh label create` remediation. `--force` is deliberately not used — it
  would overwrite a repo-managed label's colour and description on every
  disposition.
- The ensure is best-effort by design: a failed probe must not abort the
  disposition, because the label may exist and only the probe failed. The
  `gh issue edit` remains the authoritative gate and already carries an
  actionable error.
- `tests/unit/goobers-run-slot-cleanup.test.ts`: new executable suite
  `goobers-run.yml terminal label idempotency` that runs the real step body
  under bash against `gh` stubs modelling three states — label already exists,
  create race lost, create genuinely denied — including a `gh label view` stub
  that fails with `unknown command`, which is what makes these fixtures a real
  regression rather than a hypothetical one.
- `tests/unit/goobers-run-workflow.test.ts`: structural guard that the step
  contains no `gh label view` and no `--force`, plus the stale assertion that
  pinned the buggy `gh label view` line updated to the new helper.

## Audit of equivalent sites

`git grep 'gh label'` across the repo returns three call sites; only the Goobers
one was defective:

| Site                                         | State                                                        |
| -------------------------------------------- | ------------------------------------------------------------ |
| `.github/workflows/goobers-run.yml`          | **fixed here**                                               |
| `.github/workflows/deploy.yml:334`           | already correct (`if ! gh label create ... 2>/dev/null`)     |
| `scripts/sprites/asset-request-publisher.ts` | already correct (`gh label list --search` create-if-missing) |

No other `goobers/status:*` label is created anywhere; the rest are assumed to
exist and only ever added/removed via `gh issue edit`.

## Regression proof

With the old `gh label view || gh label create` block restored and the fix's
helper otherwise untouched:

- `never calls 'gh label create' for a label the repository already has` — FAIL
- `reports a genuine label-create failure while still releasing the issue` — FAIL
- `probes label existence with a 'gh label' subcommand that actually exists` — FAIL

All four idempotency tests plus the structural guard pass on the fix.

## Verification

- `npx vitest run --project unit tests/unit/goobers-run-slot-cleanup.test.ts tests/unit/goobers-run-workflow.test.ts` — 114 passed, 2 skipped
- `node .github/scripts/validate-goobers-contracts.mjs` — 9/9 schemas, 19/19 fixtures
- `npm run verify:fast` — green
- `npm run test:guards` — green

## Live cleanup of #4140

Applied only the already-recorded journal disposition, after proving there was
nothing resumable:

- `gh api repos/nalfeo/Crawler/issues/4140/timeline` — zero same-repo PR
  cross-references.
- `gh pr list --state open` — zero open `goobers/crawler/*` branches repo-wide.
- `gh issue edit 4140 --add-label goobers/status:completed-existing-work --remove-label goobers/status:in-review`.

Resulting labels: `telemetry`, `gameplay`, `ux`, `goobers:approved`,
`reported-issue`, `goobers/status:completed-existing-work`. Issue stays OPEN and
is no longer eligible for scheduled recovery (the backlog search excludes both
`goobers/status:in-review` and `goobers/status:completed-existing-work`).

No lifecycle variables or downstream lane selectors were touched.
