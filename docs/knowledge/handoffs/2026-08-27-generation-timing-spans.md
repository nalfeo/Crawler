# Sprite generation timing spans

**Date:** 2026-08-27
**Persona:** Graphics Designer / performance instrumentation
**Apples:** 3🍎 estimated / 3🍎 actual (exact — additive run and checkpoint telemetry with deterministic fixtures)

## Systems touched

sprite-pipeline, sprite-workflow

## Outcome

Added behavior-neutral monotonic timing attribution for the initial sprite run and
issue-pipeline checkpoint wrapper. No paid image, text, or vision provider was
invoked.

`summary.json` now optionally exposes a schema-validated `timing` snapshot with:

- variation expansion;
- reference selection and PNG reads;
- image provider time;
- initial sheet persistence;
- slicing and post-processing;
- candidate persistence;
- judging;
- residual run orchestration.

`totalMs` must exactly equal the stage sum. The field is explicitly scoped to the
historical `initial-run`, so later reprocess/rejudge operations preserve rather
than relabel it.

Issue checkpoint v1 documents remain backward compatible. Their existing
extensible `details` object now optionally carries `checkpointTiming`, split into
stage operation and wrapper orchestration time. Retry time accumulates, resumed
stages do not charge operation time, and timing remains cumulative across an
intentional exhausted-stage control-flow reset.

## Measurement and observation

- **Before:** the observed generation interval was one provider-inclusive
  `77.374s` span, so provider, reads, persistence, slicing, and orchestration
  could not be distinguished.
- **After:** the committed fake-clock fixture deterministically attributes a
  `140ms` initial run as `5 + 7 + 50 + 8 + 21 + 26 + 8 + 15ms`, with the schema
  rejecting any non-reconciling total.
- The checkpoint fixture attributes three attempts as `9ms` operation plus `7ms`
  orchestration, exactly `16ms`.
- A focused failure proof temporarily changed total accounting from a zero to a
  one offset; `pipeline-timing.test.ts` failed with `40ms` expected versus
  `41ms` actual, then passed after restoration. Stryker was attempted first but
  executed zero tests, so it was not counted as evidence.

The deterministic fake provider/store pipeline is the real artifact for this
instrumentation-only change. It invokes the same generation, persistence,
postprocess, judge-disabled, rerun, retry, resume, and reset ownership paths
without network access or paid generation.

## Compatibility and neutrality

- Existing summaries omit `timing` and remain valid.
- Existing v1 checkpoints omit `details.checkpointTiming` and remain valid.
- Prompt construction, reference choice, RNG, provider requests, generated PNG
  bytes, candidate ordering, and approval behavior are unchanged.
- Timing uses `performance.now()` by default and injected monotonic clocks in
  tests; invalid or backwards samples fail open and only increment telemetry.
- Telemetry adds no checkpoint writes. The terminal write that persists a timing
  snapshot is intentionally excluded from its own orchestration duration.

## Verification

- Targeted sprite suites: 65 tests passed across timing, checkpoints, resumable
  runs, issue pipeline, generation, and full-run integration.
- Rerun provenance suite: initial-run timing remains unchanged after postprocess
  and judge reruns.
- `npm run typecheck` passed.
- `npm run verify:fast` passed (385 sprite tests in the changed-test phase).

## Review harness

Ledger:
`docs/knowledge/review-ledgers/2026-08-27-generation-timing-spans.review-ledger.json`

- Plan review (`gpt-5.4`): five concerns resolved; `plan_divergence: minor`.
- Code review (`claude-sonnet-5`): four findings resolved in round 1; round 2
  clean.
- Independent grade is recorded against the reviewed implementation commit.

## Blockers

None.
