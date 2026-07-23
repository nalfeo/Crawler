# ADR: Stale-While-Revalidate Listings for the Shared Azure Resource Cache

## Status

Accepted. Supersedes the "online calls still refresh from Azure" sentence of
the **List snapshots** bullet in
[ADR 0065](0065-shared-azure-resource-cache.md#decision) — everything else in
ADR 0065 (namespacing, blob artifact semantics, LRU, offline mode) remains
authoritative and unchanged.

## Date

2026-07-22

## Estimated Complexity

🍎🍎🍎 — one well-localized store-layer file (plus a three-line logger
passthrough elsewhere) reverses a documented ADR'd invariant, adds an
async dedup/error-swallowing background task, and requires a test-file
rewrite/expansion and this ADR. No `src/` gameplay or shipped game-data
changes — this is asset-pipeline/devtools tooling.

## Plan Review

A separate-model plan review (required at 🍎🍎🍎) returned
`approved_with_changes` / `plan_divergence: minor` with four concerns, all
addressed before implementation was considered done:

1. **[Blocking, fixed]** The original plan discarded `cache.set()`'s
   `boolean` return value before purging. `refreshListSnapshot()` now gates
   the entire purge step on a confirmed snapshot write (see Decision above).
2. **[Non-blocking, accepted risk]** A hung `inner.list()` pins the dedup
   slot forever. Documented under Risks below rather than fixed — see
   rationale there.
3. **[Non-blocking, fixed]** The purge loop only cleared `blob:` entries, not
   the per-run derived caches (`derived:brief-snapshot/...`,
   `derived:slice-map-fingerprint/...`). Fixed by reusing the existing
   `removePerRunSnapshotOnRunRemoval()` helper (already used by the
   authoritative `remove()` path) inside the purge loop.
4. **[Non-blocking, tested]** No test proved a same-process mutation racing
   a still-in-flight background refresh prevents that refresh from
   publishing/purging stale data. Added
   `'does not publish a stale refresh result when a mutation races the
in-flight background list'` to
   `tests/unit/sprites/caching-run-store.test.ts`.

## Code Review

A separate-model code review (required at 🍎🍎🍎) returned one valid
Medium-severity finding, otherwise clean across concurrency/determinism,
API/compatibility, security, runtime wiring, regression coverage, and layer
boundaries:

1. **[Medium, fixed]** The purge loop called
   `removePerRunSnapshotOnRunRemoval(removedKey)` (clears the per-run
   `derived:brief-snapshot/...` / `derived:slice-map-fingerprint/...` caches)
   but omitted `invalidateDerivedResources(removedKey)` (clears the cached
   HTTP-route _response_ caches, `derived:route/brief/<briefId>/<runId>` and
   `derived:route/slice-map/<briefId>/<runId>/...`) — unlike the authoritative
   `remove()` path, which calls both. Concretely, `server.ts`'s route handlers
   read those response caches via a cache-first fast path
   (`readCachedJson`/`getCachedResource`) **before** ever reaching the
   `store.has(summaryKey)` guard that would notice the run is gone, so an
   externally-deleted run's cached brief/slice-map HTTP responses would keep
   being served indefinitely after a background purge — the one purge target
   that mattered for "stale response served to a client" was the one being
   skipped. Fixed by adding `await this.invalidateDerivedResources(removedKey)`
   as the first call inside the purge loop's removed-key branch, mirroring
   `remove()`'s exact call order (derived-route caches → blob-cache entry →
   per-run snapshot caches). The reviewer also flagged that the original purge
   test used a 4-segment key (`raw/00.png`), which both purge helpers
   correctly no-op on — so neither the gap nor the fix was exercised by any
   test. Added
   `'purges derived HTTP-route response caches for a run the background
refresh no longer reports'` (a 3-segment `summary.json` key) to
   `tests/unit/sprites/caching-run-store.test.ts`, directly exercising the
   fixed path.

2. **[Process, fixed]** An independent round-2 review re-verified the
   round-1 fix (call order, `invalidateDerivedResources` semantics, test
   determinism, and the epoch/dedup guards) and confirmed it was fully
   correct — but caught that the fix existed only in the uncommitted working
   tree, not `HEAD`. Committed as `86704f82f`.
