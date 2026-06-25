# ADR 0017: Azure-backed sprite workflow-state persistence

## Status

Accepted

## Date

2026-06-24

## Estimated Complexity

🍎 x 4 — touches the sidecar, the `RunStore`/Azure layer, and the devtools client, plus
tests and an E2E loop. No new ECS system, so no lab is required.

## Context

The sprite-generation **workflow** (the DevTools "Sprite Generation Workflow" page) drives each
sprite from a one-line brief through synthesize → choose → promote → generate → approve → tag.
Two kinds of artifact are already durable:

- **Run outputs** (sheets, processed variants, scorecards, summaries) live in the `RunStore`,
  which is Azure Blob Storage (`generated-runs` container) when `SPRITES_RUN_STORE=azure-blob`.
- **Generation jobs** are enqueued on the Azure Storage Queue `asset-requests` and consumed by the
  worker.

But the **workflow state itself** — the queue of in-progress items, their stages, the chosen
candidate path, candidate YAML, approval pointers — is durable only in the browser:

- Queue items + candidate YAML → `localStorage['crawler.devtools.sprite-workflow-queue.v1']`.
- Workflow UI prefs (filters, debug target) →
  `localStorage['crawler.devtools.sprite-generation-workflow-state.v1']`.
- Draft brief YAML used by promote + generate → `briefs/draft/<type>s/<name>.yaml`. That directory's
  `.gitignore` is `*` + `!.gitignore`, so **every draft is untracked**.

In a Copilot worktree session, a checkpoint wipes browser `localStorage` and untracked working-tree
files. The result: an operator who is halfway through generating ten sprites loses the entire
backlog and any un-promoted/un-committed briefs, even though the expensive run outputs survived in
Azure. The official, git-tracked state (committed briefs + `sprite-catalog.json`) is the _end_
state; nothing carries the _in-progress_ state across a wipe.

## Decision

Make the **sidecar the source of truth** for workflow state and persist it through the existing
`RunStore` abstraction, so it lands in Azure Blob Storage exactly like run outputs already do.
`localStorage` is demoted to a best-effort cache for instant first paint and offline use.

### 1. Reuse `generated-runs` under a `workflow-state/` key prefix

No new container or infra for v1. Workflow state is stored at the blob key
`workflow-state/queue.json`. The existing run-listing logic (`listRunsFromStore`) only matches
3-part `<briefId>/<runId>/summary.json` keys, so `workflow-state/*` keys never pollute `/api/runs`.

### 2. New sidecar endpoints

- `GET /api/workflow/state` → `{ state, etag }` (`{ state: null, etag: null }` when absent).
- `PUT /api/workflow/state` → body `{ state }`, optional `If-Match` request header.
  - Precondition mismatch → `409 { error: 'etag-conflict', etag: <current> }`.
  - Success → `200 { ok: true, etag: <new> }`.

Both are backed by the injected `store`, so they automatically follow `SPRITES_RUN_STORE` (local
for tests/offline, Azure in production) with no endpoint-level branching.

### 3. Store-agnostic content-hash ETag for optimistic concurrency

The ETag is `sha256(storedBytes)` computed by the sidecar, **not** the Azure blob's native ETag.
This keeps optimistic concurrency identical on `LocalRunStore` and `AzureBlobRunStore` and requires
**no change to the `RunStore` interface** (`put/get/has/list/remove/resolve/backend`). The hashing
and precondition logic live in a pure, unit-tested module (`scripts/sprites/sidecar/workflow-state.ts`).

### 4. Client: cache-first paint, then hydrate from the source of truth

`render()` in `devtools-main.ts` stays synchronous and paints immediately from the `localStorage`
cache. An async `hydrateQueueFromSidecar()` then `GET`s `/api/workflow/state`; if the sidecar is
reachable and has state, it replaces the in-memory queue, records the `etag`, re-renders, and
restarts auto-resume polling for any item still `generating`. Every mutation keeps writing
`localStorage` (cache) **and** issues a debounced write-through `PUT` with `If-Match`. On `409` the
client re-`GET`s, adopts the server `etag`, and retries once.

