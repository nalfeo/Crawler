# ADR 0066: Sidecar-Owned Sprite Acceptance

## Status

Accepted

## Date

2026-07-20

## Estimated Complexity

🍎 x 4 — spans the sprite sidecar, asset check-in, and workflow canvas with new mutation and idempotency contracts.

## Context

The project-scoped Sprite Generation Workflow canvas can inspect generated runs but cannot accept a variant. The required operator flow is one action that approves the selected variant, publishes it to the `asset-checkin` queue, and visibly reports the queued result without a CLI step.

- **CTX-001**: Approval writes the generated manifest, catalog, and PNG through the sprite sidecar.
- **CTX-002**: Check-in is a global worktree operation. It compares all approved art with `origin/main`, pushes an asset branch, and files an `asset-checkin` issue.
- **CTX-003**: A canvas instance is not an authority for global mutation state. Multiple panels, extension reloads, and the DevTools monolith can operate against the same sidecar.
- **CTX-004**: Open `asset-checkin` issue payloads are the durable queue record consumed by asset-PR consolidation.
- **CTX-005**: Mutating loopback routes require request authentication because binding to `127.0.0.1` alone does not prevent browser-origin requests.

## Decision

The sprite sidecar will own an atomic accept operation that serializes approval and check-in under one process-wide mutex.

- **DEC-001**: Asset check-in preparation will exclude assets already represented by open `asset-checkin` issue payloads. This makes repeated and later check-ins idempotent across processes and sessions.
- **DEC-002**: The sidecar accept operation will reconcile an `already-approved` response against the durable queue record. An already-queued asset returns the existing queued result; an approved but unqueued asset proceeds to check-in.
- **DEC-003**: The workflow canvas will remain a thin client. Its loopback mutation route will require an unguessable per-instance token before forwarding the selected brief, run, and variant to the sidecar.
- **DEC-004**: The canvas will display explicit approving, checking-in, queued, already-queued, and actionable failure states. Concurrent acceptance controls remain disabled while the sidecar transaction is active.
- **DEC-005**: Existing `/api/approve` and `/api/checkin` routes remain available for compatibility. The new operation composes their domain functions rather than spawning CLI subprocesses.

## Consequences

### Positive

- **POS-001**: One sidecar-wide lock coordinates every canvas instance and prevents concurrent check-in races.
- **POS-002**: Open issue payloads provide durable duplicate detection across extension and sidecar restarts.
- **POS-003**: The workflow canvas gains a one-click acceptance path without duplicating Git, GitHub, or approval logic.
- **POS-004**: Existing CLI and DevTools workflows benefit from queued-asset filtering when they call the shared check-in runtime.

### Negative

- **NEG-001**: Check-in now performs a GitHub issue-list read before creating a branch and issue.
- **NEG-002**: The sidecar API gains a composite mutation whose response must represent partial and already-completed states.
- **NEG-003**: The canvas must manage a per-instance request token in its rendered document and loopback server.

### Risks

- **RSK-001**: Genuinely malformed issue payloads (fail `parseAssetIssueBody`) cannot
  participate in deduplication and are ignored entirely. A well-formed but pre-hash
  legacy payload (missing `contentHash`, see AMD-003) DOES still participate at the
  assetPath level — it fails closed (409) rather than being silently skipped.
- **RSK-002**: A remote mutation may succeed while its HTTP response is lost; retry reconciliation must consult open issues before creating another check-in.
- **RSK-003**: Check-in remains intentionally batched. The UI must show the prepared asset count so operators know when one acceptance publishes other approved, unqueued art.

## Alternatives Considered

### Compose Approval and Check-In in the Canvas Extension

- **ALT-001**: **Description**: Add an extension loopback route that calls the existing sidecar approve and check-in endpoints in sequence.
- **ALT-002**: **Rejection Reason**: Per-instance locks and in-memory state cannot coordinate other panels, extension reloads, or the DevTools monolith, so duplicate queue issues remain possible.

### Spawn Existing CLI Commands from the Extension

- **ALT-003**: **Description**: Run `sprites:approve` and `sprites:checkin` as child processes and translate their output into canvas state.
- **ALT-004**: **Rejection Reason**: Process spawning adds latency, output-parsing fragility, and a larger trust surface while still lacking a shared transaction boundary.

### Keep Approval and Check-In as Separate Controls

- **ALT-005**: **Description**: Add an Approve button but require a later manual check-in action.
- **ALT-006**: **Rejection Reason**: This does not meet the confirmed one-click, no-CLI success gate and leaves approved art stranded between stages.

## Amendment (2026-07-20): CSRF capability, content-addressed dedupe, selective projection

A multi-model review round found six concerns in the initial implementation. All six are
fixed in the same session; this amendment records the refinements that materially change
or extend the original decisions above.

- **AMD-001 (extends DEC-003 / CTX-005)**: The sidecar's own atomic
  `POST /api/runs/:briefId/:runId/accept` route — not just the canvas's loopback
  `/api/accept` — is a second, independently-reachable mutating endpoint on 127.0.0.1.
  Binding to loopback does not stop a browser-issued request (same- or cross-origin:
  modern browsers attach `Origin` to every non-GET request, including same-origin ones).
  The route's only intended caller is the workflow extension's Node-based `fetch`, which
  never sends `Origin`, so the sidecar refuses any request on this route that carries an
  `Origin` header at all, with no allowlist to maintain. `/approve` and `/checkin` — used
  by browser-based gallery UIs — are unchanged.
