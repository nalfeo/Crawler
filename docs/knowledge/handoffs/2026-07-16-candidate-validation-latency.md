# Handoff: Candidate validation latency

## Date

2026-07-16

## Persona

DevOps Engineer

## Systems touched

ci-policy

## Apples

3🍎 estimated and actual — parallel workflow restructuring, deterministic gate
guards, and aggregate result semantics required a plan review and code-review
loop; the estimate was exact.

## What changed

- Replaced the serial merge-train candidate `verify` job with five read-only job
  groups: static verification, three unit-test shards, four sprite-test shards,
  three independent health checks, and security verification.
- Preserved every previous candidate gate exactly once: source typecheck,
  authoritative full-tree lint, complete unit and sprite projects,
  physics-definition sync, size coverage, weight coverage, and security checks.
  Test jobs use deterministic Vitest `--shard` partitions, never `--changed` or
  affected-only filtering, and matrix fail-fast is disabled so sibling shards
  still finish after a failure.
- Added explicit job timeouts, npm caching, named validation steps, and
  per-job elapsed-time summaries. GitHub's job/step timestamps plus the summary
  make the production critical path directly measurable.
- Kept candidate execution at workflow-level `contents: read`, immutable-SHA
  checkout, and `persist-credentials: false`. The checkout-free `publish` job
  remains the only App-token consumer.
- The trusted publisher now aggregates all five required job results into one
  immutable `merge-train-candidate` check: all success is success, any executed
  failure is failure, and cancellation/skip/timeout remains cancelled and
  retryable. Existing recovery-token and reconciliation wake-up policy is
  unchanged.
- Added real-workflow guards for gate mapping, shard completeness, fail-fast,
  timeouts, timing summaries, candidate permissions, publisher isolation, and
  aggregate dependencies. Extended executable publisher tests for mixed
  success/failure/cancelled/skipped/missing results.

## Timing model

Production baseline was candidate validation p50 ~243s / p95 ~265s, with the
serial fast-integration step at ~217s and dispatch queue p95 ~20s.

Local one-pass shard timing used to select the deterministic split:

| Path              | Slowest measured command | Conservative setup allowance | Modeled job path |
| ----------------- | -----------------------: | ---------------------------: | ---------------: |
| Unit, 3 shards    |                    58.6s |                          45s |           103.6s |
| Sprites, 4 shards |                   119.2s |                          45s |           164.2s |
| Static            |  24s production envelope |                          45s |              69s |
| Security          |                       9s |                          45s |              54s |
| Health            |                     3.9s |                          45s |            48.9s |

The modeled critical path is ~164s, 46s below the 210s candidate-validation
target. A two-way sprite split was rejected after measuring severe deterministic
skew (21s / 263s); four shards measured 73s / 43s / 119s / 118s.

No branch workflow probe was dispatched. Running unmerged
`merge-train-validate.yml` YAML would expose its trusted App-token publisher to
branch-controlled workflow definitions. Production timing should be observed on
the first post-merge candidate validation instead.

## Validation

- Focused workflow tests:
  `npx vitest run --project unit tests/unit/merge-train-validate-publish.test.ts tests/unit/merge-train-validation-sharding.test.ts tests/unit/merge-train-workflow-wakeups.test.ts`
  — 36/36 passed.
- Full unit and sprite projects were exercised once through the proposed shard
  partitions during the timing benchmark; every shard passed.
- `npm run verify:fast` — passed.

## Review harness

- Plan review: `gpt-5.4`, convergent with four concerns resolved before coding
  (fail-fast, unsafe branch probe, complete critical-path budget, executable
  aggregate-result tests).
- Code review: `claude-sonnet-4.6`, round 1 clean with no concerns.
- Ledger:
  `docs/knowledge/review-ledgers/2026-07-16-candidate-validation-latency.review-ledger.json`.
