# 2026-06-29 - Sprite resize axis priority

## Summary

- Updated sprite postprocess resize behavior so variant shapes prioritize occupancy:
  - wide: lock width, allow height growth
  - tall: lock height, allow width growth
  - large (128x128+ square): cover-style occupancy
  - default shapes keep nearest-fit behavior
- Updated `dimensions-exact` sensor semantics to match these contracts.
- Updated prompt wording for wide/tall/large outputs so text matches postprocess behavior.
- Added and expanded unit tests for wide/tall/large behavior and anchor compatibility.
- Added/validated 2-apple review ledger:
  `docs/knowledge/review-ledgers/2026-06-30-sprite-resize-axis-priority.review-ledger.json`.

## Files touched

- `scripts/sprites/postprocess.ts`
- `scripts/sprites/sensors/common.ts`
- `scripts/sprites/build-prompt.ts`
- `tests/unit/postprocess-resize-fit.test.ts`
- `tests/unit/sprites/build-prompt.test.ts`
- `docs/knowledge/review-ledgers/2026-06-30-sprite-resize-axis-priority.review-ledger.json`

## Verification run

- `npm run verify:fast`
- `npm run verify`
- `bash scripts/agent/lab-gate-check.sh`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-06-30-sprite-resize-axis-priority.review-ledger.json`

## Unresolved issues

- None identified for this scope.

## Recommended next steps

- Reprocess recent wide/tall/large candidate runs in devtools and visually confirm occupancy improvements on representative briefs.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 32,
  "guards": {
    "boom": {
      "crash": 4
    },
    "ctx": {
      "allow": 2
    },
    "ctx-a": {
      "allow": 2
    },
    "ctx-b": {
      "allow": 2
    },
    "edit-bad": {
      "bypass": 2
    },
    "edit-guard-self-protection": {
      "ask": 4
    },
    "pr-a": {
      "deny": 2
    },
    "pr-b": {
      "deny": 2
    },
    "pr-hard": {
      "deny": 2
    },
    "pr-preflight": {
      "deny": 1
    },
    "pr-review-ledger": {
      "allow": 1
    },
    "pr-warn": {
      "allow": 2
    },
    "shell-a": {
      "deny": 2
    },
    "shell-bad": {
      "deny": 4
    }
  },
  "tools": {
    "create_pull_request": 10,
    "edit": 12,
    "powershell": 10
  }
}
```
