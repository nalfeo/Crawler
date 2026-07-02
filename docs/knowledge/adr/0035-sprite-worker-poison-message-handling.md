# ADR 0035: Sprite worker poison-message handling (bounded failures, comment-once)

## Status

Accepted

## Date

2026-07-02

## Estimated Complexity

🍎 x 4 — changes the queue↔worker failure contract (2 systems: `scripts/sprites/queue/*`
and `scripts/sprites/worker.ts`), is coupled with a generation-prompt fix in
`scripts/sprites/build-prompt.ts`, and needs deterministic regression tests, but adds no
new lab (script/pipeline code).

## Context

The sprite-generation worker (`scripts/sprites/worker.ts`) polls an `AssetQueue` and calls
`generateOne` / `runIssuePipeline` for each dequeued request. The original design
**intentionally never acked a message when processing threw**, relying on the Azure Storage
Queue visibility timeout to re-surface the message for a "natural retry".

For a **deterministic** failure this is actively harmful:

- The same request re-runs the **full** pipeline every visibility timeout (~3 minutes),
  burning `gpt-4o` + `gpt-image-1` API calls indefinitely — an unbounded-cost poison loop.
- For issue-originated jobs, `runIssueRequest` posted a "⚠️ Asset-request pipeline failed"
  comment to the source GitHub issue on **every** retry. Incident issue #555 accumulated
  **12** duplicate spam comments.

The triggering deterministic failure was a slice-gate mismatch: every issue-request died at
`scripts/sprites/generate-one.ts` with `ProviderError('bad-grid', 'expected 16 cells,
slicer produced 8')`. That specific mismatch is fixed separately in the prompt builder (the
content-aware slicer in `scripts/sprites/slice-sheet.ts` infers the grid from background
bands, so the sheet prompt must mandate a background gutter between every row and column).
But **any** future deterministic failure — an unparseable brief, an auth error, a
persistent bad grid — would reproduce the same runaway loop and comment spam. The worker
needs a failure contract that bounds cost and notifications independently of the specific
error.

## Decision

Give the worker a **bounded-failure policy** driven by the queue's redelivery count.

1. **Surface redelivery count on the queue contract.** Add a required
   `readonly dequeueCount: number` to `DequeuedMessage` (`scripts/sprites/queue/types.ts`).
   `scripts/sprites/queue/azure-queue.ts` reports Azure's native `dequeueCount` (1 on first
   receive, incrementing on each visibility-timeout re-surface). Making it **required**
   forces every backend to participate in poison handling; backends that cannot track
   redelivery report `1`.

2. **Classify permanent vs transient failures.** A failure is treated as **permanent**
   (never worth retrying) when its `kind` is one of `auth`, `bad-grid`, or `non-png`. This
   is duck-typed on `err.kind` (not `instanceof ProviderError`) so it also covers the synth
   / vision / text provider error families, which surface an `auth` kind too. `bad-grid` and
   `non-png` are already exhausted by `generateSheetCore`'s in-run retries before the error
   reaches the worker, so re-running the whole pipeline cannot help. Nondeterministic kinds
   (`rate-limit`, `network`, `provider-error`, synth `malformed`, or any plain `Error`) are
   **not** classified permanent — they get bounded natural retries.

3. **Give up on a permanent error, or once `dequeueCount` reaches
   `MAX_DEQUEUE_ATTEMPTS = 3`.** On give-up the worker **acks (drops)** the message so it
   can never loop again. Below the cap, a transient failure is left un-acked (natural retry)
   and posts **no** comment.

