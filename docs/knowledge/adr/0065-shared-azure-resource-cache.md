# ADR 0065: Shared Azure Resource Cache (content-addressable, LRU, offline-capable)

## Status

Accepted

## Date

2026-07-20

## Estimated Complexity

🍎🍎🍎🍎 — one new cross-process cache module plus a rewrite of the RunStore
caching wrapper and removal of four+ per-extension caches; touches azure-infra,
sprite-workflow, and devtools.

## Context

Two independent, uncoordinated caches had grown up around the Azure-backed
sprite pipeline:

1. **`CachingRunStore`** — a bespoke filesystem-mirror that cached ONLY immutable
   sheet PNGs, capped at 2 GiB with oldest-write (not access-based) eviction, and
   had no offline/list-fallback behavior.
2. **Four+ per-extension image caches** — each canvas extension
   (`sprite-review`, `workflow`, `postprocess`, `storage`, …) vendored an
   `image-cache.mjs` that kept its OWN unbounded on-disk cache under
   `$COPILOT_HOME/extensions/<ext>/cache`. The same sheet bytes were therefore
   stored once per extension, uncapped, with no shared eviction.

This is impossible to bound or keep coherent, and it does not survive Azure
being unavailable: a warmed worktree could not reliably continue offline, and
listings/briefs/slice-maps had no offline path at all.

The approved requirement: ONE cache, outside worktrees/source, shared across
sessions and all relevant extensions; cache-first reads that continue from
warmed resources when Azure is unavailable; true LRU with a default 5 GiB cap;
and a hard gate proving a second worktree can load the exact same artifacts and
listing with **zero Azure read operations**.

The adversarial plan review REJECTED letting independent TypeScript and vendored
MJS caches share raw files (fragile, un-bounded, incoherent) and mandated a
single authoritative cache behind the sidecar.

## Decision

### Sidecar-authoritative, content-addressable cache

`scripts/sprites/store/shared-cache.ts` (`SharedResourceCache`) is the ONE
canonical cache. Storage is delegated to **`cacache`** (the npm/pacote
content-addressable cache): atomic content writes, SRI integrity verification,
lockless concurrent reads/writes, and automatic dedupe. We do not reimplement
any of that, and we do NOT use Node 22/24's built-in `node:sqlite` (still
experimental at this repo's Node version).

The devtools **sidecar** constructs a single `CachingRunStore` over Azure and
serves every extension/canvas proxy from it. Extensions became **thin
proxies**: their vendored `image-cache.mjs` is now a pass-through relay that
NEVER writes to disk (public API and response shapes unchanged so no extension
code changed). The per-extension disk caches are gone.

### Namespacing by non-secret identity

All remote identities share one physical `cacache` at `<baseDir>`. Every logical
key is prefixed by `namespace =
sha256(host \n account \n container).slice(0,16)`. Only the blob endpoint host,
account name, and container feed the hash — never a storage key or connection
string. This isolates Azurite/dev/prod and different accounts while one global
lock and one global 5 GiB budget govern the user's entire cache.

### Typed semantics over one physical cache

- **Blob artifacts** (sheets, raw/processed variants, brief snapshots, metadata,
  judge output, scorecards, summaries, derived previews): cache-first
  `get`/`has`; write-through `put` (authoritative inner write first, THEN cache
  replace); `remove` invalidates the cache before the authoritative delete.
  Artifacts are NOT assumed immutable — a `put` replaces the cached key. The ONE
  excluded key is the mutable, ETag-controlled workflow queue document (key `WORKFLOW_STATE_KEY`,
  i.e. the queue.json under the workflow-state prefix).
- **List snapshots**: a successful online `list` stores an eviction-protected
  snapshot tagged with a shared **invalidation token**. Online calls still
  refresh from Azure so an external writer cannot leave an indefinitely stale
  result. Online fallback accepts only a matching token; explicit offline mode
  serves the warmed snapshot with zero remote reads.
- **Brief / slice-map routes** store exact derived-response snapshots in the
  same content-addressable cache when the brief input matches its durable
  store-backed bytes. Branch-local inputs are served but never admitted to the
  global cache. A second worktree therefore needs none of the source brief,
  palette/type-default files, summary, or sheet to return an exact warmed
  response while offline.
- **Offline mode** (`CRAWLER_AZURE_OFFLINE=1`): reads are served ONLY from the
  cache; the inner store is never contacted, giving the hard-gate guarantee.

### True access-based LRU over unique content

Recency is tracked with per-key access-marker files whose mtime is the last
access; a cache HIT refreshes recency, so hits change the eviction victim. The
global cap (default exactly `5 * 1024^3`) applies to UNIQUE physical content
across every remote namespace — deduped by SRI integrity, so a blob referenced
by two keys counts once. Every successful write runs prune before returning.
Prune evicts least-recently-accessed keys until unique content is under the cap,
reclaiming content only when its last referencing key is removed. Listing
snapshots are evicted after ordinary artifacts. Prune is serialized across
processes by one global **lock directory** with stale-owner recovery. Writes,
entry removal, and content reclamation all participate in that lock so a
deduplicated blob cannot be deleted while another process references it.
Contenders wait asynchronously and never block the Node.js event loop.

### Environment variables

`CRAWLER_AZURE_CACHE` (on/off), `CRAWLER_AZURE_CACHE_DIR` (base dir; default
`$COPILOT_HOME/crawler/azure-resource-cache`), `CRAWLER_AZURE_CACHE_MAX_BYTES`
(default 5 GiB; `0` = unbounded), `CRAWLER_AZURE_OFFLINE`. Legacy
`SPRITES_AZURE_CACHE`, `SPRITES_AZURE_CACHE_DIR`, `SPRITES_AZURE_CACHE_MAX_BYTES`,
and `SPRITES_AZURE_OFFLINE` remain honoured as aliases.

## Consequences

### Positive

- One physical copy of each blob across all worktrees, sessions, and extensions.
- Bounded (true LRU, unique-content) instead of four+ unbounded caches.
- A warmed worktree serves exact bytes AND listings with zero Azure reads.
- Backward-compatible RunStore and extension APIs; no extension code changed.
- Corruption, traversal, and read-only/full-disk failures degrade to a miss/
  pass-through and never break serving.

### Negative

- Adds `cacache` (+ `@types/cacache`) as dependencies.
- The old fs-mirror layout (human-browsable `briefId/runId/sheet.png` files) is
  replaced by cacache's opaque content store.

### Risks

- **Cross-process mutable coherence**: same-process mutations stay coherent via
  write-through; a blob overwritten in Azure by a truly external writer that does
  not go through `CachingRunStore` could be served stale until re-put. Bounded
  and documented; the local/devtools workflow routes all writes through the
  wrapper.
- **Derived-response freshness**: brief and slice-map responses are per-route
  snapshots. They are intended for immutable completed runs; replacing artifacts
  in-place can require eviction or a new run id before the route snapshot changes.

## Alternatives Considered

1. **Keep independent TS + per-extension MJS caches sharing raw files** —
   rejected by adversarial review: unbounded, incoherent, fragile.
2. **Node built-in `node:sqlite` index** — rejected: experimental at this Node
   version.
3. **Reconstruct brief/slice-map only from cached blobs** — rejected after
   implementation review: `loadBrief` also depends on source-tree palette and
   type-default files, and the pre-existing brief mirror is path-level
   last-writer-wins rather than per-run. Exact route snapshots provide the
   deterministic offline guarantee.
4. **Insert-time (not access-time) eviction** — rejected: does not honour the
   access-based LRU requirement (a hit must change the victim).
