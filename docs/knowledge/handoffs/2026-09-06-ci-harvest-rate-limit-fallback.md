# 2026-09-06 — CI harvest liveness: degrade gracefully when assignment auth fails

## Systems touched: ci-policy

## Summary

Hardened the stale-session harvest alarm so it still files/updates the managed incident even when the repo's `CRAWLER_CI_PAT` is missing, expired, or rate-limited while the liveness sweep is still running on the workflow's `GITHUB_TOKEN`.

This keeps the alarm from failing closed on the specific class of failure it is meant to detect: a broken shared user-PAT bucket that can leave the harvester silent while PRs wait in backlog.

**Apple estimate:** 2🍎 (declared at kickoff). Actual: 2🍎.

**Verdict:** recommended. The issue defined a concrete success gate: the stale-session harvest must remain detectable even when assignment-only PAT auth is unavailable, and the alarm must still create/update the managed issue without blocking on Copilot assignment.

## Why it was happening

`reconcileHarvestIncident()` always attempted to assign a Copilot actor after creating or updating the harvest incident. That assignment path depends on `CRAWLER_CI_PAT`, so a missing or rejected token could abort the whole incident reconciliation even though the issue itself was the real signal the repo needed.

## What changed

- In `.github/scripts/ci-recovery/harvest-liveness.mjs`, `assignCopilotToIncident()` now exits early when no assignment token is present and treats assignment failures as non-fatal.
- `reconcileHarvestIncident()` now swallows assignment failures instead of failing the issue create/update path.
- Added a regression test covering the exact scenario where assignment auth is unavailable but the stale-session issue still must be created.

## Verification

- `node --test .github/scripts/ci-recovery/harvest-liveness.test.mjs` — passed.
- `bash scripts/agent/verify-fast.sh` — passed.

## Unresolved issues

None at the session boundary. The fix remains scoped to the harvest-liveness alarm and keeps the issue creation path durable even when the PAT-backed assignment lane is unavailable.