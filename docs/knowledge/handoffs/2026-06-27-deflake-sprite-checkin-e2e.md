# Handoff — De-flake sprite-workflow check-in e2e

**Date:** 2026-06-27
**Session:** deflake-sprite-checkin-e2e
**Persona:** Producer
**Apple estimate:** 🍎🍎🍎🍎 | **Actual:** 🍎🍎🍎 | **Verdict:** ⬇️ over

## Why

While shepherding all open PRs to merge, **every** open PR — a docs PR (#412),
a sprite fix (#415), and a devtools feature (#413) — failed CI on the **same**
single check: the `E2E Visual Regression` job, which is the only failing
**required** check (it cascades into the aggregate `ci` + `Merge gate`). A
docs-only PR failing an e2e visual job is a strong tell that the failure is not
PR-specific.

Root-causing it: the one failing test was
`tests/e2e/sprite-workflow-sensors.test.ts > … > checks in approved sprites and
surfaces the filed asset-checkin issue link`, timing out at
`issueLink.waitFor({ timeout: 10_000 })`. The check-in handler renders the
issue link correctly — the assertion was just losing a race under CI CPU
contention (the post-response DOM replace over the large `devtools-main.ts`
module graph spikes past a tight 10s budget). Reproduced locally on the exact
`main` commit: the test passes in ~1s (full file 7/7 green). So it is a **timing
flake**, not a product bug.

Why it slipped onto `main`: the `E2E Visual Regression` job is **skipped** on
non-triggering pushes, so a flaky e2e never blocks a push to `main` — it only
surfaces on PR runs, where it then blocks every unrelated PR.

## What Was Done

Single-file test hardening in `tests/e2e/sprite-workflow-sensors.test.ts`:

- Gate the assertion on the **mocked `/api/checkin` response**
  (`page.waitForResponse`) — a discrete signal — instead of just the dispatched
  request, so the wait targets the link render rather than the in-flight
  round-trip.
- Raise the link-visibility budget from 10s → **30s**, matching the cold-server
  rationale already documented on `loadSeededDevtools` in the same file.

No production code changed. This is a deterministic-signal + generous-budget
de-flake, per the repo rule to fix (not paper over) infra/test flakes.

## Files Changed

| File                                        | Change                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `tests/e2e/sprite-workflow-sensors.test.ts` | Gate on `/api/checkin` response + raise link wait 10s→30s (de-flake) |

## Validation

- `npx vitest run --project e2e tests/e2e/sprite-workflow-sensors.test.ts` → **7/7 passed** (check-in test ~1s).
- `npm run verify:fast` → ✓ (typecheck + lint clean; no unit tests match an e2e-only diff).
- Before/after observed: prior CI runs on #412/#415 fail this exact assertion at 10s; local repro on the same commit passes — confirming flake, not regression.

## Notes for Next Agent

- This PR only de-flakes the test. The two still-open PRs it unblocks — **#412**
  (`perf-cpu-levers-handoff`, docs) and **#415**
  (`nalfeo-fix-sprite-width-selector`, sprite fix) — need to be **rebased onto
  the new `main`** (the `rebase-prs` bot does this automatically once this
  merges) so they pick up the hardened test, then re-run E2E + arm
  `gh pr merge --auto --squash`.
- **#413** (`nalfeo-launch-devtools-sidecar`) already MERGED this session — its
  flaky E2E happened to pass on a re-run.
- No `files/guard-telemetry.jsonl` this session, so no guard-telemetry section.

## Apples

Estimated 🍎🍎🍎🍎 (I budgeted for a real devtools-UI fix across three blocked
PRs); actual 🍎🍎🍎 (over). The implementation was a 10-line, low-risk test
change — but the bulk of the work was the diagnosis: distinguishing a flake from
a real bug, recognizing the broken check was shared/unrelated to each PR,
reproducing locally against `main`, and understanding why the `E2E Visual
Regression` skip-on-push masked it. Coordinating three PRs adds the rest.
