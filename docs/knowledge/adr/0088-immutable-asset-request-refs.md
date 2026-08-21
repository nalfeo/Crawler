# ADR 0088: Immutable asset request refs replace the mutable `assets/queue`

## Status

Accepted

## Date

2026-08-21

## Estimated Complexity

🍎 x 3 estimated. A new self-contained tooling module family under
`scripts/sprites/asset-requests/` (manifest contract, publisher, reconciler,
migration classifier, CLI), a fail-closed freeze switch on the legacy writer,
and real-git unit coverage. Tooling-only, so the 3🍎 tooling ceremony cap
applies; no runtime gameplay code changes.

## Context

`assets/queue` is a long-lived **mutable aggregate branch** used simultaneously
as a work queue and as a data store. Every publisher force-updates the same tip
with a compare-and-swap, and the reconciler promotes whatever the tip currently
holds.

Two properties of that design are load-bearing failures:

1. **Aggregate state ages.** The tip accumulates entries written under older
   sprite naming/versioning conventions. A migration that renames or re-versions
   generated assets on `main` leaves the queue holding paths that no longer
   correspond to anything, and the reconciler cannot tell "new art" from
   "stale art re-asserting an old name".
2. **Blast radius is the whole branch.** A single destructive maintenance
   operation edits the shared aggregate. The 2026-08 corruption (`1c1243b`)
   deleted 1,028 generated paths after a duplicate-prune, and the queue had to
   be reconstructed by hand from current `main`, the coherent `acc25eda` editor
   batch, and a human retention decision.

The immediate repair added deletion detection and removal manifests to the
existing reconciler. That reduces the chance of a repeat, but the architecture
still routes every asset mutation through one mutable shared object.

## Decision

Model each asset mutation as an **immutable, independently verifiable Git
request ref** — `refs/heads/assets/request/<request-id>` — and make
reconciliation a pure function of `origin/main` plus the set of unresolved
requests.

### Request contract (`scripts/sprites/asset-requests/manifest.ts`)

A request commit is an **orphan** containing exactly its manifest
(`assets/requests/<id>.json`) plus its declared payload — nothing else.

- The request ID is **content-derived**: SHA-256 over the canonical JSON of the
  manifest body. `parseAssetRequest` re-derives it and refuses any manifest
  whose ID does not match, so a request cannot be edited in place.
- `sourceCommit`, `sourceRun`, `briefId`/variant identity, producer identity and
  deterministic creation metadata are all sealed into that body.
- Operations are narrow: `add-asset` / `replace-asset` (PNG + shard travel
  atomically, `contentHash` must equal the PNG bytes), `update-annotations`
  (**per-key** updates only, never a whole-document blob), and `remove-asset`
  (requires an explicit same-content duplicate proof).
- `observedMain` records the `main` SHA the request was authored against.

### Reconciler (`scripts/sprites/asset-requests/reconcile.ts`)

`materializeAssetRequests()` always starts from a throwaway worktree at current
`origin/main` — it never overlays a previous aggregate result. Per request it
validates, in this order: seal → declared-tree match → already-on-main →
`observedMain` ancestry → destination staleness → payload/shard integrity →
removal proof. Anything that fails yields a **per-request refusal reason**, not
a silent skip.

Requests that pass are partitioned by destination unit (a repo path, or
`<annotations path>#<key>` for annotations). Two requests claiming one unit with
different content are **both refused** as `request-conflict`; identical content
collapses to one winner and `duplicate-request` for the rest. The materialized
tree is asserted to touch only the art surface, then pushed as the single
`assets/promote` branch with `Promotion-Base:` and `Asset-Request:` trailers
naming every consumed request and its source SHA.

`archiveConsumedRequests()` runs **only after the promotion is proven merged**:
it copies each consumed ref to `assets/archive/request/<id>` and then deletes
the live ref under a lease, so a crash between the two steps cannot lose a
request and a re-run cannot double-consume one.

### Cutover (`scripts/sprites/asset-requests/migrate-queue.ts`)

`SPRITES_ASSET_QUEUE_FROZEN=1` makes `runQueueCommit` fail closed with an
actionable message before it touches git — including for the trusted CI
publisher, because no writer may extend a frozen queue. `classifyQueueTip()`
then produces a deterministic report classifying **every** path and annotation
delta on the final queue tip as `already-on-main`, `safe-request`,
`naming-migration-conflict`, `invalid-pair`, or `requires-human`; the report is
only complete when `unclassifiedPaths` is empty. Only human-approved
`safe-request` groups are converted into request refs, each carrying the
originating queue SHA as its `sourceCommit`.

## Consequences

- **Positive.** A request cannot touch anything it did not declare, cannot
  overwrite bytes that changed on `main` after it was authored, and cannot
  delete a generated path without a source-bound duplicate proof. Replay from
  the same request set and the same base yields a byte-identical promotion tree
  (fixed identity + fixed commit date), so the promotion is auditable and
  reproducible.
- **Positive.** Failures are per-request and actionable instead of
  whole-queue. One bad request no longer blocks or corrupts unrelated art.
- **Negative.** More refs. A high-volume generation wave creates one ref per
  change instead of one aggregate commit; the archive ledger keeps them around
  for audit. This is the intended trade — refs are cheap, silent corruption is
  not.
- **Negative.** The cutover is staged and cannot be fully automated. Converting
  the final queue tip requires a human disposition pass over the classifier
  report, which is deliberate: semantic art conflicts stay human decisions.

## Non-goals

- Replacing Git with Azure storage as the durable approval source.
- Rewriting historical generated assets solely to standardize names.
- Automatically resolving semantic art conflicts.

## Alternatives considered

- **Harden the existing queue further** (more guards on the same mutable
  branch). Rejected: every guard added so far addressed a symptom of the shared
  mutable aggregate, and the aggregate itself is the hazard.
- **One request per branch but mutable** (allow amend/force-push to fix a
  request). Rejected: mutability is exactly what makes "which bytes did the
  reconciler actually see?" unanswerable. Corrections create a new superseding
  request instead.
- **Azure queue as the source of truth.** Rejected as an explicit non-goal —
  approval provenance must stay in Git where it is reviewable and replayable.
