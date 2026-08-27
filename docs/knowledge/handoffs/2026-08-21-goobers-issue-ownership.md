# Handoff: Goobers issue ownership

## Systems touched: ci-policy, mcp-tooling, agent-personas

## Apples

Estimated: 3🍎 — actual: 3🍎. Added a versioned, local Goobers feature-to-PR
workflow and made the GitHub issue intake boundary explicit.

## Summary

- `.goobers/` is the complete credential-free desired-state source for the
  manual-only `crawler-feature-pr` workflow: approved issue, producer,
  implementer, reviewer, deterministic `npm run verify:fast`, ready-for-review
  PR, and issue close-out. It never merges a PR.
- The source uses `gaggles/crawler` as both its internal and user-facing name.
  Cutover requires explicitly archiving or removing the legacy `example`
  runtime state before materialization, preventing stale claims or journals
  from leaking across the rename.
- The trusted Cloud Copilot issue intake rejects `goobers:approved` issues in
  both normal intake and dependency-unblock retries, before any dependency
  query or assignment action.

## Verification

- `Q:\src\Goobers\bin\goobers.exe validate --source-tree .goobers` — passed.
- `node --test .github/scripts/ci-recovery/issue-intake.test.mjs` — 31 passed.
- `npm run verify:fast` — passed.

## Cutover

1. Merge this PR before adding `goobers:approved` to production issues.
2. Audit and clear any existing Cloud Copilot assignment before labeling an
   issue for Goobers; the new intake guard only prevents future assignment.
3. Stop the Goobers daemon, configure its external instance at
   `C:\goobers\crawler` to use this source tree through guided local-source
   setup, validate `.goobers`, and materialize it. Do not copy runtime journals,
   workcopies, scheduler state, telemetry, or tokens into the repository.

## Follow-up

No follow-up is currently needed.