4. **Comment at most once per message.** The "⚠️ pipeline failed" comment is moved OUT of
   `runIssueRequest` and into the worker's single give-up branch, gated behind
   `issue-request` kind. On give-up the worker **acks first, then posts the comment only when
   the ack actually succeeded.** Because a successful ack deletes the message, it can never be
   redelivered, so the comment posts on at most one delivery. If the ack itself throws (e.g. a
   stale pop receipt after the visibility timeout expired mid-run) the worker swallows the
   error, posts **no** comment, and leaves the message to resurface for a bounded retry — the
   single comment is then posted on whichever later delivery's ack succeeds. Acking before
   commenting (rather than the reverse) means a comment failure can never block the ack that
   stops the loop, and a redelivery caused by an ack failure cannot double-comment. The
   comment text is honest about the outcome (the request was dropped and will NOT auto-retry),
   distinguishing "looks permanent" from "hit the delivery cap".

This applies uniformly to both `brief-path` and `issue-request` jobs (brief-path drops
silently — it has no issue to comment on).

5. **Suppress intermediate progress comments on redeliveries.** `runIssuePipeline` posts three
   live-progress comments (🧪 synthesize, 🧠 select, 📌 promote) before the pipeline can throw.
   On a transient failure that recurs, a natural retry would re-post all three. `runIssuePipeline`
   now takes `postProgressComments` (default `true`); the worker passes `dequeueCount <= 1`, so
   only the **first** delivery shows live progress and redeliveries stay quiet. The terminal "✅
   complete" summary and the give-up "⚠️ failed" comment are unaffected — they always post
   (subject to the at-most-once rule above). This keeps the "comment spam" fix complete: neither
   failure nor progress comments repeat per retry.

## Consequences

### Positive

- A deterministically-failing message can no longer loop forever: cost is bounded to at most
  `MAX_DEQUEUE_ATTEMPTS` pipeline runs (one run for a clearly-permanent error).
- The issue receives **at most one** failure comment instead of one per redelivery.
- Transient infrastructure blips still get natural retries (up to the cap) before being
  dropped, so a one-off network error is not fatal.
- `WorkerStatus`'s `error` variant carries an optional `dropped?: boolean` for observability
  and deterministic test assertions (backward compatible).

### Negative

- Dropped messages are **gone** — there is no dead-letter queue yet. An operator who fixes
  the underlying brief must re-request the asset. This is acceptable: the failure comment
  tells them the request was dropped and why.

### Risks

- **At-most-once, not crash-proof exactly-once.** The give-up path acks before commenting and
  only comments when the ack succeeded, so an ack failure resurfaces the message **without**
  commenting and cannot double-notify. The one residual window is a process crash in the
  sub-second gap between a successful ack and the comment call: the message is already deleted,
  so that request is simply never commented on (under-notify, not spam). Either way the message
  cannot loop. A durable, crash-proof exactly-once guarantee was judged not worth the
  complexity (see Alternatives).
- `MAX_DEQUEUE_ATTEMPTS = 3` is a heuristic. If a genuinely transient class of failure
  routinely needs more than two retries, the cap may drop it prematurely; revisit the
  constant rather than removing the cap.

## Alternatives Considered

- **Durable store-marker / issue-fingerprint for exactly-once commenting.** Persist a
  "already commented" marker keyed by the issue fingerprint so a comment is guaranteed to
  post exactly once even across crashes. Rejected as over-engineered: the task requires "at
  most once", which `dequeueCount` + ack already guarantee under normal operation, and the
  marker adds a new durable-state dependency and its own failure modes.
- **Azure Storage Queue poison sub-queue / true dead-letter.** Move give-up messages to a
  dedicated poison queue instead of dropping them. Deferred: Azure Storage Queues have no
  native DLQ, so this means standing up and monitoring another queue. The `dequeueCount` cap
  plus the failure comment is simpler and sufficient for now; a poison sub-queue can be added
  later without changing the classification logic.
- **Loosen the slice gate / lower the expected variant count to make bad grids "pass".**
  Rejected outright — it violates repo rules #12/#13 (never weaken an explicit requirement to
  go green). The gate stays exact-count; the coupled fix makes the model reliably draw a
  sliceable grid, and this ADR ensures that if a sheet still mismatches, it fails **once and
  bounded** instead of looping.
