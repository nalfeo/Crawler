# Session Handoff: Shared Azure resource cache

## Date

2026-07-20

## Persona

Producer → Tools Engineer

## Systems touched

azure-infra, sprite-workflow, devtools

## Apples

4🍎 estimated, 4🍎 actual (exact — cross-process storage, sidecar semantics,
extension consolidation, concurrency hardening, and full tier-4 review).

## What Was Done

Replaced the fragmented Azure sprite caches with one user-level,
content-addressable cache outside every worktree:

- Added `SharedResourceCache`, backed by `cacache`, under
  `$COPILOT_HOME/crawler/azure-resource-cache` by default. Azure identities use
  non-secret key prefixes inside one physical cache, so all accounts/containers
  share one global 5 GiB budget without sharing logical entries.
- Implemented true access-based LRU over unique physical content. Reads refresh
  recency; deduplicated bytes count once; list snapshots are evicted after normal
  artifacts; every successful write returns with the global content budget
  enforced.
- Serialized every cache write, removal, and physical-content reclamation behind
  one cross-process async lock with owner tokens, heartbeat, and stale-owner
  recovery. This prevents a prune from deleting content while another session
  adds a deduplicated reference.
- Reworked `CachingRunStore` to cache every sprite-run artifact category except
  the ETag-controlled workflow queue document. Writes are coherent,
  route-derived snapshots are invalidated by source mutations, and online list
  fallback accepts only a matching shared mutation token.
- Added exact brief and slice-map response snapshots. Only durable
  store-backed brief bytes can populate the global response cache, preventing a
  branch-local brief from poisoning other worktrees.
- Converted every vendored extension `image-cache.mjs` to a pass-through relay.
  Sprite review, workflow, postprocess, storage, achievements, and sprite editor
  now all rely on the sidecar-authoritative cache instead of persisting duplicate
  extension-owned copies.
- Added canonical and legacy environment controls for enablement, cache
  directory, size cap, and forced-offline operation. Documented the architecture
  in ADR 0065 and `infra/README.md`.
- Broad guard validation exposed and fixed a pre-existing Windows portability
  defect in `preflight-lib`: injected POSIX/Git-Bash executable paths now resolve
  correctly on Windows, and Chromium cache tests use platform-native joins.

## Observe Before Done

The real artifact for this infrastructure change is the sidecar plus its
filesystem cache. Deterministic route tests use two separate `CachingRunStore`
and sidecar instances over one physical temp cache:

- **Before:** a second worktree needed Azure and its own source brief/palette
  files; extension processes also wrote duplicate unbounded disk caches.
- **After:** the second sidecar has an inner store that throws on every read and
  an empty source tree, yet returns the exact warmed run listing, brief response,
  and slice-map response with the remote read counter remaining zero.
- Global-cap tests use distinct Azure namespaces and concurrent cache instances;
  total unique content remains at or below the configured cap, and an access hit
  changes the eviction victim.

## Key Decisions Made

- **Sidecar-authoritative cache, not shared raw extension files.** The adversarial
  plan review rejected independent TypeScript/MJS cache implementations sharing
  a directory as incoherent and difficult to bound.
- **One physical cache with namespaced keys.** Per-namespace directories would
  allow each Azure identity to consume 5 GiB; key prefixes preserve isolation
  while one lock and one budget enforce the user's singular-cache requirement.
- **Exact derived response snapshots.** Reconstructing slice maps from cached
  sheets alone was not exact because `loadBrief` also depends on worktree palette
  and type-default files.
- **Online listings revalidate; explicit offline mode does not.** This avoids
  indefinitely stale snapshots from external Azure writers while preserving the
  zero-read offline gate.

## Review Harness

Tier 4 ledger:
`docs/knowledge/review-ledgers/2026-07-20-shared-azure-cache.review-ledger.json`.

- Adversarial plan review: major architecture fork, 7/7 concerns resolved.
- Two-round code review: 8/8 concerns resolved.
- Two-model review (`claude-opus-4.8`, `gemini-3.1-pro-preview`) with `gpt-5.4`
  adjudication: all validated concurrency, provenance, invalidation, and
  performance findings resolved.

## What's Next / Blockers

No known blockers. CI owns the full suite; local fast verification and focused
sprite/extension suites are green.

## Retrospective

### Lessons Learned

- A global content cap requires a global maintenance boundary; namespace
  directories quietly multiply the promised budget.
- Cross-worktree derived data is safe to share only when every input has durable,
  shared provenance.
- `cacache.verify()` is maintenance tooling, not a live multi-process
  invalidation primitive. Targeted cleanup under the same lock as writes avoids
  both full-cache scans and dangling deduplicated references.

### Mistakes Made

- The first implementation applied the 5 GiB cap per namespace and pruned only
  after a write threshold, so production behavior did not satisfy the hard cap.
- The first offline brief test still read YAML from the second worktree, and the
  first slice-map design assumed source-tree dependencies were reproducible.
- Early lock acquisition busy-spun on the Node event loop; review caught and
  replaced it with async contention plus owner-token safety.

### Opportunities for Future Improvement

- If cache cardinality becomes very large, persist an incremental size/recency
  index to avoid scanning `cacache` entries during prune while preserving the
  same global locking contract.
