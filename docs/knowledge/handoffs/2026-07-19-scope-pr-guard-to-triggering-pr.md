# Handoff: Scope PR Ready/Reviewer Guard to the triggering PR

**Date:** 2026-07-19
**Persona:** DevOps Engineer
**Apples:** 🍎🍎 (estimated 2, actual 2)

## Systems touched

ci-policy

## Problem

`PR Ready/Reviewer Guard` was firing 1,488 times in a 72-hour window with 521 cancellations because each `pull_request_target` event triggered a full sweep of all open PRs, even though the event identifies the specific PR being targeted.

## What Was Done

### `.github/workflows/pr-ready-reviewer-guard.yml`

- Changed `concurrency.group` from the global `pr-ready-reviewer-guard` to a per-PR key for event runs:
  `pr-ready-reviewer-guard-${{ github.event_name == 'pull_request_target' && github.event.pull_request.number || 'sweep' }}`
- Added `cancel-in-progress: "${{ github.event_name == 'pull_request_target' }}"` so stale event-triggered runs for the same PR are cancelled, while scheduled/manual sweeps are never cancelled.

### `.github/scripts/pr-ready-reviewer-guard.mjs`

- Added `fetchSingleOpenPr(prNumber)` to `createApi` — calls the same `/pulls/{number}` endpoint as `getPull` but is used exclusively for the initial single-PR fetch path.
- In `runPrReadyReviewerGuard`: when `eventName === 'pull_request_target'` and `triggeringPullNumber` is a valid positive integer, the guard now fetches only that PR via `api.fetchSingleOpenPr(prNumber)` instead of calling `api.listOpenPulls()`. Scheduled and `workflow_dispatch` runs continue using `listOpenPulls` for full sweeps. Falls back to sweep if `triggeringPullNumber` is absent.

### `.github/scripts/pr-ready-reviewer-guard.test.mjs`

- Added `fetchSingleOpenPr` to the test harness (does NOT increment `getPullCounts`, so the `changedFilesByPull` retry sequences are unaffected).
- Added `calls.push(['listOpenPulls'])` to track list-fetch calls for assertion.
- Updated the workflow structure test to assert on the new per-PR concurrency group and `cancel-in-progress` expression.
- Added 6 new tests:
  - `event-scoped run uses fetchSingleOpenPr and skips listOpenPulls`
  - `scheduled run uses listOpenPulls for full sweep, not fetchSingleOpenPr`
  - `workflow_dispatch run uses listOpenPulls for full sweep`
  - `event-scoped run skips immediately when triggering PR is not open`
  - `pull_request_target event without a valid triggeringPullNumber falls back to full sweep`
  - `different PRs each get their own concurrency key (workflow group contains PR number expression)`

## Security boundary

The workflow still checks out the **default branch** script (not the PR head) and runs with the repository's `CRAWLER_CI_PAT`. The `pull_request_target` event runs in the context of the base repository, not the fork. These properties are unchanged.

## Concurrency behavior

| Trigger                        | Concurrency group               | cancel-in-progress |
| ------------------------------ | ------------------------------- | ------------------ |
| `pull_request_target` (PR #42) | `pr-ready-reviewer-guard-42`    | `true`             |
| `pull_request_target` (PR #99) | `pr-ready-reviewer-guard-99`    | `true`             |
| `schedule`                     | `pr-ready-reviewer-guard-sweep` | `false`            |
| `workflow_dispatch`            | `pr-ready-reviewer-guard-sweep` | `false`            |

Different PRs proceed independently. Stale work for the same PR is coalesced.

## Verification

- `node --test .github/scripts/pr-ready-reviewer-guard.test.mjs` — 57 tests, 51 passing unchanged + 6 new
- `npm run verify:fast` — 1,297 tests, all passing
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-19-scope-pr-guard-to-triggering-pr.review-ledger.json` — valid 2-apple ledger

## Unresolved issues

None.
