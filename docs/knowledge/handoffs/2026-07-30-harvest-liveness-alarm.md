# Stale-session harvest liveness alarm

**Date:** 2026-07-30
**Apples:** 3🍎 (estimated) / 3🍎 (actual) — new CI-recovery liveness subsystem + workflow wiring + regression coverage

## Systems touched

ci-automation, ci-recovery, merge-train

## Context

Follow-up hardening for the 2026-07-30 work stoppage documented in
`2026-07-30-merge-train-work-stoppage-rate-limit.md`. That incident was resolved
by moving CI Recovery's read traffic off the shared owner-PAT rate-limit bucket
(`9d30add61`). This session closes the _detection_ gap: nothing noticed the
outage for ~7 hours.

## Problem

CI Recovery is the repository's stale-session harvester. It expires shepherd
leases, releases stalled automation ownership, reconciles review threads, and
applies the `merge-train` admission label. When it stops, delivery stops.

Two liveness mechanisms existed, and neither could detect the harvester being
dead:

1. **`loop-incident-lib.mjs`** files a per-PR incident when recovery makes no
   progress — but it runs _inside_ the reconciler and authenticates with
   `CRAWLER_CI_PAT`. When the PAT budget was exhausted, the reconciler could not
   run, so it could not file the incident reporting that it could not run.
2. **`ci-liveness-sweep.yml`** re-dispatches the reconciler every 10 minutes, but
   fire-and-forget: every step dispatches and never checks whether any dispatch
   succeeded. It kept firing into the void for the entire outage.

The only alarm that did fire was the merge train's _own_ empty-train incident
(#2383), which is what surfaced the seed PRs during recovery. The harvester
itself was silent.

A second, compounding defect: `isRetryableError()` in `router.mjs` treated a
primary rate-limit 403 as transient. Because `CRAWLER_CI_PAT` is a classic user
PAT, its 5,000 req/hr budget is enforced at the _user_ level and shared across
every token that user owns; once exhausted it only refills at
`x-ratelimit-reset`, up to an hour later. Retrying 6 times capped at 30s could
never outlast the reset, and burned 6 requests per call against an already-empty
budget — the retry logic was deepening the outage it was waiting on.

## Changes

### 1. Fail fast on primary rate-limit exhaustion

`.github/scripts/ci-recovery/router.mjs`

- New exported `isPrimaryRateLimitExhausted(error)` — true for a 403 whose
  `x-ratelimit-remaining` header is `0`.
- `isRetryableError()` now returns `false` for that case, so the call surfaces
  immediately instead of grinding. Secondary rate limits (short-lived, carry
  `retry-after`) stay retryable even at zero budget, and a rate-limit 403 that
  still has budget remaining is still treated as transient.

### 2. Harvest liveness alarm

`.github/scripts/ci-recovery/harvest-liveness.mjs` (new)

Pure, unit-tested decision logic plus a managed-incident upsert:

- `summarizeHarvestRuns(runs, now)` — last successful run, minutes since, and
  failures since. Counts `cancelled` / `timed_out` / `startup_failure` as
  non-completions (the reconciler's `queue: single` concurrency cancelled
  post-merge passes during the incident). Ignores in-progress runs.
- `evaluateHarvestLiveness({summary, backlogCount, thresholdMinutes})` — alarms
  only when open non-draft PRs are actually waiting, mirroring the merge train's
  empty-train incident so a quiet repo never produces a 10-minute false alarm.
- `reconcileHarvestIncident(...)` — idempotent create/update/auto-close of a
  single `ci-incident` issue, matched by title **and** body marker.

The incident body leads with the shared user-PAT bucket as the first thing to
check, and explicitly warns that `gh api rate_limit` is misleading (it reported
~4,400 core remaining while live calls returned `X-RateLimit-Remaining: 0`) —
raw response headers are the reliable check, and GraphQL is the fallback bucket.

### 3. Wire it into the sweep

`.github/workflows/ci-liveness-sweep.yml`

- Added `actions/checkout@v4` (the sweep previously made only API calls).
- `permissions.issues` raised `read` → `write` so the alarm can file.
- New final step runs the alarm on the workflow's own `GITHUB_TOKEN`.

**The token choice is the whole point.** `GITHUB_TOKEN`'s budget is scoped per
repository installation and is independent of the owner-PAT bucket, so the alarm
survives the exact failure it exists to report. A regression test asserts the
step never references `CRAWLER_CI_PAT` or an App token.

Threshold is 60m, overridable via the `HARVEST_LIVENESS_THRESHOLD_MINUTES`
repository variable.

## Verification

- `node --test .github/scripts/ci-recovery/*.test.mjs` → **644 tests, 0 fail**
  (42 pre-existing skips). Includes 20 new tests in `harvest-liveness.test.mjs`
  and 4 new router tests.
- New tests reproduce the incident shape directly: "every run fails with backlog
  waiting" → `stalled: true, reason: no-successful-run-in-window`, and
  "last success older than threshold" against the real 09:42Z → 17:00Z gap.
- `npx eslint` on all changed files → clean.
- `npm run format:check` → clean.
- `npm run verify:fast` → passed.
- `.github/scripts/ci-recovery/*.test.mjs` is already globbed by
  `npm run test:guards`, so the new suite is picked up by CI with no wiring.

## Follow-ups (unchanged from the incident handoff)

- Move the remaining `CRAWLER_CI_PAT` consumers' reads to the App token
  (`action-required-retrigger.mjs`, `incident.mjs`, `issue-intake.mjs`,
  `pr-ready-reviewer-guard.yml`, `sprite-queue-reconciler.yml`, `asset-request.yml`,
  `theme-equipment.yml`, `docs-update.yml`, `nightly-*`).
- Debounce the per-review-comment CI Recovery dispatch storm — one
  `pull_request_review_comment:created` event still produces one full run, and a
  reviewer burst produced runs every ~20s that all exited
  `skip pr=#N reason=duplicate-fingerprint`.

## Environment note

`npm ci` fails in this environment: the Microsoft npm proxy returns 404 for
`postcss-8.5.25.tgz` (`packagefeedproxy.microsoft.io`). Unrelated to these
changes. Worked around locally by copying `node_modules` from the main checkout;
CI installs from the real registry normally.