- **AMD-002 (extends DEC-001)**: Durable queued-asset filtering must constrain the actual
  branch content, not only the filed issue's payload. The check-in worktree projection
  (`copyArtSurface`) now copies ONLY the PNGs for the assets a check-in's plan claims —
  plus their manifest/catalog entries, unioned onto the worktree's own (base-branch)
  copy via the same pure `mergeManifests`/`mergeCatalogs` helpers `asset-pr` already
  uses for consolidation — instead of the entire `public/assets/generated/**` +
  `sprite-catalog.json` wholesale. This keeps the branch diff and the issue payload
  aligned: an asset excluded from a batch (already durably queued elsewhere) never
  appears in that branch's commit either.
- **AMD-003 (extends DEC-001/DEC-002)**: Durable dedupe is now content-addressed.
  `CheckinAsset`/`AssetCheckinPayload` entries and `QueuedAssetCheckin` gain an optional
  `contentHash` (SHA-256 of the approved PNG, the same hash `approve.ts`'s manifest
  entries already carry) — old issues without it remain parseable. The atomic accept
  route reconciles against the durable queue BEFORE calling `approveVariant`
  (`resolveVariantIdentity` resolves the deterministic assetPath + content hash from the
  run's processed PNG without mutating anything): a matching hash returns the existing
  queued state; a differing hash refuses with 409 and does not touch the PNG or manifest;
  a queued entry with no recorded hash (filed before this field existed) fails closed
  (409, `ambiguous-queued-content`) rather than guessing.
- **AMD-004 (extends DEC-005)**: `/approve` now serializes through the SAME process-wide
  `withCheckinMutationLock` as `/checkin` and the atomic `/accept` route — approving
  mutates the identical manifest/catalog/PNG surface a concurrent check-in worktree
  operation reads. Each route acquires the lock exactly once, at its own handler
  boundary, and never calls another locked route internally, so there is no re-entrant
  nesting and thus no deadlock risk.
- **AMD-005 (extends DEC-004/RSK-003)**: The atomic accept response includes
  `assetCount` — the size of the batch this acceptance is now part of — for BOTH a
  freshly-filed issue (`result.plan.assets.length`) and an existing one (every durably
  queued asset sharing that issue's URL). The canvas renders a visible warning whenever
  `assetCount > 1` so an operator can tell when one click published (or is already
  bundled with) other approved, unqueued art.

## Amendment (2026-07-20, round 2): checkin CSRF parity, content-addressed batch reconciliation, a shared error mapper

A follow-up review round found the atomic `/accept` route's AMD-001/AMD-003 protections
had not been extended to the rest of the check-in surface. All four gaps are fixed in the
same session.

- **AMD-006 (extends AMD-001)**: `POST /api/checkin` — not just the atomic `/accept`
  route — now also refuses any request carrying an `Origin` header. A `text/plain` (or
  content-type-less) POST body is a CORS "simple request" that never triggers a preflight,
  so the loopback-only CORS allowlist (`isAllowedOrigin`) cannot be relied on to stop a
  hostile page — even a non-loopback one — from triggering a real check-in (branch push +
  issue file) merely by having the user's browser visit it while the sidecar happens to be
  running locally. `POST /api/checkin/prepare` is exempt: it never mutates anything, so it
  stays reachable from the browser gallery UI.
- **AMD-007 (extends DEC-001/AMD-003)**: `prepareAssetCheckin`'s queued-asset filtering is
  now content-addressed instead of path-only, via the SAME `reconcileQueuedContent`
  classifier the atomic `/accept` route's pre-/post-mutation reconciliation already used
  (`checkin.ts`, shared — not duplicated). A changed asset whose path is already queued
  with the SAME content hash is still deduped silently; a DIFFERENT hash, or a legacy
  queued/manifest entry with no recorded hash at all, now throws a typed `CheckinError`
  (`content-conflict` / `ambiguous-queued-content`, both mapped to 409) instead of being
  silently dropped from — or silently re-added to — the batch. `POST /api/checkin/prepare`
  now calls `prepareAssetCheckin` with the SAME injected `checkinDeps`/options as
  `POST /api/checkin` (previously it re-implemented its own path-only, manifest-blind
  detection and ignored injected `checkinDeps` entirely), so the preview can never diverge
  from what execution actually publishes.
- **AMD-008 (extends DEC-001)**: The durable queued-asset map is now built first-seen-wins
  (`buildQueuedAssetMap`, pure/unit-tested): a duplicate queued path recorded by a
  later-processed open issue — or a duplicated entry within one issue's own payload — can
  no longer silently overwrite an earlier issue's record via `Map.set()`.
- **AMD-009 (extends AMD-003)**: The atomic `/accept` route's pre- and post-mutation
  `listQueuedAssets()` reads are now wrapped so a queue-list failure (e.g. a transient
  `gh issue list` error) maps through the SAME shared `mapCheckinError` route-error mapper
  as every other check-in failure (`gh-failed` → 502), instead of an uncaught rejection
  falling through to Fastify's generic, unstructured 500.
