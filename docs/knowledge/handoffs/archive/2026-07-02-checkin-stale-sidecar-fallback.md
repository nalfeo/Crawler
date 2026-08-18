# Session Handoff: Robust asset check-in against a stale sidecar

## Date

2026-07-02

## Persona(s) adopted

**Producer** (default for a multi-layer, ambiguous bug) — the task spanned the
devtools UI (`src/devtools-main.ts`), the sidecar HTTP client
(`src/devtools/sprite-approval-api.ts`), and both unit + e2e test layers, plus a
pre-existing infra (typecheck) repair. No deeper specialist was needed once the
root cause was pinned.

## Routing verdict

✅ right persona — a single cross-layer DX fix; Producer scope fit without a split.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — 3 small source edits + 2 test layers + a 3-error typecheck
baseline repair + the review harness landed within the 2-apple envelope; no
surprises once the root cause (a stale, non-hot-reloading sidecar process) was
confirmed.

Hello kitties: 2/5 = 0.40 🎀

## Systems touched

sprite-workflow

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-checkin-stale-sidecar-fallback.review-ledger.json`
Stages (2-apple tier): plan_review ✅ · code_review ✅

- plan_review: gpt-5.4 rubber-duck (reasoning=high) → approved_with_changes, 5
  concerns, all 5 adopted (persistent hint surface; tightened 404 detector;
  dedicated checkin-404 test; assert no-slug in fallback; separate infra commit).
- code_review: gpt-5.4 code-review agent → clean on round 1, no significant issues.
  `npm run review:ledger -- validate <path>` → ✅ valid 2-apple ledger.

## What Was Done

Root cause: the sprite sidecar is a long-lived `tsx` process that does **not**
hot-reload. A sidecar started before the pre-flight route `POST /api/checkin/prepare`
(added in PR #635) keeps serving its old route table and returns a bare Fastify
404, which the "Check in to GitHub" button surfaced as
`Pre-flight check failed: prepare failed (404): Route POST:/api/checkin/prepare not found`
and then **aborted the whole check-in** — even though the older `POST /api/checkin`
route still works on that same process. The on-disk code everywhere (this worktree,
the running sidecar's worktree, `origin/main`) already has the route, so this is a
stale-process problem, not missing code. The user chose a durable DX fix over just
restarting the sidecar.

Changes:

- `src/devtools/sprite-approval-api.ts`: added `STALE_SIDECAR_HINT` (actionable
  "restart `npm run sprites:gallery`" copy) and `isSidecarRouteMissing(err)`, a
  tight predicate matching only Fastify's missing-route 404 (status 404 +
  `errorCode === 'Not Found'` + message matches `/route \w+:/` and mentions
  `/api/checkin`). The prepare/checkin handlers only ever return 403/409/500, so a
  404 on those routes unambiguously means "route not registered".
- `src/devtools-main.ts` (check-in button handler): `prepareData` is now
  `CheckinPrepareResponse | null`. When pre-flight 404s as a missing route, the UI
  logs an amber warning, skips pre-flight, and **still checks in** via
  `postCheckin(undefined)` (no slug → the sidecar computes its own branch, exactly
  the pre-#635 behavior). A persistent note (in `checkinResult`, which survives the
  1s poll) carries the restart hint. The final catch renders `STALE_SIDECAR_HINT`
  instead of the raw 404.
- Tests: unit tests for `isSidecarRouteMissing` / `STALE_SIDECAR_HINT`; two
  deterministic Playwright e2e tests — (a) prepare 404 → checkin 200 still succeeds
  and sends an empty `/api/checkin` body (no stale slug), hint persists; (b)
  prepare 200 → checkin 404 shows the hint, hides the raw 404, and shows no false
  success banner.
- Infra (separate commit): fixed 3 pre-existing `tsc` errors on `main`
  (`tests/unit/sprites/asset-queue.test.ts` narrow `AssetRequest` by `kind`;
  `tests/unit/sprites/issue-pipeline.test.ts` ×2 drop an invalid
  `as Record<string, unknown>` cast on a `vi.mocked()` call arg). No behavior change.

## What's Next

- Consider a proactive sidecar version/route check: on gallery boot, hit a
  `/api/health` (or a new `/api/version`) and warn if the running sidecar predates
  known routes, so operators are told to restart before they even click check-in.
- Optionally add a tiny "Restart sidecar" affordance / doc link next to the button.

## Blockers

None.

## Branch State

- Branch: `nalfeo-fix-checkin-prepare-route`
- All tests passing: yes (typecheck; 2827 unit; 49 integration +1 skipped; 17
  headless Floor-1; 9 e2e in the touched file; full `npm run verify` build step).
- PR created: yes (see PR opened from this branch).

## Agent-OS Telemetry

> NOTE: `files/guard-telemetry.jsonl` in this worktree contains copilot-guards
> **test-fixture** data (guard names like `boom`, `pr-hard`, `shell-bad`), not this
> session's real guard activity. Pasted verbatim per policy:

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 15,
  "guards": {
    "boom": {
      "crash": 2
    },
    "ctx": {
      "allow": 1
    },
    "ctx-a": {
      "allow": 1
    },
    "ctx-b": {
      "allow": 1
    },
    "edit-bad": {
      "bypass": 1
    },
    "edit-guard-self-protection": {
      "ask": 2
    },
    "pr-a": {
      "deny": 1
    },
    "pr-b": {
      "deny": 1
    },
    "pr-hard": {
      "deny": 1
    },
    "pr-warn": {
      "allow": 1
    },
    "shell-a": {
      "deny": 1
    },
    "shell-bad": {
      "deny": 2
    }
  },
  "tools": {
    "create_pull_request": 4,
    "edit": 6,
    "powershell": 5
  }
}
```

