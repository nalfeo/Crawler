# Session Handoff: Relocate sprite sidecar lifecycle

## Date

2026-07-20

## Persona(s) adopted

**Producer** for the cross-layer lifecycle redesign, with the review-harness and
canvas-extension workflows for implementation and validation.

## Routing verdict

Right persona. The change spans process ownership, four extension canvases,
sprite CLI launchers, authenticated service control, and Windows behavior.

## Apples

Estimated: 5

Actual: 5

The estimate held: the initial extension-owned-child design was rejected during
adversarial review and replaced by a repo-scoped singleton manager, followed by
two bounded correctness review rounds.

## Systems touched

sprite-workflow, devtools

## What Was Done

- Added a repo-scoped managed sidecar service with an atomic temp-directory
  registry, canonical checkout identity, deterministic port reuse, code
  provenance, managed health identity, and token-authenticated shutdown.
- Made Sprite Review, Workflow, Postprocess, and Storage canvases immediately
  render a startup/degraded state and automatically ensure the shared service.
- Required strict readiness for Azure-backed services: both the worker and issue
  ingester must be running.
- Updated `sprites:run` and `sprites:gallery` to share the same persistent
  service. Gallery now owns only Vite; the sidecar persists until
  `npm run sprites:sidecar:stop`.
- Added `sprites:sidecar:ensure` and `sprites:sidecar:stop`.
- Hardened Windows lifecycle behavior: canvases invoke `node` rather than the
  Copilot executable, the manager launches TypeScript with `node --import tsx`
  so registry and health PIDs match, bootstrap failures release claims, startup
  timeouts shut down only proven-owned processes, stale recycled PIDs are
  reclaimed after a grace window, and callers wait for an existing same-version
  service instead of spawning onto an occupied port.
- Bound reuse to the checkout's Git commit provenance so a detached service is
  restarted after committed branch/code changes.
- Added focused manager, server, extension-adapter, and Storage renderer
  regression coverage.

## Observe Before Done

Before this change, opening the dependent canvases with no running sidecar left
them degraded and required the operator to ask for or run a terminal launch.

After this change, a stopped service was followed by opening the Storage canvas.
The service became healthy within the 60-second gate with:

- repo root matching this worktree;
- version `0.3.0-managed`;
- managed PID and registry PID both `104560`;
- one shared instance `bcc68a94-6bbf-4d72-a732-51072be3298f`;
- worker and issue ingester both running.

Opening Workflow next reused that exact PID and instance.

## Review Harness

Ledger:
`docs/knowledge/review-ledgers/2026-07-20-relocate-sprite-sidecar.review-ledger.json`

- Adversarial plan review: 8 concerns resolved, 3 alternatives considered,
  `plan_divergence: major_fork`.
- Code review: two rounds; 6 concerns resolved.
- Multi-model review: two rounds across Claude, GPT, Gemini, and the security
  specialist; 9 adjudicated valid concerns resolved.
- The supply-chain alert was rejected because project extension entrypoints are
  already mutable checkout code auto-executed under the same trust model. Its
  valid persistent-code aspect was addressed with launch provenance.

## Validation

- `npx vitest run --project sprites
tests/unit/sprites/sidecar-service-manager.test.ts
tests/unit/sprites/sidecar-server.test.ts` — 105 tests passed.
- `node --test .github/extensions/storage/tests/renderer.test.mjs
.github/extensions/sprite-review/tests/sidecar-service.test.mjs` — 19 tests
  passed.
- `npm run verify:fast` — passed.
- Review ledger validation — passed for the 5-apple tier.

## Key Decisions

- Keep HTTP as the internal compatibility boundary; replacing the sidecar API
  would expand scope without improving lifecycle ownership.
- Use a shared repo-scoped manager rather than letting independent extension
  processes own detached children.
- Never kill a process based only on a stale registry PID. Automatic shutdown
  requires matching registry and health provenance; fallback termination is
  limited to the exact process spawned by the current invocation.
- Persist the shared service across canvas and gallery closure, with an explicit
  stop command and automatic provenance restart.

## Blockers

None.

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` was not present.

## What's Next

CI owns the full suite and merge gates.
