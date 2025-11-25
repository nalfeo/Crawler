# Handoff - sidecar shared selector deployment

## Date

2026-06-30

## Persona(s) adopted

Producer (cross-cutting runtime triage + small provider/test code change + PR prep).

## Apples

Estimated: 🍎 x 1  
Actual: 🍎 x 1  
Verdict: 🎯 Exact

## Systems touched

azure-infra, sprite-workflow

## What changed

- Fixed issue-ingested sprite workflow blocking on model deployment split by allowing Azure brief selector and synth to share the same deployment.
  - Updated `scripts/sprites/provider/factory.ts` to remove the same-deployment rejection in the Azure selector path.
  - Updated `tests/unit/sprites/factory.test.ts` to assert same-deployment is accepted.
- Continued workflow asset outputs from the issue pipeline run:
  - Added generated PNGs:
    - `public/assets/generated/baseball-bat-v1-var-0.png`
    - `public/assets/generated/slime-v1-var-2.png`
    - `public/assets/generated/slime-v1-var-3.png`
    - `public/assets/generated/slime-v1-var-9.png`
  - Updated generated registries:
    - `public/assets/generated/manifest.json`
    - `src/shared/data/sprite-catalog.json`
- Isolated sidecar queue usage in local env while debugging by setting:
  - `AZURE_STORAGE_QUEUE_NAME=asset-requests-15270`
  - (in `.env.local`, not committed)

## Validation

- `npx vitest run tests/unit/sprites/factory.test.ts`
- `npm run verify:fast`
- `npm run verify`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-06-30-sidecar-shared-selector-deployment.review-ledger.json`

## Review harness ledger

- `docs/knowledge/review-ledgers/2026-06-30-sidecar-shared-selector-deployment.review-ledger.json`
- Tier: 1🍎
- Required stage complete: `code_review`

## Runtime verification notes

- Sidecar/ingester now pick up the asset-request issue and proceed past synth + selector with shared deployment config.
- Issue #495 received stage comments including selected candidate and promoted brief.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 15,
  "guards": {
    "boom": {
      "crash": 2
    },
    "ctx": {
      "allow": 1
    },
    "ctx-a": {
      "allow": 1
    },
    "ctx-b": {
      "allow": 1
    },
    "edit-bad": {
      "bypass": 1
    },
    "edit-guard-self-protection": {
      "ask": 2
    },
    "pr-a": {
      "deny": 1
    },
    "pr-b": {
      "deny": 1
    },
    "pr-hard": {
      "deny": 1
    },
    "pr-warn": {
      "allow": 1
    },
    "shell-a": {
      "deny": 1
    },
    "shell-bad": {
      "deny": 2
    }
  },
  "tools": {
    "create_pull_request": 4,
    "edit": 6,
    "powershell": 5
  }
}
```
