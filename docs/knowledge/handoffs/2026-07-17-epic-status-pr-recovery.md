# Session Handoff: epic-status PR recovery

**Date:** 2026-07-17  
**Session slug:** epic-status-pr-recovery  
**Branch:** copilot/add-durable-speculative-tracking  
**PR:** #1284  
**Apples:** 🍎🍎 estimated → 🍎🍎 actual (exact)

## Systems touched

epics

## What Was Done

- Hardened `scripts/agent/epics/epic-status-lib.ts` against the still-valid review blockers:
  - active ownership metadata now rejects whitespace-only `claimant`, `session`, and `scope`
  - state issue/PR refs now require the URL suffix number to match the adjacent `number` field
  - merge commit validation now requires the referenced git object to be a real `commit`
  - every evidence record is now content-verified instead of only `handoff` and `review-ledger`
  - GitHub audit now treats a later trusted `BLOCKED` comment as revoking earlier live claims
- Confirmed the stacked-work feature thread was outdated: the nullable `stacked_work` schema, validators, recovery doc, audit path, and focused tests were already present at HEAD.
- Updated the epic-state JSON Schema ownership fields to require non-empty strings when present.
- Refreshed the A0 cached test-evidence hash in `epic-state.json` to match the repaired focused test file.

## Validation

- `npm test -- tests/unit/agent/epic-status.test.ts`
- `npm run verify:fast`

## CI investigation

- Reviewed workflow runs on the PR branch with GitHub Actions MCP.
- The only historical non-green run was `Security Review Loop` run `29617267326`, which GitHub reports as `action_required` with zero jobs scheduled. That matches the repo’s known bot-push parking behavior rather than a code failure, so no code change was needed for CI itself.

## Review-thread disposition

- Fixed: whitespace-only ownership metadata
- Fixed: mismatched issue/PR number vs URL
- Fixed: non-commit merge SHA acceptance
- Fixed: CLAIMED comments not revoked by later BLOCKED comments
- Fixed: required evidence kinds accepted without immutable verification
- Outdated/already present: missing stacked-work implementation
