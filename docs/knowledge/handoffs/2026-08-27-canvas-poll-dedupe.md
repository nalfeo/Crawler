# Workflow canvas poll deduplication

## Date

2026-08-27

## Persona

DevOps Engineer

## Systems touched

sprite-workflow, ci-policy, devtools

## Apples

Estimated: 3

Actual: 3

Exact: the work added one coordinator module, lifecycle and ETag-safe integration,
deterministic multi-instance coverage, and the required two-round review loop.

## Summary

Replaced one 10-second durable workflow-state poll per open Workflow canvas with a
single process-wide poll. The coordinator elects one live entry for each interval,
performs one fresh `/api/workflow/state` read, and fans the resulting state and ETag
out to every instance that remained live for the complete tick.

Mutable workflow state remains per-instance. The coordinator stores no state
snapshot between ticks, coalesces overlapping ticks, starts its timer on the first
subscription, and clears it after the last instance closes.

## Correctness and lifecycle

- Manual reads and successful mutations advance a process-wide invalidation epoch,
  suppressing any older in-flight poll result across all instances.
- Poll-driven completion writes reuse the tick's fresh ETag for one conditional PUT.
  An ETag conflict performs no stale write and is retried by the next interval rather
  than adding another state GET to the current interval.
- The live entry itself is the subscription source, so sidecar client rebinding is
  observed on the next tick.
- Closed or replaced subscribers are excluded from in-flight fan-out. Closing the
  final instance clears the shared timer and cannot restart it from a late result.

## Measurement

The deterministic six-instance benchmark compares the previous six reads per
10-second interval with the new single read:

- Before: 0.6 `/api/workflow/state` reads per second.
- After: 0.1 reads per second.
- Reduction: 83.33%, exceeding the 80% gate.

The same test proves all six live instances receive a changed snapshot. Additional
tests cover quiet and completion intervals, unsubscribe cleanup, invalidation,
in-flight close/open behavior, overlapping ticks, and the production entry/client
composition.

## Review harness

Ledger:
`docs/knowledge/review-ledgers/2026-08-27-canvas-poll-dedupe.review-ledger.json`

- Plan review (`gpt-5.4`): four concerns resolved; `plan_divergence: minor`.
- Code review (`claude-sonnet-5`): round 1 found a subscriber/source wiring defect
  and its missing regression case; both were fixed. Round 2 was clean.

## Validation

- Workflow extension suite: 273 tests passed.
- `npm run verify:fast` passed.
- The six-instance benchmark reported an 83.33% request reduction.
- The 3-apple review ledger and PR prerequisites passed.

## Blockers

None.