## Test Results

- `npm run typecheck` → green.
- `npm run verify:fast` → green (typecheck + lint + 40 changed unit tests).
- `npm run verify` → green through build; only `verify:pr-prereqs` gated on this
  handoff file (review ledger already validated ✅). Unit: 247 files / 2827 tests;
  integration: 49 pass / 1 skip; headless Floor-1 gate: 17 pass.
- `npx vitest run --project e2e tests/e2e/sprite-workflow-sensors.test.ts` → 9/9
  (7 existing + 2 new stale-sidecar tests).

## Key Decisions Made

- Detect the stale sidecar by the **Fastify missing-route signature**, not bare
  `status === 404`, so a misconfigured `SIDECAR_BASE` or another local service on
  the port can't spuriously trigger the fallback (plan-review concern #2).
- On the fallback path, call `postCheckin()` with **no slug** so the sidecar owns
  slug/branch computation (no prepared-branch mismatch, since we never displayed a
  prepared branch in that path).
- Surface the hint in the **persistent** `checkinResult` element, since the
  transient workflow-status line is overwritten by the 1s render poll
  (plan-review concern #1).

## Retrospective

### Lessons Learned

- A 404 from a POST route that the code clearly defines almost always means a
  **stale long-lived dev process**, not missing code — verify the running process's
  in-memory route table (probe it live) before assuming a code regression. The
  `tsx` sidecar does not watch/reload.
- Playwright route precedence in this e2e suite: a global `**/api/**` abort is set
  once in `beforeAll`; per-test `page.route(...)` calls registered inside the test
  body take precedence (most-recent-registered wins) and are torn down with
  `page.unroute(...)` in `finally`. Mirror the existing check-in test exactly.
- PowerShell: `Invoke-WebRequest` in PS7 surfaces HTTP errors via
  `HttpResponseMessage`; use `-SkipHttpErrorCheck` to read `.StatusCode`/`.Content`
  without throwing.

### Mistakes Made

- Initially assumed the route might be missing from source; the early signal that
  it was a stale process was that `origin/main` and every worktree already had the
  route while a live probe still 404'd. Probe the live process sooner.

### Opportunities for Future Improvement

- The `tsx` sidecar's lack of hot-reload is a recurring foot-gun. A boot-time
  route/version handshake (see "What's Next") would convert this class of cryptic
  404 into an explicit, proactive "restart me" prompt.
- `files/guard-telemetry.jsonl` currently holds test-fixture data in this worktree;
  the handoff guidance could clarify how to distinguish real vs. fixture telemetry.
