# Session Handoff: Sprite generation "stuck with no visibility" fix

## Date

2026-06-25

## Persona(s) adopted

**Producer** — the report ("stuck generating Slime Rat with no way to see what's
going on") spanned the devtools UI, the sprite sidecar, the queue worker, and the
provider layer, so it needed a cross-layer diagnosis before settling on a focused,
low-risk UI fix.

## Routing verdict

✅ right persona — Producer was correct: the root-cause hunt crossed four layers,
but the chosen remedy stayed in the UI, which a single persona could own.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3 <!-- honest assessment at handoff time -->
Verdict: 🎯 Exact — N/A

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

Diagnosed why a sprite generation can appear to hang forever on
`devtools.html?page=sprite-generation-workflow` with no feedback:

1. Provider `fetch` calls (image + vision) have **no timeout/AbortSignal**, so a
   hung Azure call blocks `generateOne` indefinitely on the synchronous path.
2. On the Azure queue path the UI polls `while(true)` silently; if **no
   `sprites:worker` is running** the job is never processed → infinite
   "Generating…". The `sprites:gallery` launcher never starts a worker.
3. Worker and sidecar log only to their own stdout — **nothing is persisted**, so
   there was "no way to see what's going on".

Shipped a **frontend-only observability + control** fix (no infra changes):

- `src/devtools/sprite-workflow-queue.ts`
  - Added `generationStartedAt: string | null` to `QueueItem` (client-set on the
    Generate click for BOTH paths; distinct from server-set `generationRequestedAt`
    used for run matching). Defaulted in `makeItem`, deserialized in `sanitizeItem`.
  - Added pure, unit-tested helpers: `formatGenerationElapsed(ms)` and
    `describeGenerationProgress(input)`, plus `GENERATION_QUEUED_STALL_HINT_MS`
    (60s) and `GENERATION_SYNC_STALL_HINT_MS` (120s).
- `src/devtools-main.ts`
  - Live **elapsed timer** (1s `setInterval`) while an item is `generating`.
  - **Poll-attempt counter** + **queue backend** (from `/api/health`) surfaced for
    the queued path; amber stall hints past the thresholds ("make sure a worker is
    running" / "provider may be slow — Cancel and retry").
  - A **Cancel** button: aborts the in-flight sync fetch via `AbortController`
    and/or stops the queued poll loop by resetting the stage to `variants`/`promoted`.
- `tests/unit/devtools-sprite-workflow-queue.test.ts`
  - 10 new tests: `generationStartedAt` default + round-trip, `formatGenerationElapsed`
    (clamp/seconds/minutes/hours), `describeGenerationProgress` (sync vs queued,
    both stall-hint thresholds).

## What's Next

Deferred backend follow-ups (offered, not yet done — confirm scope with the user):

1. **Provider request timeout**: wrap image/vision `fetch` in
   `scripts/sprites/provider/*.ts` with an `AbortSignal.timeout(...)` so a hung
   provider fails fast instead of blocking `generateOne` forever.
2. **Worker auto-start / queue visibility**: either start a `sprites:worker` from
   the `sprites:gallery` launcher (`scripts/sprites/sidecar/launcher.ts:58`) or add
   a `/api/workflow/queue-status` endpoint so the UI can tell "queued but no worker"
   apart from "worker busy".

## Blockers

None. The user skipped the scope-confirmation question, so the deferred backend
fixes above still need an explicit go-ahead.

## Branch State

- Branch: `nalfeo-cautious-spork`
- All tests passing: yes
- PR created: yes (see PR for this branch)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no telemetry section.

## Test Results

`npm run verify` — ✅ Full verification passed (typecheck, lint, format, dead-code,
unit + integration tests, build). `devtools-sprite-workflow-queue.test.ts`: 36
tests; the brittle `devtools-main-queued-generation-guards.test.ts` still passes
(source substrings preserved).

## Key Decisions Made

- **Scope kept to the UI layer.** The fastest way to remove the "no visibility"
  pain is client-side: an elapsed clock, poll counter, and Cancel give the user an
  escape hatch and a diagnosis without touching the sidecar/worker/provider infra.
- **Two timestamps, deliberately.** `generationStartedAt` (client, both paths) drives
  the elapsed display; `generationRequestedAt` (server, queued path) is left untouched
  because the poll loop matches runs against it. Conflating them would break matching.
- **Cancel is path-aware.** Sync path aborts the fetch (`AbortError` is caught and
  returned early so the cancel state isn't clobbered); the queued path can't abort a
  remote job, so it stops by resetting the stage and the poll loop exits next tick.
