# Handoff — Persist sprite check-in result + issue link past the status poll

**Date:** 2026-06-27
**Session:** deflake-sprite-checkin-e2e
**Persona:** Producer
**Apple estimate:** 🍎🍎🍎🍎 | **Actual:** 🍎🍎🍎🍎 | **Verdict:** 🎯 exact

## Why

While shepherding all open PRs to merge, **every** open PR — a docs PR (#412), a
sprite fix (#415), and a devtools feature (#413) — failed CI on the **same**
single check: the `E2E Visual Regression` job (the only failing **required**
check; it cascades into the aggregate `ci` + `Merge gate`). A docs-only PR
failing an e2e visual job is a strong tell that the failure is shared, not
PR-specific.

The one failing test was
`tests/e2e/sprite-workflow-sensors.test.ts > … > checks in approved sprites and
surfaces the filed asset-checkin issue link`.

## Two-stage diagnosis (first hypothesis was wrong)

1. **First read — "timing flake":** the failure presented as a timeout at
   `issueLink.waitFor({ timeout: 10_000 })`, and the test passed locally in ~1s.
   I hardened the wait (gate on the mocked `/api/checkin` **response**, raise the
   budget to 30s) and pushed. **That CI run failed too** — but differently: a
   **fast, deterministic** failure at the next assertion
   (`body … toContain('Checked in 1 asset on')`) in ~440ms. The DOM dump showed
   the workflow panel with **"Next: Judge"** where the check-in banner should be.

2. **Real root cause — a product bug in #413's merged devtools code:** the
   check-in success handler rendered the banner **and its clickable issue link**
   into the **shared** `workflowStatus` line via `replaceChildren`. But
   `renderWorkflowSelection` runs on a **1-second `setInterval`** and rewrites
   that same line (`setWorkflowStatus(`Next: ${nextAction}`)`, etc.). So within
   ~1s of a successful check-in, the poll **clobbered the success banner and the
   filed-issue link** — the link vanished before an operator could click it. The
   e2e raced that poll: sometimes it lost at the link-visibility wait (the
   original 10s "timeout"), sometimes it caught the link but lost at the
   body-text assertion a beat later. Both faces were the **same bug**, not a
   flake.

Why it slipped onto `main`: the `E2E Visual Regression` job is **skipped** on
non-triggering pushes, so it never blocks a push to `main` — it only runs on PR
runs, where it then blocked every unrelated PR.

## What Was Done

**Product fix — `src/devtools-main.ts`:** render the check-in result into a
**dedicated, render-proof element** (`checkinResult`) instead of the shared
`workflowStatus` line. `renderWorkflowSelection`'s poll never touches it, so the
"Checked in N asset(s) on …" banner and the **clickable issue link persist**
until the next check-in. The result is cleared at the start of each new check-in
so a stale banner can't linger on a later failure.

**Deterministic regression guard — `tests/e2e/sprite-workflow-sensors.test.ts`:**
reverted the misleading 30s/`waitForResponse` band-aid framing (kept the
response gate as legitimate sync, restored a normal 10s wait) and added a
**persistence assertion**: after the link renders, wait `1_200ms` (one full poll
cycle) and re-assert the link is still visible and the banner text still present.
This deterministically fails if anyone re-introduces the shared-line clobber.

## Files Changed

| File                                        | Change                                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/devtools-main.ts`                      | Render check-in banner + issue link in a dedicated `checkinResult` element (poll-proof) |
| `tests/e2e/sprite-workflow-sensors.test.ts` | Persistence regression guard: link + banner survive a full 1s poll cycle                |

## Validation

- `npm run typecheck` → ✓.
- `npx vitest run --project e2e tests/e2e/sprite-workflow-sensors.test.ts` →
  **7/7 passed** (check-in test ~2.5s, includes the 1.2s persistence re-assert).
- `npm run verify:fast` → ✓.
- Full unit suite → 2562 passed; the lone failure was `floor1-completion.test.ts`'s
  wall-time budget guard flaking under my concurrent local load — it passes 60/60
  isolated (CI runs it in its own contention-free job).
- **Before/after observed (rule #10):** CI on the 30s-timeout attempt failed
  fast with **"Next: Judge"** clobbering the banner; after the dedicated-element
  fix, the local e2e link survives a full poll cycle and all 7 pass.

## Notes for Next Agent

- This PR (#417) unblocks the two still-open PRs: **#412**
  (`perf-cpu-levers-handoff`, docs) and **#415** (`nalfeo-fix-sprite-width-selector`,
  sprite fix). **#415 is `DIRTY`** — it conflicts with merged #413 in
  `scripts/sprites/sidecar/server.ts`, `src/devtools-main.ts`, and
  `src/devtools/sprite-workflow-queue.ts` (all additive `sizeVariant` plumbing);
  rebase it onto the post-#417 `main` and keep both sides. **#412** is not dirty;
  the `rebase-prs` bot rebases it automatically once #417 merges. Both already
  have auto-merge armed.
- **#413** (`nalfeo-launch-devtools-sidecar`) already MERGED this session — its
  flaky E2E happened to pass on a re-run, which is how this bug reached `main`.
- No `files/guard-telemetry.jsonl` this session, so no guard-telemetry section.

## Apples

Estimated 🍎🍎🍎🍎; actual 🍎🍎🍎🍎 (exact). What looked like a 10-line test
de-flake turned out to be a real user-visible product bug whose true cause only
surfaced after a failed first-hypothesis CI cycle. The work spanned: shared-flake
diagnosis across three PRs, a wrong first fix, reading the CI DOM dump to spot the
poll clobber, a DOM refactor in `devtools-main.ts`, and promoting the bug class to
a deterministic persistence guard.

## Systems touched

sprite-pipeline
