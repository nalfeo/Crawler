# Handoff: CI Health canvas dashboard

## Date

2026-07-21

## Persona

DevOps Engineer

## Systems touched

ci-policy, devtools

## Apples

Estimated 3🍎, actual 3🍎.

## Summary

Added a shared Copilot canvas extension that presents the live Merge Train queue,
blocked and CI Recovery pull requests, active GitHub Actions runs and jobs, and
repository-visible hosted-runner pressure against a configurable cap. The
dashboard refreshes through one repository-scoped coordinator every 30 seconds,
supports forced refreshes, and links directly to the relevant GitHub pull
requests, runs, and Actions page.

The loopback renderer is bound to `127.0.0.1` and protected by a random
per-instance capability token on every HTTP and SSE route. GitHub state is read
through authenticated `gh` subprocesses without accepting arbitrary repository
input. Merge Train ordering and labels reuse the canonical train modules rather
than duplicating policy.

## Files touched

- `.github/extensions/ci-health/extension.mjs`
- `.github/extensions/ci-health/renderer.mjs`
- `.github/extensions/ci-health/lib/github-client.mjs`
- `.github/extensions/ci-health/lib/model.mjs`
- `.github/extensions/ci-health/lib/refresh-coordinator.mjs`
- `.github/extensions/ci-health/tests/*.test.mjs`
- `package.json`
- `docs/knowledge/review-ledgers/2026-07-21-ci-health-dashboard.review-ledger.json`
- `docs/knowledge/handoffs/2026-07-21-ci-health-dashboard.md`

## Behavior and design

- Polls no slower than every 30 seconds while at least one canvas instance is
  subscribed; repository instances share in-flight work and one timer.
- A forced refresh during an active poll schedules one follow-up refresh rather
  than starting duplicate GitHub API work.
- Shows canonical FIFO train position, sticky-comment health, validation state,
  blocked entries, and open or closed recovery-pending entries.
- Separates active workflow runs from repository-visible hosted jobs. Runner
  occupancy is explicitly scoped to visible jobs in this repository rather than
  claiming organization-wide capacity.
- Surfaces queued workflow runs even before GitHub exposes their job records,
  partial status-fetch failures, API safety-cap truncation, and state-transition
  count mismatches.
- Restores refresh controls on HTTP failure, SSE reconnect, and settled
  background refreshes; preserves structured GitHub diagnostics from failed
  refresh responses.
- Guards action results against an instance closing while an asynchronous
  refresh is in flight.

## Runtime observation

Before the final lifecycle fixes, the live canvas could remain visually stuck
on `Refreshing…` after the coordinator had already settled because the SSE
update was emitted before the in-flight flag cleared. A separate browser pass
also exposed ambiguous workflow/job count wording and a queued run with no
visible jobs that did not become the bottleneck.

After the fixes, the live `project:ci-health` canvas:

- advanced `fetchedAt` automatically on the 30-second cycle;
- completed `POST /api/refresh` with the button returning to `Refresh now`;
- reported queued workflow runs before job visibility;
- used unambiguous active-run and hosted-job counts;
- showed no current-page console errors or failed API requests.

The observed live repository state changed during refreshes, as expected:
roughly 4-8 active runs, 3-9 visible hosted jobs running against cap 20, no
visible hosted jobs queued, no Merge Train candidates, and 12 CI Recovery pull
requests.

## Validation

- `npm run test:ci-health`: 19/19 passing.
- `npm run verify:fast`: passing.
- Browser accessibility snapshot, direct links, manual refresh, SSE refresh,
  console, and network behavior inspected against the live extension.
- Review ledger validates as a 3🍎 plan + code-review ledger.

## Review

The separate-model plan review produced six concerns, all incorporated before
implementation. The bounded code-review loop used
`claude-sonnet-4.6`. Round 1 found one refresh-control failure path, which was
fixed. Round 2 confirmed that fix and found three additional runtime error paths
plus the intentionally incomplete ledger. All code findings were fixed with
regression coverage. Because new concerns appeared at the two-round cap, the
ledger escalated to the human; the maintainer explicitly accepted the fixes and
authorized PR creation.

## Follow-up

The configured runner cap is a comparison threshold, not an account-wide
occupancy API. If GitHub later exposes authoritative organization runner
capacity to this token, add it as a separately labeled metric rather than
changing the meaning of the repository-visible count.
