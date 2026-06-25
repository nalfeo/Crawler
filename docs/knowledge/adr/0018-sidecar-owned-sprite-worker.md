# ADR 0018: Sidecar owns an in-process sprite-generation worker

## Status

Accepted

## Date

2026-06-25

## Estimated Complexity

🍎 x 4 — touches the provider layer, the sidecar HTTP server, its CLI, and the
devtools UI; no new ECS lab required (sprite infra is outside the game ECS).

## Context

On the `azure-queue` backend the sidecar's `POST /api/workflow/generate` route
only **enqueues** a request (HTTP 202). A separate consumer must dequeue it and
run `generateOne`. Historically that consumer was a standalone process
(`sprites:worker` / `worker-cli.ts`) that an operator had to remember to start.

When no worker was running, the devtools sprite-generation-workflow page polled
`while(true)` forever on "Generating…" with no consumer on the other end — the
reported "stuck generating Slime Rat with no way to see what's going on" bug. A
companion problem: the four Azure providers issued `fetch` with **no timeout**,
so even on the inline (`noop`) path a hung Azure call blocked `generateOne`
indefinitely.

Phase 1 (PR #318) addressed _observability_ (elapsed timer, poll counter, stall
hints, Cancel) but deliberately deferred the _availability_ fix. This ADR covers
that second half: guaranteeing a worker consumer exists, and bounding provider
calls.

## Decision

1. **Provider request timeouts.** A shared helper
   (`scripts/sprites/provider/fetch-timeout.ts`) wraps every Azure provider
   `fetch` in `AbortSignal.timeout(ms)` (default 120 s, override
   `SPRITES_PROVIDER_TIMEOUT_MS`, floor 1 s). A timeout is surfaced as the
   existing **retryable `network`** `ProviderError` kind — no new error kind, so
   the orchestrator's exhaustive switches are untouched.

2. **The sidecar owns an in-process worker.** A new
   `scripts/sprites/sidecar/worker-controller.ts` (`createWorkerController`)
   wraps `runWorker` with `start()` / `stop()` / `status()` lifecycle:
   - `buildServer` **constructs** a controller but **never starts it**. This
     keeps existing sidecar tests (whose fake queues only implement `enqueue`)
     unaffected — the loop only runs when something explicitly starts it.
   - `cli.ts` **auto-starts** the worker after `listen()` **iff**
     `queue.backend === 'azure-queue'`. On `noop`, generate runs inline, so no
     worker is needed (and starting one would require Azure credentials the
     local box lacks).
   - New routes: `POST /api/workflow/worker/start`, `POST .../stop`,
     `GET .../status`; the worker snapshot is also embedded in `/api/health`.
   - A Fastify `onClose` hook stops the worker so shutdown stays clean.
   - Providers are constructed **lazily inside `start()`**; a credential failure
     records `lastError` and returns `provider-init-failed` instead of throwing
     at build time or spinning the loop.

3. **Devtools "Launch worker" button.** `src/devtools-main.ts` reads the worker
   snapshot from `/api/health`, shows a **Launch worker** button whenever the
   backend is `azure-queue` and no worker is running, and the queued-stall hint
   now points the user at that button. Health is refreshed during queued polling
   so the control appears mid-stall.

Both the `sprites:gallery` launcher and direct `sidecar/cli.ts` invocation go
through `cli.ts`, so auto-start is universal. The standalone `sprites:worker`
process is retained for production / horizontal scaling.

## Consequences

### Positive

- A queued generation always has a consumer wherever the sidecar runs — the
  infinite-"Generating…" hang on `azure-queue` is structurally prevented.
- A hung provider now fails fast (≤ timeout) with a clear, retryable error
  instead of blocking `generateOne` forever on the inline path.
- The operator gets an in-UI escape hatch (Launch worker) plus visible worker
  state (running / processed / failed / lastError) via `/api/health`.

### Negative

- The sidecar process now also runs generation work when on `azure-queue`,
  coupling two concerns (HTTP serving + generation) in one process. For local /
  single-operator use this is the point; at production scale, prefer the
  standalone `sprites:worker` and leave the sidecar's worker stopped.

### Risks

- A misconfigured `azure-queue` (missing creds) makes auto-start fail; mitigated
  by `provider-init-failed` + `lastError` surfaced in `/api/health` and the CLI
  banner, rather than a crash.
- `onClose → worker.stop()` awaits the loop's current iteration; an in-flight
  Azure dequeue can briefly delay shutdown. Acceptable; tests inject fast fakes.

## Alternatives Considered

- **Start a worker from the launcher only.** Rejected: the launcher is one of
  several entry points; a sidecar started any other way would still lack a
  worker. Owning it in the sidecar gives universal coverage.
- **Add a dedicated `timeout` `ProviderErrorKind`.** Rejected: it would force
  edits to every exhaustive `switch` over the kind union for no behavioural gain
  — timeouts are retryable, exactly like `network`.
- **Auto-start the worker inside `buildServer`.** Rejected: it would break
  existing tests and start a loop even for `inject()`-only test servers. Keeping
  start in the CLI preserves the "buildServer opens no sockets / does no work"
  contract.
