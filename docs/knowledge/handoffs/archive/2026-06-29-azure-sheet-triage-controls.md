# Handoff: Azure sheet triage controls

**Date:** 2026-06-29  
**Persona:** Producer  
**Apples:** estimated 🍎🍎🍎 / actual 🍎🍎🍎

## Systems touched

azure-infra

## Goal

Add end-to-end triage controls for Azure-backed sprite workflows:

1. Fully clear abandoned generated Azure state.
2. Filter runs by promoted/not-promoted status.
3. Permanently reject asset requests and filter by request state.
4. Keep request-manifest UI unloaded until explicitly selected.

## What Was Done

### Backend (`scripts/sprites/sidecar/*`, `scripts/sprites/worker.ts`)

- Added `POST /api/workflow/store/clear` (`scope=all|runs|workflow`) and wired lifecycle coordination:
  - stops/restarts worker + issue ingester around clear to avoid rehydration/dup races.
- Added run promotion filtering:
  - `/api/runs?promoted=all|promoted|not-promoted`
  - run rows now include `promotionState`.
  - promoted detection now parses trailing `<briefId>/<runId>` from `sourceRun` (works for Azure temp paths, not just `/runs/...`).
- Added request-manifest endpoints:
  - `GET /api/workflow/asset-requests`
  - `POST /api/workflow/asset-requests/reject`
- Extended issue-ingester state with durable `rejected` entries and added:
  - `listRequests(state?)`
  - `rejectRequest({ issueNumber, fingerprint, reason? })`
- Added ingest-state helper for worker-side reject checks:
  - `isIssueRequestRejectedIngestState(...)`
- Worker now supports `shouldSkipIssueRequest` and acks/skips rejected issue jobs before running issue pipeline.
- Added ingest-state write serialization (`withStateLock`) and moved GitHub issue fetch outside lock to avoid blocking list/reject handlers on network/subprocess latency.

### Frontend (`src/devtools-main.ts`, `src/devtools/sprite-approval-api.ts`)

- Added run triage filter in Reload-from-Azure UI (`All / Needs review/action / Already promoted`).
- Added Clear Azure state action.
- Added asset-request manifest triage panel:
  - explicit dropdown selection required before loading/rendering.
  - refresh + per-row permanent reject actions.
- API client now accepts promoted filter and exposes run `promotionState`.

### Tests

- Updated/added tests in:
  - `tests/unit/sprites/sidecar-server.test.ts`
  - `tests/unit/sprites/issue-ingester-controller.test.ts`
  - `tests/unit/sprites/worker.test.ts`
  - `tests/unit/sprites/worker-controller.test.ts`
  - `tests/unit/devtools-sprite-approval-api.test.ts`
- Added regression for Azure-style manifest `sourceRun` promotion detection.
- Added regression for worker skip path on rejected issue-request jobs.

## Verification

- `npm run verify:fast` (green)
- `npm run verify` (green)
- `bash scripts/agent/lab-gate-check.sh` (green)
- Review harness ledger validated:
  - `docs/knowledge/review-ledgers/2026-06-30-azure-sheet-triage-controls.review-ledger.json`

## Review Harness Notes

- Tier: 3 apples (`plan_review`, `code_review` required)
- Plan review performed with `gpt-5.4` (2 concerns, 2 resolved).
- Code-review loop with `claude-sonnet-4.6` completed clean in round 3.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 60,
  "guards": {
    "boom": {
      "crash": 8
    },
    "ctx": {
      "allow": 4
    },
    "ctx-a": {
      "allow": 4
    },
    "ctx-b": {
      "allow": 4
    },
    "edit-bad": {
      "bypass": 4
    },
    "edit-guard-self-protection": {
      "ask": 8
    },
    "pr-a": {
      "deny": 4
    },
    "pr-b": {
      "deny": 4
    },
    "pr-hard": {
      "deny": 4
    },
    "pr-warn": {
      "allow": 4
    },
    "shell-a": {
      "deny": 4
    },
    "shell-bad": {
      "deny": 8
    }
  },
  "tools": {
    "create_pull_request": 16,
    "edit": 24,
    "powershell": 20
  }
}
```