3. A third, fully independent review of the committed state returned zero
   concerns across all categories (concurrency/determinism,
   API/compatibility, security, runtime wiring, regression coverage, layer
   boundaries). The code-review loop closed clean after 3 rounds.

## Post-PR Automated Review

After PR #1805 was opened, GitHub's automated `copilot-pull-request-reviewer`
left 3 inline findings, all addressed in a follow-up commit:

1. **[Correctness, fixed]** The background refresh's purge loop called
   `this.cache.remove(blobCacheKey)` directly, without first bumping the
   entry's mutation token the way the authoritative `remove()` path does.
   `SharedResourceCache.get()` on a cache miss captures
   `expectedMutationToken` **before** calling `inner.get()`, then only
   commits the re-fetched bytes via `setIfAbsent(key, data, undefined,
expectedMutationToken)` if the token is still current. Without the bump,
   a `get()` for a key already in flight when the purge ran could still win
   the race and resurrect the just-purged blob permanently (the purge's
   `remove()` would run, then the stale `get()`'s delayed `setIfAbsent` would
   silently repopulate it, and nothing would ever purge it again since the
   remote no longer reports the key). Fixed by calling
   `this.cache.bumpMutationToken(blobCacheKey)` immediately before
   `this.cache.remove(blobCacheKey)` in the purge loop, mirroring `remove()`'s
   exact sequencing.
2. **[Correctness, fixed]** Four `server.ts` routes enumerate a `list()`
   result and then act destructively on every key it contains: archive
   (`/api/storage/runs/archive`), delete (`/api/storage/runs/delete`),
   clear-store (`/api/workflow/store/clear`), and single-run delete
   (`DELETE /api/runs/:briefId/:runId`, which lists twice — once for the
   run's own keys, once to decide whether the parent brief directory is now
   empty). Under the new fast path these could enumerate a stale snapshot,
   silently leaving newly-added files un-archived/un-deleted or
   under-reporting `deletedCount`. Fixed by adding an optional
   `{ authoritative?: boolean }` second parameter to `RunStore.list()`
   (`scripts/sprites/store/types.ts`); `CachingRunStore.list()` now gates its
   fast path on `options?.authoritative !== true`, so passing
   `{ authoritative: true }` always takes the existing blocking path
   regardless of snapshot freshness. All 4 destructive routes (5 call sites)
   were updated to pass it. Every other `list()` call site (the read-only
   `GET /api/storage/runs` and `GET /api/runs/:briefId/:runId/sheets`
   listings, the slice-map route, `hydrateRunDirForApproveFromStore`, and
   `findLatestRunForBriefSince`) was deliberately left on the fast path — the
   review's scope named exactly these 4 routes, and expanding further would
   have re-blocked reads the whole ADR exists to make instant.
3. **[Docs, fixed]** This ADR's Code Review section had a stale placeholder
   sentence ("A required round-2 review is documented below once completed")
   left over from an earlier draft, even though the ledger and handoff
   already recorded all 3 code-review rounds as complete. Replaced with the
   actual round-2/round-3 summary above.

## Context

ADR 0065 made `CachingRunStore.get()` (blob bytes — sheets, images,
`summary.json`, judge output) cache-first: a disk hit returns instantly with
zero Azure calls. It deliberately kept `CachingRunStore.list(prefix)`
different: every ONLINE call still awaits a live `inner.list(prefix)` Azure
round-trip, only serving the warmed on-disk snapshot when offline or when the
remote throws. The stated rationale (ADR 0065, "List snapshots" bullet) was
that "online calls still refresh from Azure so an external writer cannot
leave an indefinitely stale result."

In practice this made `list()` the one read path that did NOT get the
"instant across worktrees" guarantee the rest of the cache provides. Both
sidecar routes that gate the run gallery UI — `GET /api/runs`
(`listRunsFromStore`, `scripts/sprites/sidecar/server.ts`) and
`GET /api/storage/runs` — call `store.list()` directly, so every cold
extension/worktree/process open paid one blocking Azure list before the run
gallery could render anything, even though every individual run's bytes were
already warmed and instant. The per-process, in-memory extension cache
(`.github/extensions/workflow/lib/run-view-cache.mjs`) cannot fix this: it
resets on every new process/worktree, so it cannot provide the cross-process
"if I've loaded it once, it's instant everywhere" guarantee the maintainer
asked for.

