# Handoff: Asset-request publisher checkpoint index

## Date

2026-08-27

## Persona

DevOps Engineer

## Systems touched

sprite-pipeline, sprite-workflow

## Apples

3 estimated, 3 actual (exact; tooling-only cap).

## Outcome

The asset-request publisher no longer downloads and parses every historical
checkpoint on each run. It now uses a versioned, CAS-maintained ready index,
while retaining a one-time authoritative backfill for all legacy checkpoint
records and revalidating every indexed checkpoint before publication.

No image generation or paid provider operation was run.

## Measurement

The representative corpus contains 232 legacy-invalid status documents, one
valid selected checkpoint, and one valid published checkpoint.

- Before: 234 checkpoint reads, 22,124 ms, ready issue `[998]`.
- After, five warm-index runs: 2 reads and 0 listings per run, 183-204 ms,
  ready issue `[998]`.
- Wall-time reduction: at least 108x in the representative 90 ms/read model.
- The committed regression asserts exact cold/warm operation counts (1 listing
  plus 234 reads cold, 0 listings plus 2 reads per warm run) and byte-equivalent
  discovery output. Wall-time assertions were deliberately kept out of the unit
  suite because they are host-load sensitive; the operation counts are the
  deterministic contract.

## What changed

- Added `scripts/sprites/asset-request-ready-index.ts` with a strict versioned
  schema and bounded compare-and-swap updates. Azure-backed stores must expose
  server-enforced atomic conditional writes; unsupported Azure stores fail
  loudly rather than degrading to an unsafe overwrite.
- The first publisher run authoritatively enumerates the legacy checkpoint
  namespace, rebuilds a missing/malformed/unknown-version index, and CAS-unions
  all valid ready checkpoint keys. Later runs read only the index and referenced
  ready checkpoints.
- `markIssuePipelineTerminal` registers ready keys before writing
  `selected-pending-publish`, then writes other terminal outcomes before
  removing their ready keys. Crash windows are conservative: stale entries are
  revalidated and skipped, while durable ready transitions cannot be hidden.
- The index is explicitly classified as non-cacheable coordination state, with
  a cross-machine cache regression test.
- `discoverReadyCheckpoints(store, { reconcile: true })` — exposed as
  `npm run sprites:publish-selected -- --reconcile` — performs a bounded
  authoritative re-listing and CAS-unions any ready checkpoint the index never
  learned about (for example one written by a build predating ready-key
  registration) back into the index.
- A ready-index entry whose checkpoint no longer exists is logged as debug-level
  coordination drift, so real checkpoint corruption stays distinguishable.
- Added coverage for concurrent CAS additions, malformed-index repair, atomic
  CAS refusal, legacy backfill, terminal cleanup failure, reset-path wiring, and
  the 232-record performance/equivalence contract.

## Review

- Plan review (`gpt-5.4`) required explicit non-cacheability, authoritative
  malformed-index repair, operation-count assertions, and non-fatal cleanup
  after a durable terminal write. All four concerns were incorporated.
- Code review (`claude-sonnet-5`) found one timing-test robustness issue. The
  strict non-overlap assertion remains, while the reduction threshold now
  compares medians so one scheduler/GC outlier cannot flip the ratio. Round 2
  was clean.

## Verification

- Focused publisher/index/checkpoint/cache suites: 49 tests passed.
- Publisher reset regression: 1 test passed.
- `npm run typecheck` passed.
- `npm run verify:fast` passed: 22 files / 488 changed tests plus lint,
  typecheck, data-contract, integrity, and coverage checks.
