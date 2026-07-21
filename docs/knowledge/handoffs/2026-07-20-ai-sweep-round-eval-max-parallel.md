# AI Sweep round-eval concurrency cap (max-parallel:8)

## Date

2026-07-20

## Persona

DevOps Engineer, fixing a shared-CI-capacity resource blocker discovered by a
sibling session monitoring the merge-train queue.

## Systems touched

ci-workflow (`.github/workflows/ai-sweep.yml`)

## Apples

1 apple estimated, 1 apple actual. Pure config-value + matching-test change:
no production code, no behavioral change to the sweep's semantics, no new
review stages required per the tier matrix. Lands as an addendum on the
already-3-apple, already-ledgered PR #1735 (net-win promotion rule); the
existing ledger remains valid and unaffected.

## What changed

- Added `max-parallel: 8` to the `round1-eval`, `round2-eval`, and
  `round3-eval` job strategies in `.github/workflows/ai-sweep.yml`. Every
  other fan-out matrix job in this workflow (`baseline`, `checkpoint-init`,
  `round1-select`, `round2-select`, `round3-select`, `validate`) already had
  this same cap — round-eval was the sole outlier.
- Updated the workflow's header "RESIDUAL LIMITATION" comment (previously
  described the round-eval matrix as intentionally unrestricted-concurrency)
  to reflect the new cap and cite the incident that motivated it.
- Updated `tests/unit/ai-sweep-workflow.test.ts`: the pre-existing assertion
  explicitly required `max-parallel` to be `undefined` on round-eval jobs
  (encoding the old "let GitHub schedule maximum concurrency" design) — this
  was flipped to require `8`, matching the new policy. Added a new
  workflow-wide regression test that enumerates every matrix job in the file
  and asserts all nine share `max-parallel: 8`, so this exact regression
  (one matrix job silently losing its cap) cannot reoccur undetected on any
  job, not just round-eval.

## Root cause and impact

`round1-eval`/`round2-eval`/`round3-eval` fan out one job per _candidate_
within a round (not one per combo, which is what the other capped matrix
jobs fan out over) — a full run can therefore produce far more concurrent
legs than the account's 20 GitHub-hosted concurrent-runner ceiling. Run
`29786216369` hit exactly this: 20 concurrent Round 3 eval jobs running with
44 more queued, saturating the shared runner pool and starving the
merge-train queue's own required-check validation jobs repo-wide. A human
cancelled the run and a sibling session temporarily labeled PR #1735
`merge-train-blocked` until this cap landed.

## Deterministic coverage

- `ai-sweep-workflow.test.ts`'s per-round `describe.each` test now asserts
  `job.strategy['max-parallel'] === 8` for `round1-eval`/`round2-eval`/
  `round3-eval` (previously asserted `undefined`).
- A new standalone test parses the real YAML, enumerates every job with a
  `strategy.matrix`, asserts the enumerated set matches the nine known
  matrix jobs exactly (baseline, checkpoint-init, round1-3 eval, round1-3
  select, validate), and asserts every one of them has `max-parallel: 8` —
  guarding the whole file against this class of regression on any matrix
  job, not just the three that were fixed.
- `npm run verify:fast` passes (type-check, lint, changed-test run including
  the updated/added `ai-sweep-workflow.test.ts` tests, physics-defs sync).

## Boundaries

No production/game code, no round-DAG semantics (bounded 1-3 round structure,
per-job <=90-minute timeout, checkpoint fan-in/fan-out, net-win promotion
rule), no other workflow files, and no GitHub App/branch-protection
configuration were touched. This is purely a concurrency-policy value change
plus its matching regression test.
