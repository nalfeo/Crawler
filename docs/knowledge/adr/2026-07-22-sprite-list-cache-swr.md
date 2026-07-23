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
      await this.cache.remove(`${BLOB_PREFIX}${removedKey}`);
      // A removed run's summary.json also invalidates that run's derived
      // brief/slice-map caches (mirrors the authoritative remove() path).
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
- `tests/unit/sprites/caching-run-store.test.ts` — the `list snapshots`
  describe block covers the epoch-fresh fast path, dedup, error-swallowing,
  and purge behavior; `tests/unit/sprites/sidecar-offline-cache.test.ts`
  covers the (unchanged) offline hard-gate.
