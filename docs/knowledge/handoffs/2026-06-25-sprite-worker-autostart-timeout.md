# Session Handoff: Sprite worker auto-start + provider timeouts

## Date

2026-06-25

## Persona(s) adopted

**Producer** — the follow-up ("provider timeout + make the worker always start
with the sidecar and/or a launch button") spanned the provider layer, the sidecar
server + CLI, and the devtools UI, so it needed cross-layer ownership.

## Routing verdict

✅ right persona — Producer was correct again: this is the backend/availability
half of the same cross-layer bug Phase 1 diagnosed.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact

Hello kitties: 4/5 = 0.80 🎀

## Systems touched

sprite-workflow

## What Was Done

Phase 2 of the "stuck generating, no visibility" fix (Phase 1 = PR #318 UI work).
This change guarantees a queue consumer exists and bounds provider calls.

### Provider request timeouts

- `scripts/sprites/provider/fetch-timeout.ts` (new): `DEFAULT_PROVIDER_TIMEOUT_MS`
  (120 s), `MIN_PROVIDER_TIMEOUT_MS` (1 s), `resolveProviderTimeoutMs(env, fallback)`
  (reads `SPRITES_PROVIDER_TIMEOUT_MS`, never silently disables), `isTimeoutAbortError`,
  `providerTimeoutMessage(label, ms)`.
- All four Azure providers (`azure-openai`, `azure-vision`, `azure-chat`,
  `azure-chat-synth`): added a `timeoutMs` option + `AbortSignal.timeout(this.timeoutMs)`
  on the `fetch`, and a catch branch that maps a timeout to the **retryable
  `network`** `ProviderError` kind (no new error kind). `factory.ts` passes
  `timeoutMs: resolveProviderTimeoutMs(env)` to all four constructors.

### Sidecar-owned in-process worker

- `scripts/sprites/sidecar/worker-controller.ts` (new): `createWorkerController(deps)`
  → `{ start(), stop(), status() }`. Wraps `runWorker`; injectable
  `runWorker`/provider-factories/queue/store/now for tests. Lazy provider
  construction (records `lastError` + `provider-init-failed` instead of throwing);
  idempotent start/stop; processed/failed counters + last event in the snapshot.
- `scripts/sprites/sidecar/server.ts`: `SidecarDeps.worker?`; builds a controller
  (never starts it); `worker: worker.status()` added to `/api/health`; new routes
  `POST /api/workflow/worker/start`, `POST .../stop`, `GET .../status`; `onClose`
  hook stops the worker.
- `scripts/sprites/sidecar/cli.ts`: constructs the controller, passes it to
  `buildServer`, and **auto-starts it after `listen()` iff `queue.backend ===
'azure-queue'`**. The launcher spawns `sidecar/cli.ts`, so auto-start is
  universal.

### Devtools UI

- `src/devtools-main.ts`: parses the `worker` field from `/api/health`; a
  **Launch worker** button (POST `/worker/start`) appears when backend is
  `azure-queue` and no worker is running; the queued-stall hint points at it;
  health is refreshed during queued polling so the control surfaces mid-stall.

### Tests

- `tests/unit/sprites/fetch-timeout.test.ts` (new, 9): env parsing/floor/fallback,
  abort detection, message.
- `tests/unit/sprites/worker-controller.test.ts` (new, 8): start/idempotency,
  counters, onStatus, provider-init-failed, stop-aborts-and-resolves, backend.
- `tests/unit/sprites/azure-openai.test.ts`: +1 timeout-classification test.
- `tests/unit/sprites/sidecar-server.test.ts`: +5 worker-route/health tests with a
  fake `WorkerController`.

## What's Next

- Optional: a `/api/workflow/queue-status` (depth/peek) endpoint to distinguish
  "queued, worker idle" from "worker busy" beyond the binary running flag.
- Optional: persist worker/sidecar logs to a session artifact for post-hoc
  debugging (the original "no way to see what's going on" had a logging facet).

## Blockers

None. Auto-merge was **not** requested — do not enable it without asking.

## Branch State

- Branch: `nalfeo-fix-sprite-gen-stuck-visibility` (Phase 2 stacks on the Phase 1
  branch / **PR #318**; update the PR title/description to cover the backend scope).
- All tests passing: yes (`npm run verify:fast`, then `npm run verify`).
- PR created: PR #318 (open) — broadened to include the backend changes.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "allow": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```

## Test Results

`npm run verify:fast` — ✅ (typecheck + lint + unit, 158 tests). Full `npm run
verify` run before commit (see PR checks).

## Key Decisions Made

- **Sidecar owns the worker** (ADR 0018). Universal coverage regardless of entry
  point; `buildServer` constructs but never starts it (keeps `inject()` tests
  socket-free and the azure-queue fakes — `enqueue`-only — valid).
- **Auto-start only on `azure-queue`.** The `noop` path runs generate inline, so a
  worker is unnecessary and would demand Azure creds the local box lacks.
- **Timeout → existing `network` kind**, not a new `ProviderErrorKind`, to avoid
  touching exhaustive switches; timeouts are retryable just like network errors.
- **Lazy provider construction in `start()`** so missing creds surface as
  `lastError`/`provider-init-failed` in `/api/health` instead of crashing the
  sidecar.