The maintainer's bounded requirement: after a run listing has been fetched
once (a warmed on-disk snapshot exists), a subsequent online
`GET /api/runs` must return without awaiting a live Azure `list()` — served
from the warmed snapshot — with a background revalidation that refreshes or
purges the snapshot. A first-ever load (no snapshot yet) may still block
once. The maintainer explicitly accepts a bounded staleness window (below) in
exchange for instant loads.

## Decision

### Epoch-gated stale-while-revalidate fast path

`CachingRunStore.list(prefix)` gains one new branch, inserted before the
existing (unchanged) blocking slow path:

- If a warmed snapshot exists **and** its captured `epoch` still matches the
  shared cache's current `readEpoch()`, return `snapshot.keys` **immediately**
  — no `inner.list()` await — and schedule a deduped background refresh.
- Otherwise (no snapshot, or the epoch has moved because a `put()`/`remove()`
  bumped it since the snapshot was captured), fall through to **today's exact
  blocking logic, byte-for-byte unchanged**: block on `inner.list()`, cache
  the result if the epoch held steady across the call, and on remote failure
  fall back to the snapshot only if it is still epoch-fresh at catch time,
  else rethrow.
- **Offline mode is untouched**: it remains the first branch in the method
  and always serves the warmed snapshot (or throws `StoreNotFoundError`) with
  zero remote reads, exactly as ADR 0065 specified.

The epoch gate is what makes this safe rather than "always serve stale
data": `put()`/`remove()` already call `cache.bumpEpoch()` unconditionally on
every mutation (this predates this ADR). So a same-process write (approve,
check-in, generate, remove) immediately invalidates the fast path for the
next `list()` call on that prefix — same-process read-your-writes coherence
is fully preserved, identical to before this change.

### Authoritative escape hatch for enumerate-then-act callers

`RunStore.list()` gained an optional second parameter,
`options?: { authoritative?: boolean }` (`scripts/sprites/store/types.ts`).
Passing `{ authoritative: true }` forces `CachingRunStore.list()` to skip the
fast path unconditionally and always take the blocking `inner.list()` path,
regardless of snapshot freshness. This exists for the handful of `server.ts`
routes that enumerate a `list()` result and then act destructively on every
key returned (archive, delete, clear-store, single-run delete) — for those,
a stale snapshot is not just "one refresh late," it is a correctness bug
(a newly-added file surviving an "archive everything" call, or a wrong
`deletedCount`). Every other call site (plain reads: run galleries, sheet
listings, slice-map lookups) stays on the fast path, since serving a few
seconds of staleness there is exactly the trade-off this ADR accepts.
`AzureBlobRunStore` and `LocalRunStore` both ignore the option — they have no
snapshot layer and are always authoritative already.

### Background refresh: dedup, error-swallowing, purge

```ts
private readonly listRefreshInFlight = new Map<string, Promise<void>>();

private scheduleListRefresh(prefix, snapshotKey, previousKeys): void {
  if (this.listRefreshInFlight.has(snapshotKey)) return; // dedup
  const task = this.refreshListSnapshot(prefix, snapshotKey, previousKeys)
    .catch((err) => this.cache.logOperational(`list refresh failed for ${snapshotKey}: ${errMsg(err)}`))
    .finally(() => { if (this.listRefreshInFlight.get(snapshotKey) === task) this.listRefreshInFlight.delete(snapshotKey); });
  this.listRefreshInFlight.set(snapshotKey, task);
}

private async refreshListSnapshot(prefix, snapshotKey, previousKeys): Promise<void> {
  const epochBefore = this.cache.readEpoch();
  const keys = await this.inner.list(prefix);
  const epochAfter = this.cache.readEpoch();
  if (epochBefore !== epochAfter) return; // a same-process mutation raced us and already owns invalidation
  const snapshotWritten = await this.cache.set(
    snapshotKey,
    Buffer.from(JSON.stringify({ epoch: epochAfter, keys }), 'utf8'),
    { crawlerPinned: true },
  );
  if (!snapshotWritten) return; // best-effort write failed: leave the old snapshot/blobs alone
  const freshKeys = new Set(keys);
  for (const removedKey of previousKeys) {
    if (!freshKeys.has(removedKey)) {
      // Order mirrors the authoritative remove() path: derived HTTP-route
      // response caches first (fixed in code review), then the blob-cache
      // entry — mutation-token bump BEFORE remove (fixed in the post-PR
      // automated review, see below) — then per-run fingerprint caches.
      await this.invalidateDerivedResources(removedKey);
      const blobCacheKey = `${BLOB_PREFIX}${removedKey}`;
      this.cache.bumpMutationToken(blobCacheKey);
      await this.cache.remove(blobCacheKey);
      await this.removePerRunSnapshotOnRunRemoval(removedKey);
    }
  }
}
```

