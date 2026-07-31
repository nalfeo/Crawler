# Handoff: Add checked-in state to asset workflow

**Date:** 2026-06-30  
**Persona:** Producer  
**Apples:** estimated 🍎🍎 / actual 🍎🍎 (exact)

## Goal

Add a persistent "checked in" state in the sprite asset workflow so, once check-in files an `asset-checkin` issue, the workflow tracks that filed issue and marks affected approved items accordingly.

## What changed

### Workflow state + persistence

- Added `checked-in` to the sprite workflow queue stage machine in `src/devtools/sprite-workflow-queue.ts`.
- Added persisted check-in metadata fields to queue items:
  - `checkinBranch`
  - `checkinIssueUrl`
  - `checkinIssueTitle`
  - `checkinIssueBody`
  - `checkinSummary`
- Mapped `checked-in` to the same stepper milestone as `approved`/`tagging`, and kept Tag available from `checked-in`.

### Check-in issue tracking

- Extended check-in payload metadata in `scripts/sprites/checkin.ts` to include:
  - `state: "checked-in"`
  - `filedAt` ISO timestamp
- Updated parser validation in `scripts/sprites/asset-issues.ts` to accept/validate the optional fields.
- Extended sidecar `/api/checkin` response in `scripts/sprites/sidecar/server.ts` to return filed issue title/body in addition to branch/url/assets.
- Extended client contract in `src/devtools/sprite-approval-api.ts` with `issueTitle` and `issueBody`.

### Devtools workflow wiring

- On `Check in to GitHub` success (`src/devtools-main.ts`), queue items now:
  - match returned assets to approved items (path-normalized),
  - transition from `approved` -> `checked-in`,
  - persist filed issue metadata and summary.
- Kept the dedicated check-in result banner/link behavior.
- Cleared stale check-in metadata on re-synthesize/regenerate/restart paths.
- Fixed interrupted-tagging recovery:
  - tagging from approved/check-in restores to the correct stable pre-tag stage on reload,
  - tagging from done now restores to done (no regression to checked-in).

### Tests

- Updated/expanded unit coverage in:
  - `tests/unit/devtools-sprite-workflow-queue.test.ts`
  - `tests/unit/devtools-sprite-approval-api.test.ts`
  - `tests/unit/sprites/asset-issues.test.ts`

### Review harness + ledger

- Ledger created and validated for 2-apple tier:
  - `docs/knowledge/review-ledgers/2026-06-30-asset-checked-in-state.review-ledger.json`
- Recorded:
  - `plan_review` (concerns addressed),
  - `code_review` loop (clean final round).

## Validation run

- `npm run verify:fast`
- `npm run verify`
- `bash scripts/agent/lab-gate-check.sh`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-06-30-asset-checked-in-state.review-ledger.json`

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 45,
  "guards": {
    "boom": {
      "crash": 6
    },
    "ctx": {
      "allow": 3
    },
    "ctx-a": {
      "allow": 3
    },
    "ctx-b": {
      "allow": 3
    },
    "edit-bad": {
      "bypass": 3
    },
    "edit-guard-self-protection": {
      "ask": 6
    },
    "pr-a": {
      "deny": 3
    },
    "pr-b": {
      "deny": 3
    },
    "pr-hard": {
      "deny": 3
    },
    "pr-warn": {
      "allow": 3
    },
    "shell-a": {
      "deny": 3
    },
    "shell-bad": {
      "deny": 6
    }
  },
  "tools": {
    "create_pull_request": 12,
    "edit": 18,
    "powershell": 15
  }
}
```
