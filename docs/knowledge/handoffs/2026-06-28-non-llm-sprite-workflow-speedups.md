# Handoff — Non-LLM sprite workflow speedups

**Date:** 2026-06-28 · **Persona:** Producer

## Apples

Estimated 🍎🍎 (Small). Actual 🍎🍎. Verdict 🎯 Exact — three targeted files for queue polling and approve hydration I/O reductions.

## Systems touched

sprite-pipeline

## Summary

Optimized non-LLM workflow latency in sprite generation by removing expensive broad store scans from queued polling and reducing remote approve hydration scope.

## Fix

- Added sidecar endpoint `GET /api/workflow/latest-run` to return the newest run for one `briefId` since a requested timestamp.
- Switched queued-generate polling in devtools to call the new targeted endpoint instead of repeatedly listing all runs and filtering client-side.
- Changed remote approve hydration to fetch only required files for the selected variant (`summary.json`, processed PNG, anchor sidecars), not the entire run directory.
- Preserved error semantics for malformed/unsafe keys and non-optional remote failures.

## Files touched

- `scripts/sprites/sidecar/server.ts`
- `src/devtools/sprite-approval-api.ts`
- `src/devtools-main.ts`

## Verification

- `npm run verify:fast` ✓
- `npm run verify` ✗ (fails at dead-code gate with large pre-existing unused-file/unused-export set unrelated to these changes)

## Unresolved / next steps

- Investigate and baseline/fix dead-code gate failures in a dedicated follow-up to restore clean `npm run verify` in this workspace state.

## Agent-OS Telemetry

Guard telemetry artifact: `files/guard-telemetry.jsonl`

```json
{
  "schema": "agent-os-guard-telemetry-summary/v1",
  "artifact": "files/guard-telemetry.jsonl",
  "events": 1,
  "guards": {
    "pr-preflight": {
      "deny": 1
    }
  },
  "tools": {
    "create_pull_request": 1
  }
}
```
