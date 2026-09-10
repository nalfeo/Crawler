# Fix Goobers reservation checkout so immediate intake reaches selection

## Systems touched

ci-policy

## Kickoff declarations

- Verdict: **recommended** — this is a live production outage with a single,
  provable root cause and a bounded fix.
- Apple estimate: **2**

## Summary

Live Goobers immediate intake was down from the moment intake parity (#4240)
merged. Every `issues`-event dispatch — run `33946058885` and its siblings
around `2026-09-05T04:48Z` — failed in job `Reserve Goobers recovery target`,
step `Resolve Goobers recovery target`, with:

```
Error: Cannot find module '/home/runner/work/Crawler/Crawler/.github/scripts/goobers/intake-selection.mjs'
```

**Root cause.** The `reserve` job's "Fetch reservation tooling" checkout is
sparse on `scripts/agent` only — sized for the lease library it was written for.
Intake parity then routed the whole cohort decision through
`.github/scripts/goobers/intake-selection.mjs` at three call sites in that same
job (resolve, fresh scan, run-start revalidation), and that path was never in
the sparse tree. Nothing under `.github/scripts` was fetched, so `node` could
not resolve the selector or the `ci-recovery/issue-intake-lib.mjs` eligibility
library it imports. Both entry paths — immediate issue events and the hourly
scheduled recovery sweep — enter through this one job, so neither could reach
selection at all.

**Why no gate caught it.** `tests/unit/goobers-run-workflow.test.ts` asserted
the sparse pattern **literally** (`toBe('scripts/agent')`). A test pinned to the
string, rather than derived from what the job actually executes, cannot notice
that the job gained a new repo-path dependency — it only notices that the string
did not change.

## Changes

1. `.github/workflows/goobers-run.yml` — the `reserve` job's checkout is now
   sparse on both `scripts/agent` and `.github/scripts`, with a comment naming
   the outage so the two roots are not "simplified" back to one.
2. `tests/unit/goobers-workflow-checkout-contract.test.ts` (new) — a
   deterministic workflow contract that parses job **step ordering** and derives
   the requirement from the steps themselves. For every job in
   `.github/workflows/goobers-*.yml` plus `issue-copilot-intake.yml` and
   `epic-reprocess.yml` it fails when:
   - a step executes or sources a repository path and the job never checks the
     repository out;
   - the checkout comes **after** the first repo-file access;
   - a checkout uses a PR-author-controlled ref
     (`github.event.pull_request.head.*`, `github.head_ref`,
     `github.event.workflow_run.head_*`), or omits the default-branch pin in a
     workflow triggered by a privileged event (`issues`, `issue_comment`,
     `pull_request_target`, `workflow_run`);
   - a checkout does not set `persist-credentials: false`;
   - a `sparse-checkout` pattern list does not cover a path the job actually
     runs — the exact regression above.
     Detection strips shell comments first, so a remediation message that merely
     _names_ a path is never mistaken for an execution of it, and it carries a
     self-test proving the detector still matches the original failure.
3. `.github/workflows/goobers-validate.yml` — the new gate found a second,
   genuine instance: its checkout left the job token in `.git/config` while the
   job downloads and runs an external Goobers binary against that tree. Now
   `persist-credentials: false`.
4. `tests/unit/goobers-run-workflow.test.ts` — the literal sparse assertion is
   now a containment assertion, with a pointer to the derived contract.
5. `.github/workflows/goobers-contract-validation.yml` — runs the new suite and
   triggers on the two legacy intake workflows and `.github/scripts/goobers/**`.

Deliberately unchanged: lifecycle variables, selectors, eligibility policy, the
cohort model, and every downstream lane.

## Audit of the intake-parity blast radius

Every job in the parity commit's workflows was inspected for the same
missing-checkout cause:

| Workflow                                                                                        | Verdict                                                    |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `goobers-run.yml` / `reserve`                                                                   | **Broken** — sparse tree missing `.github/scripts`. Fixed. |
| `goobers-run.yml` / `run`                                                                       | Full checkout, default-branch pin, credential-free. OK.    |
| `goobers-run.yml` / `release-…`                                                                 | Sparse `scripts/agent`; only reads the lease lib. OK.      |
| `issue-copilot-intake.yml`                                                                      | Full trusted checkout precedes the script. OK.             |
| `epic-reprocess.yml`                                                                            | Full trusted checkout precedes the script. OK.             |
| `goobers-validate.yml`                                                                          | Credentials persisted. Fixed.                              |
| `goobers-shadow.yml`, `-review-threads.yml`, `-lifecycle-owner.yml`, `-contract-validation.yml` | OK.                                                        |

## Validation

- `npx vitest run --project unit tests/unit/goobers-workflow-checkout-contract.test.ts`
  — 6 passed. Verified it **fails** on the pre-fix workflow (it reported the
  uncovered `.github/scripts/goobers/intake-selection.mjs` access) and on the
  pre-fix `goobers-validate.yml` credential gap.
- `npx vitest run --project unit` across the six Goobers suites
  (`goobers-contracts`, `goobers-run-workflow`, `goobers-run-slot-cleanup`,
  `goobers-lifecycle-ownership`, `ci-knobs-guard`, plus the new contract)
  — 377 passed, 2 platform-gated skips.
- `node .github/scripts/validate-goobers-contracts.mjs` — 9/9 workflow schemas,
  19/19 fixtures.
- `npm run typecheck`, `npx eslint`, `npx prettier --check` — clean.
- `npm run verify:fast` — passed.

## Production verification plan

After merge, on `main`:

1. `gh workflow run goobers-run.yml` — confirm `Reserve Goobers recovery target`
   completes and `Resolve Goobers recovery target` emits a selection verdict
   rather than `MODULE_NOT_FOUND`.
2. Label a test issue `goobers:approved` and confirm the resulting `issues`-event
   dispatch reaches selection (immediate-intake path).
3. Wait one hourly cron and confirm the scheduled sweep also reaches selection
   (recovery path — same job, different entry).
4. `gh run list --workflow=goobers-run.yml --limit 20` should show no
   `MODULE_NOT_FOUND` failures in the reserve job.

## Unresolved / next steps

- The contract only covers Goobers plus the two intake workflows. Widening it to
  every workflow needs a decision about `pull_request`-triggered validation jobs,
  which legitimately check out the PR ref; that is deliberately out of scope here.

## Apples

Actual: **2** — matched the estimate. The production fix was one sparse-checkout
list; the bulk of the work was the derived contract that makes the class
impossible to reintroduce, plus the blast-radius audit that found the second
instance.