- **Dedup**: keyed by `snapshotKey` (per prefix), the same in-flight-map
  pattern already used by `putInFlight`. Concurrent `list()` calls for the
  same prefix trigger at most one `inner.list()` per refresh window.
- **Errors are swallowed, never surfaced to the caller**: routed through a
  new `SharedResourceCache.logOperational(message)` passthrough (the `log`
  field was already private with no accessor). The background task's
  rejection is always caught; it can never become an unhandled promise
  rejection and never rejects the in-flight `list()` call that scheduled it.
- **Purging is gated on a confirmed snapshot rewrite**: `cache.set()` is
  best-effort and returns `boolean` (it can fail on lock contention or a
  caught write exception). The refresh only purges blob-cache entries and
  per-run derived caches (`derived:brief-snapshot/...`,
  `derived:slice-map-fingerprint/...`, via the existing
  `removePerRunSnapshotOnRunRemoval()` helper already used by the
  authoritative `remove()` path) **after** confirming the snapshot rewrite
  itself succeeded. If the write failed, the refresh leaves the old snapshot
  and all cache entries untouched rather than purging bytes a still-served,
  now-stale-relative-to-Azure snapshot still points at. This is self-healing
  if ever wrong in the other direction (a later `put()` simply repopulates),
  so snapshot-key correctness — the priority per the requirement — is never
  compromised by a partially-applied purge.
- **The blob-cache purge bumps the mutation token before removing** (fixed in
  the post-PR automated review, see below): `SharedResourceCache.get()`
  captures a key's mutation token before an in-flight `inner.get()` and only
  commits the result if the token is unchanged when it finishes. Without the
  bump, a `get()` racing the purge could still win and resurrect the
  just-purged blob with no future purge pass ever noticing (the diff is a
  one-time `previousKeys` → `freshKeys` transition, not a standing
  invariant). Bumping first, mirroring `remove()`'s own tail exactly, closes
  that window.

## Consequences

### Positive

- Every online `GET /api/runs` / `GET /api/storage/runs` after the first
  warm returns instantly from disk, matching the guarantee `get()` already
  provided for blob bytes — closing the one gap that made cold
  worktree/extension/process opens feel "uncached."
- Same-process coherence is fully preserved: a `put()`/`remove()`/generate/
  approve/check-in still forces the very next `list()` for that prefix
  through the original blocking path until it resyncs.
- Listings self-correct in the background: a run added or removed by another
  process/worktree sharing the same cache directory is picked up by the next
  scheduled refresh without any caller ever blocking on it.
- No behavior change offline, and zero change to any blob-artifact
  (`get`/`put`/`remove`) semantics — this ADR touches exactly one method's
  online listing path.

### Negative (accepted trade-off)

- A run created, approved, or removed in **another** worktree/process may
  appear in this process's listing **one background-refresh late** (a few
  seconds), instead of on the very next request, until that background
  refresh completes. The maintainer explicitly accepts this bounded window
  in exchange for instant cold-open loads. Same-process mutations are
  unaffected (see above) — this window only applies to changes made by a
  different process sharing the same physical cache.
- The background refresh performs real filesystem I/O (`cache.set()` /
  `cache.remove()`), so its completion time is not instantaneous or
  deterministic in wall-clock terms; tests that need to observe its
  completion must poll an observable end-state rather than assume a fixed
  number of event-loop ticks (see `waitUntil` in
  `tests/unit/sprites/caching-run-store.test.ts`).

