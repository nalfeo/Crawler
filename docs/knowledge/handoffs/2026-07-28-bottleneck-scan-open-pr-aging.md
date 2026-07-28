# bottleneck-scan: open-PR aging panel

**Date:** 2026-07-28
**Apples:** 2🍎 estimated / 2🍎 actual
**Branch:** `copilot/fix-2173`

## Systems touched

velocity

## Problem

`scripts/agent/velocity/bottleneck-scan.ts` measured only **merged PRs**. That is
textbook survivorship bias. An 18-PR, 64-hour delivery stall on 2026-07-27/28 ran
completely unnoticed because none of the stalled PRs had merged, so none appeared in any
velocity report.

## What shipped

An **open-PR aging panel** added to the bottleneck scan:

- `computeOpenPrAging(prs, now)` — pure, deterministic function; p50/p90/max age,
  count above the 4h first-alert threshold, blocking-label breakdown, and the top-5
  oldest open PRs with total age and idle time (`updatedAt`-based).
- `fetchOpenPrs(root)` — paginated GraphQL query mirroring the existing merged-PR fetch;
  fetches `number`, `title`, `createdAt`, `updatedAt`, and up to 100 labels per PR.
- `BottleneckReport.openPrAging` — new optional field; `null` when no open-PR data is
  supplied by the caller.
- `buildReport` updated to accept `openPrRecords` and `now` parameters, keeping it
  fully testable without live `gh` calls.
- `render` shows the panel with a prominent `⚠ STALL ALARM` line when `maxAgeH ≥ 24h`.
- `deriveFindings` adds three new findings:
  - STALL ALARM (maxAgeH ≥ 24h): names the head-of-line PR and its blocking labels
  - Watch warning (8h ≤ maxAgeH < 24h): note growing queue
  - Dominant blocker (≥ 3 PRs sharing one label): directs to the label owner
- `main` fetches open PRs via `fetchOpenPrs` before calling `buildReport`.
- SKILL.md updated to document the open-PR aging panel.

## Files changed

- `scripts/agent/velocity/bottleneck-scan.ts`
- `tests/unit/velocity/bottleneck-scan.test.ts`
- `.github/skills/bottleneck-scan/SKILL.md`

## Verification

- 25 unit tests added; all 25 pass.
- 2026-07-27 scenario simulation (18 PRs, all `ci-conflict-order-wait`, ages 2–64h):
  `computeOpenPrAging` returns `maxAgeH=64`, `deriveFindings` emits a STALL ALARM
  naming the 64h PR and the label.
- `verify:fast` — 1787 tests pass, typecheck clean.
- Review ledger: `docs/knowledge/review-ledgers/2026-07-28-bottleneck-scan-open-pr-aging.review-ledger.json`

## Unresolved issues / follow-ups

1. **Scheduled alert** (out of scope here, mentioned in the issue): once the metric
   exists, a cron-triggered alert on "oldest open PR age > N hours" would convert the
   panel from a report someone must remember to run into an actual tripwire.
2. `updatedAt` is an inactivity/idle-time metric, not true "time in current state" —
   label assignment timestamps would be more precise but require timeline events
   (heavier API query).

## Gotchas for the next agent

- `buildReport` now takes optional 3rd and 4th parameters (`openPrRecords`, `now`).
  Existing callers that pass only the first two are still correct; the defaults are
  `[]` and `new Date().toISOString()` respectively. The `generatedAt` field in the
  report now reflects the injected `now`, not a separate `new Date()` call — this is
  intentional for determinism.
- `fetchOpenPrs` fetches all pages of open PRs (up to 100 per page). On repos with
  hundreds of open PRs this is still fast, but it is unbounded. If needed, add a
  `--open-limit` flag.