### 5. Durable draft briefs (Phase 2)

Synth candidates and promoted briefs are mirrored into the store under
`workflow-state/briefs/<repo-relative-posix-path>`. `promote-brief` and `generate` re-materialize a
missing local file from the store before use, so a mid-flight generate survives a wipe.

### 6. Single global queue

One blob (`workflow-state/queue.json`) backs one global team backlog — no per-session partitioning
in v1. Revisit if concurrent operators on separate sessions need isolated queues; the ETag conflict
path already prevents silent clobbering if two clients share the global blob.

## Consequences

### Positive

- In-progress workflow state survives worktree checkpoints, page refreshes, and sidecar restarts.
- Zero new infrastructure — reuses the provisioned `generated-runs` container.
- Optimistic concurrency works identically across local and Azure backends.
- `localStorage` cache keeps first paint instant and the UI usable when the sidecar is down.

### Negative

- Workflow state now depends on the sidecar being reachable to be durable; a fully offline session
  only has the localStorage cache (acceptable — matches the existing "start the sidecar" model).
- A single global blob means two simultaneous operators share one backlog (intended for v1).

### Risks

- **Last-writer-wins under conflict.** With one global blob and the retry-on-409 path, a true
  concurrent edit from two tabs resolves to last-writer-wins. Acceptable for a single-operator team
  backlog; per-session partitioning is the escape hatch if it ever bites.
- **Blob/JSON growth.** The queue embeds candidate YAML; very large backlogs grow the blob. The
  payload is small text and bounded by operator backlog size, so this is not a v1 concern.

## Alternatives Considered

- **Azure-native blob ETags.** Rejected: would leak Azure semantics into the `RunStore` contract
  (or require a parallel typed channel) and wouldn't work for the local backend used by tests.
- **A dedicated `workflow-state` container / table / Cosmos DB.** Rejected for v1: new infra and
  provisioning for a single small JSON document. The `workflow-state/` prefix on the existing
  container is sufficient and reversible.
- **Keep localStorage as source of truth, sync opportunistically.** Rejected: it doesn't fix the
  bug — the wipe destroys localStorage, so the source of truth must live server-side (Azure).
- **Per-session queue partitioning.** Deferred: adds key/routing complexity with no current driver;
  the global queue matches how the team uses one shared backlog today.

## Validation

Validated end-to-end against **fully real Azure** (the `generated-runs` blob store + the
`asset-requests-e2e` queue + live `gpt-image-1` generation), driven headless with Playwright over
10 sprites. Final state: **10/10 items durable at `variants`** in the blob.

- **Page-refresh resume** — 12 refreshes re-hydrated every item and stage from
  `workflow-state/queue.json`, byte-identical each time.
- **Sidecar process-restart resume** — a fresh sidecar process returned the identical state with the
  **identical content-hash etag**, proving the state reloads entirely from the blob (no in-memory
  source of truth).
- **Auto-resume from `generating`** — items left mid-flight were re-hydrated by a fresh page whose
  run-polling found the matching Azure runs and rebuilt each `item.run` to `variants`.
- **Half-done switching** — with items deliberately regressed to mixed stages (`candidates` /
  `promoted` / `variants`), switching the selection across them resumed each at its own stage with
  the selection persisted to Azure.
- **Phase 2** — promoted-draft and synth-candidate YAML were confirmed mirrored under
  `workflow-state/briefs/**` and re-materialised when the local fs copy was absent.

The persistence guarantee is independent of vision scoring; the final resume cycles ran the worker
vision-off (`E2E_VISION=off`) as zero-cost state manipulations. While validating, a latent
azure-blob judge-path crash was discovered and fixed (the judge sidecar wrote to a blob-URL path →
`ENOENT`); the fix guards `processedDir` to local stores only and is covered by a deterministic
regression test in `tests/integration/judge-pipeline.test.ts`.

(Phase 3 — the UI-prefs blob write-through — remains the designed-optional follow-up and was not
required for the durability guarantee above.)