### Risks

- If a writer bypasses `CachingRunStore` entirely (writes directly to Azure
  without going through this store, so the shared epoch is never bumped),
  its change is invisible until the next scheduled background refresh
  happens to run — no different from ADR 0065's pre-existing
  cross-process-mutable-coherence risk for blob artifacts.
- The purge loop assumes the previous snapshot's key list is complete and
  accurate; if it purges a key that a concurrent same-process `put()` just
  re-added, the epoch-stable guard on the snapshot rewrite prevents a stale
  snapshot from landing, but a narrow window exists where the purge's
  `cache.remove()` for the blob entry could still fire after that `put()`'s
  own write-through. This is bounded and self-healing (a subsequent `get()`
  simply misses and re-populates from `inner`), consistent with how the
  cache already treats blob-cache entries as advisory rather than
  authoritative.
- **Accepted, monitored: an `inner.list()` call that never settles pins the
  per-prefix dedup slot in `listRefreshInFlight` forever.** Nothing today
  bounds the Azure SDK call with a timeout/`AbortSignal`, so a hung
  `inner.list()` means `scheduleListRefresh()` will keep seeing an
  already-in-flight entry for that prefix and never schedule another
  refresh — callers keep getting fast-path responses, but the snapshot for
  that prefix silently stops revalidating until the process restarts. This
  is not a new failure mode: the pre-SWR blocking `list()` had the identical
  "an Azure call can hang indefinitely" exposure, it just hung the caller
  directly instead of only the background refresh. A proper fix
  (`AbortSignal`-based timeout, releasing the dedup slot on expiry) would
  require threading a cancellation contract through the `RunStore`
  interface and every implementation (Azure, Local) — disproportionate scope
  for this change's 🍎🍎🍎 tier — and a naive `setTimeout` bound risks a
  second, subtler bug (an abandoned-as-timed-out refresh completing later
  and double-publishing). Deferred rather than fixed here; flagged for a
  follow-up if a hung listing is ever observed in practice.

## Alternatives Considered

1. **Always serve any warmed snapshot instantly, regardless of epoch** —
   rejected: this would break same-process read-your-writes coherence (a
   `put()` immediately followed by a `list()` in the same process could
   return pre-mutation keys), which none of the existing six `list()` tests
   would tolerate.
2. **Time-boxed staleness (serve snapshot if captured within N seconds)** —
   rejected: this requires a `Date.now()` dependency in listing logic, which
   the project's determinism rules forbid for anything on a code path
   covered by deterministic tests, and adds a magic-number tuning knob for
   no behavioral benefit over the epoch gate.
3. **Azure Event Grid / Queue subscription to invalidate listings
   cross-process in near-real-time** — rejected as disproportionate
   infrastructure for a tolerated few-seconds staleness window; the
   dominant cost (Azure Storage) does not offer this without additional
   resources and wiring that the bounded requirement does not call for.
4. **Skip the background refresh's blob-cache purge, only rewrite the
   snapshot** — considered as a smaller diff, but rejected since the purge
   is cheap (bounded by the size of one prefix's key diff), fully
   self-healing if it ever races incorrectly, and directly implements the
   "background checker for updates / cache purging" half of the maintainer's
   requirement rather than leaving it partially unaddressed.

## Cross-links

- [ADR 0065: Shared Azure Resource Cache](0065-shared-azure-resource-cache.md) —
  the base cache this ADR amends; only the "List snapshots" online-consult
  sentence is superseded, everything else remains authoritative.
- `scripts/sprites/store/caching-store.ts` — implementation.
- `scripts/sprites/store/types.ts` — the `RunStore.list()` interface and its
  `ListOptions`/`authoritative` escape hatch.
- `scripts/sprites/sidecar/server.ts` — the 4 destructive routes (5 call
  sites) that pass `{ authoritative: true }`.
- `tests/unit/sprites/caching-run-store.test.ts` — the `list snapshots`
  describe block covers the epoch-fresh fast path, dedup, error-swallowing,
  purge behavior (including the mutation-token-bump race), and the
  `authoritative` bypass; `tests/unit/sprites/sidecar-offline-cache.test.ts`
  covers the (unchanged) offline hard-gate.
