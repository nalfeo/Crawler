# Session Handoff: Stale-while-revalidate sprite-run listings

## Date

2026-07-22

## Persona

DevOps/Tools Engineer (store-layer/cache ownership)

## Systems touched

azure-infra, sprite-workflow

## Apples

3🍎 estimated, 3🍎 actual (confirmed — single well-localized store-layer
change: one new branch + two private methods + a dedup map in
`CachingRunStore.list()`, a one-line passthrough on `SharedResourceCache`,
test additions, and one new ADR that supersedes part of ADR 0065's listing
invariant).

## What Was Done

`CachingRunStore.list(prefix)` (`scripts/sprites/store/caching-store.ts`)
backs the sidecar's `GET /api/runs` / `GET /api/storage/runs`. Online, it
previously **always** `await`ed a live `inner.list()` Azure round-trip before
responding — the one read path that stayed blocking after ADR 0065 made blob
reads (`get()`) cache-first/instant. Every cold extension/worktree/process
open therefore paid one Azure listing before the run gallery could render.

Implemented stale-while-revalidate (SWR) for listings:

- **Fast path**: if a warmed snapshot's `epoch` matches the cache's current
  epoch, `list()` returns `snapshot.keys` **instantly** — no `await` of
  `inner.list()` — and schedules a deduped background refresh
  (`listRefreshInFlight: Map<string, Promise<void>>`, keyed by snapshot key).
- **Slow path unchanged**: no snapshot, or an epoch-stale snapshot (a
  same-process `put()`/`remove()` bumped the epoch since it was captured) —
  falls through to the exact pre-existing blocking logic. This preserves
  same-process read-your-writes coherence without any new code.
- **Background refresh** (`refreshListSnapshot`): re-lists from `inner`,
  aborts (no publish) if the epoch moved again mid-flight, then writes the
  refreshed snapshot. Purges stale entries for keys the remote no longer
  reports: calls `invalidateDerivedResources(removedKey)` (HTTP-route response
  caches), the blob-cache entry, and `removePerRunSnapshotOnRunRemoval`,
  mirroring the authoritative `remove()` path's call order.
- **Errors swallowed**: the background task's rejection is caught and routed
  through a new `SharedResourceCache.logOperational()` passthrough; it never
  reaches the caller and never becomes an unhandled rejection.
- **Offline behavior unchanged.**

## Runtime Observation (Before / After)

Real artifact: `tests/unit/sprites/caching-run-store.test.ts` ›
`'does not await inner.list before returning when a fresh snapshot exists'`.
The test warms a snapshot, then points a **second** `CachingRunStore` at the
same on-disk cache with a `GatedListStore` whose `list()` promise is
deliberately never released before the assertion. `GET /api/runs` maps
directly onto this method — `listRunsFromStore` (server.ts) calls
`store.list('')` with the identical `RunStore` interface, so this store-layer
proof carries through to the real route unchanged.

- **Before** (old blocking behavior): this exact test would **hang to the
  vitest timeout** — the fast path didn't exist, so `list()` had no way to
  resolve without the (never-released) `inner.list()` settling first.
- **After**: `await s.list(prefix)` resolves in **130ms** (measured via
  `npx vitest run ... -t "does not await inner.list..."`) with the stale
  snapshot data, while `gated.lists === 1` confirms the background refresh
  was still kicked off (fire-and-forget) behind it.

Also confirmed via source read (not just the diff): `listRunsFromStore`
(server.ts ~3106-3120) and the `/api/storage/runs`, sheet-listing, and
run-deletion routes all call `store.list()` through the unchanged `RunStore`
interface — no server.ts changes were needed for the fix to apply to every
route that lists.

## Key Decisions Made

- **Epoch-gated fast path, not "any snapshot exists."** `put()`/`remove()`
  already bump a shared epoch unconditionally; gating the fast path on
  `snapshot.epoch === cache.readEpoch()` gets same-process coherence for
  free — no new logic needed for the two pre-existing tests that depend on
  it (`'refreshes from inner after a mutation bumps the epoch'`, `'rejects a
known-stale snapshot when the online remote fails'`).
- **Purge mirrors `remove()`'s call order.** The background refresh's
  removed-key branch calls `invalidateDerivedResources` → blob-cache
  removal → `removePerRunSnapshotOnRunRemoval`, matching the authoritative
  mutation path exactly (see Code Review below — this was _not_ the case in
  the first draft).
- **Accepted trade-off** (per the requester): a run mutated by a writer that
  bypasses `CachingRunStore` — never bumping the shared epoch — may appear
  one background-refresh late (a few seconds), not on the very next request.
  Same-process mutations remain immediately coherent.
- **New ADR, not an edit to 0065.** `docs/knowledge/adr/2026-07-22-sprite-list-cache-swr.md`
  supersedes only the "online calls always consult the remote" sentence of
  ADR 0065; 0065 cross-links forward to it and stays authoritative for
  everything else (physical cache location, LRU, locking, blob cache-first
  reads).

## Review Harness

Tier-3 ledger:
`docs/knowledge/review-ledgers/2026-07-23-sprite-cache-swr.review-ledger.json`
(`npm run review:ledger -- validate` → valid).

