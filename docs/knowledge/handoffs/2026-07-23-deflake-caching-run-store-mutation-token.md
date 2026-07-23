# Session Handoff: De-flake caching-run-store mutation-token purge test

## Date

2026-07-23

## Persona

Reviewer (test-health / CI-owned test infra)

## Systems touched

sprite-pipeline, ci-policy

## Apples

2🍎 exact

## What Was Done

Fixed the ~50% CI flake in
`tests/unit/sprites/caching-run-store.test.ts` — `'list snapshots > bumps the
mutation token before purging so a get() racing the purge cannot resurrect
the blob'` — that was poisoning `merge-train-validate.yml`'s "Candidate sprite
tests (4/4)" job for every PR (confirmed independent of PR content: PR #1810's
candidate, which touches zero sprite files, failed this suite twice at
`main`-only HEAD `82f58470`).

Root cause: the shared `waitUntil(predicate, maxAttempts)` test helper polled
its predicate by yielding one `setImmediate` macrotask turn between attempts
(no real timer). `setImmediate` callbacks fire as soon as the event loop's
check phase is reached — this does **not** correspond to real elapsed
wall-clock time. The test's background stale-while-revalidate purge
(`CachingRunStore.refreshListSnapshot`) does genuine filesystem I/O via
`cacache` (get.info/put/rm). The `sprites` vitest project runs under the
default fork-based pool (it does not set `pool: 'threads'`), sharded 4 ways in
CI's merge-train-validate job (`--shard=N/4`), so multiple sprite test files'
fork processes contend for the same disk under real, sustained concurrent
load. Under that load, the purge's fs work can take meaningfully longer in
real time than the previous 500-iteration `setImmediate` loop actually let
elapse — `setImmediate` ticks pass in microseconds regardless of pending disk
I/O, so the loop's true "budget" was never really "up to 500 polls" of real
time, just 500 near-instant event-loop turns. This is a genuine
test-timing artifact, not an implementation bug: I read
`CachingRunStore.refreshListSnapshot` in `scripts/sprites/store/caching-store.ts`
and confirmed the mutation-token bump (`bumpMutationToken`, a synchronous
write) unconditionally happens before the cache-entry `remove()` in program
order, with no gate or lock held during the racing `get()`'s pause — the
invariant genuinely always holds; the test just wasn't giving the background
purge's real I/O enough real time to complete before checking.

Fix: changed `waitUntil` to await a real `setTimeout` (`node:timers/promises`)
between poll attempts instead of a bare `setImmediate`, with the same
`maxAttempts` default (500) and a 20ms per-attempt delay (10s total budget,
well inside the sprites project's 120s test timeout). This gives the
background purge's fs-bound work genuine wall-clock time to complete under
concurrent-worker load, without weakening or changing what the test asserts.

Verified: ran the fixed test in isolation 10× (all pass), ran the full
`tests/unit/sprites/caching-run-store.test.ts` file 10× (all pass), and ran
the **entire** `sprites` vitest project (`npm run test:sprites`, 96 files /
1446 tests) twice in a row under sustained concurrent filesystem load —
both full runs passed with zero failures. (This local run is unsharded and
uses the default fork pool, so it is not an exact replica of CI's
`--shard=N/4` sprites job, but it produces the same class of concurrent
disk contention the fix targets.) `npm run verify:fast` also passes.

## Key Decisions Made

- Fixed the **test infrastructure** (`waitUntil` helper), not the
  implementation. Traced the mutation-token-then-purge ordering in
  `CachingRunStore.refreshListSnapshot` and confirmed it is unconditionally
  correct in program order — there is no code path where the cache remove can
  race ahead of the token bump. Per rule #12/#11, changing the implementation
  or weakening the assertion was not on the table since this is a test-timing
  artifact, not a real correctness gap.
- Applied the real-timer fix to the shared `waitUntil` helper (called at 3
  other sites in the same file — lines 734, 767, 942 — with the identical
  polling pattern) rather than special-casing only the failing test, since
  the same event-loop-scheduling flaw applies to every caller.
- Declared 2🍎 (single test file, no runtime/gameplay behavior change,
  bounded scope) — no review-harness stages required at this tier; recorded a
  tier-only ledger per policy.

## What's Next / Blockers

None. This PR is standalone infra and unblocks the merge train for all other
PRs (including Floor 2 PR #1810) once merged — no further action needed
beyond the standard shepherd-to-merge loop.

## Retrospective

### Lessons Learned

- `setImmediate`-based polling loops in tests are **not** a reliable proxy for
  "wait up to N turns" when the awaited work is genuine async fs I/O:
  `setImmediate` fires on the next event-loop check phase regardless of
  whether the pending disk work has completed, so under sustained concurrent
  filesystem load (multiple sprite test files' fork processes contending for
  the same disk, as CI's sharded `sprites` project run produces) a
  "500-iteration" poll loop can burn through its entire budget in
  microseconds of real time while the awaited fs work is still queued. When a
  test needs to observe an async fs-bound side effect, poll with a real (even
  short, e.g. `node:timers/promises` `setTimeout`) delay between attempts,
  not a bare `setImmediate`/microtask yield — the budget (attempts × delay)
  must represent actual wall-clock time, and the loop must add real elapsed
  time on each iteration rather than relying on event-loop scheduling alone.
- Reproducing this flake required running the **entire** sprites vitest
  project (not just the single test or file in isolation) to produce
  sustained concurrent filesystem load; the failing test alone passed 100%
  of isolated local runs, matching the task's evidence that it's invisible
  until the full candidate sprite suite runs under load. Note the local
  unsharded run and CI's `--shard=N/4` run are not identical setups, but both
  exercise the same underlying condition (multiple fork processes competing
  for disk I/O).

### Mistakes Made

- None of substance. Initial theorizing considered a real lock-contention
  bug in `SharedResourceCache.acquireLock`, but tracing the actual call graph
  showed the racing `get()`'s pause is entirely inside `setIfAbsent` (never
  holding the lock while gated) and the purge's lock use is never contended
  by anything else in the test — ruled that out by reading the source before
  changing any implementation code.

### Opportunities for Future Improvement

- Consider auditing other `waitUntil`/poll-based test helpers across the
  sprite test suite for the same `setImmediate`-vs-real-time gap; this file's
  helper was fixed, but similar bare-`setImmediate` polling patterns may exist
  elsewhere and could be latent flakes under sufficient CI load.