- **Plan review** (separate model, `gpt-5.4`): `approved_with_changes`,
  `plan_divergence: minor`. 4 concerns — 2 fixed directly (purge gated on a
  confirmed snapshot write; purge loop reused
  `removePerRunSnapshotOnRunRemoval` for per-run derived caches), 1 accepted
  as a documented/monitored risk (unbounded `inner.list()` could pin the
  dedup slot — mirrors a pre-existing risk in the old blocking path; a
  proper fix needs store-wide `AbortSignal` plumbing, out of proportion for
  3🍎), 1 fixed with a new test (mutation racing an in-flight background
  refresh must not publish stale data).
- **Code review, 3 rounds** (`claude-sonnet-4.6`):
  - **R1** (1 concern): the purge loop omitted
    `invalidateDerivedResources(removedKey)`, unlike `remove()`. Cached
    HTTP-route responses (`derived:route/brief/...`,
    `derived:route/slice-map/...`) for an externally-deleted run would have
    survived background purge indefinitely, since server.ts's route handlers
    read those before ever reaching a `store.has()` guard. Fixed by adding
    the call (matching `remove()`'s order) + a companion test using a
    3-segment `summary.json` key (the original purge test used a 4-segment
    key that both purge helpers correctly no-op on, so it never exercised
    this path).
  - **R2** (1 concern): re-verified R1's fix from scratch and found it fully
    correct, but caught that it existed **only in the uncommitted working
    tree** — HEAD still had the original bug. Fixed by committing
    (`86704f82f`).
  - **R3**: clean — zero concerns across correctness, concurrency/
    determinism, API/compatibility, security, runtime wiring, regression
    coverage, and Crawler path-specific policies.

## Verification

- `npx vitest run tests/unit/sprites/caching-run-store.test.ts
tests/unit/sprites/sidecar-offline-cache.test.ts` — 41/41 passing.
- `npm run verify:fast` — clean (typecheck + lint + physics/size/weight
  coverage checks).
- `npm run typecheck` — clean, re-run after merging `origin/main` (7 commits
  ahead, unrelated floor2/equipment/ci-health work) to keep the PR diff
  scoped to just this change.
- `npm run docs:check` — 0 blocking findings (2 pre-existing, unrelated
  non-blocking findings: 10 undocumented scripts in
  `docs-check-readme-commands`, one `INDEX.md` filename WARN in
  `docs-archive-handoffs`).
- Review ledger validated (`node scripts/agent/review/cli.mjs validate ...`
  → exit 0).

## What's Next / Blockers

No known blockers. Branch is merged up to date with `origin/main` (merge
commit, not rebase, to preserve the already-reviewed/documented commit
hashes referenced in the ADR and ledger notes). CI owns the full suite.

## Retrospective

### Lessons Learned

- A background-refresh purge path must mirror **every** step of the
  authoritative mutation path it parallels (`remove()`), not just the
  "obvious" one (blob-cache removal) — derived HTTP-route response caches
  are a separate, easy-to-forget invalidation target, and existing tests can
  pass right past a gap in it if they happen to use a key shape neither
  purge helper recognizes.
- Calling an async function without awaiting it still runs its synchronous
  prefix immediately — this let most pre-existing counter-based list tests
  keep passing unchanged under SWR, but is not by itself proof of
  non-blocking behavior; a dedicated gated/deferred-store test (one whose
  promise is provably never released before the assertion) is the rigorous
  mechanism-level proof and was added specifically for that reason.
- Ledger schema note for future sessions: a code-review round's `clean` flag
  means "this round found zero concerns," independent of whether concerns
  found in that round were resolved. Only the **last** round in the array
  must be `clean: true` for the stage to validate — a 3-round loop where
  rounds 1-2 found and fixed real concerns is recorded as
  `clean:false, clean:false, clean:true`, not collapsed into one entry.
- After a mid-session context resume, always re-verify actual repo state via
  fresh `git status`/`git log`/`git show` rather than assuming in-flight
  background work completed or was lost — a resume can wipe background-agent
  and shell handles while leaving the git/filesystem state they produced
  fully intact.
- Before opening a PR, diff against `origin/main` (not just `git status`) to
  catch branch staleness — this branch was 7 commits behind by the time
  implementation finished, and merging early (before writing the handoff)
  avoided a second collision on `docs/knowledge/handoffs/INDEX.md`.

### Mistakes Made

- The first implementation's background purge loop only cleared blob-cache
  entries and per-run snapshots, missing the derived HTTP-route response
  cache — caught in code-review round 1, not the plan review, because the
  plan review focused on control flow correctness rather than exhaustively
  cross-checking every invalidation target `remove()` touches.
- The round-1 fix was drafted but not committed before the round-2 reviewer
  ran, so round 2 spent effort re-confirming a fix that then had to be
  committed anyway — round reviews should be dispatched only after
  `git commit`, not after just editing files.

### Opportunities for Future Improvement

- The plan review flagged that an unbounded `inner.list()` call could pin
  the per-prefix dedup slot indefinitely (no timeout). This mirrors a
  pre-existing risk in the old blocking path and was accepted as
  out-of-proportion for this change's scope; a follow-up could add
  store-wide `AbortSignal`/timeout plumbing shared by both `get()` and
  `list()` background paths.
