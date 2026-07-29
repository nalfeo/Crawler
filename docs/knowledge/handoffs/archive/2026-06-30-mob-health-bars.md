# Handoff: mob health bars under enemies

**Date:** 2026-06-30  
**Persona:** UX Designer  
**Apples:** estimated 🍎🍎 / actual 🍎🍎

## Systems touched

enemies

## Summary

Added world-space health bars under mob enemies so players can read enemy HP at a glance in combat, while explicitly excluding bosses because boss health is already represented in the top HUD boss bar.

## Files touched

- `src/engine/PhaserBridge.ts`
- `tests/fixtures/phaser-bridge-harness.ts`
- `tests/unit/phaser-bridge.test.ts`
- `docs/knowledge/review-ledgers/2026-06-30-mob-health-bars.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-06-30-mob-health-bars.json`

## Review harness

- Ledger: `docs/knowledge/review-ledgers/2026-06-30-mob-health-bars.review-ledger.json`
- Stages: `plan_review`, `code_review`
- Validation: `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-06-30-mob-health-bars.review-ledger.json` ✅

## What changed

- Added per-enemy `Graphics` health bars in `PhaserBridge`:
  - Rendered directly below non-boss enemy sprites.
  - Width tracks enemy display width with min/max clamps.
  - Fill color bands: green (>50%), amber (25%-50%), red (<25%).
  - Bars follow visibility/alpha and are removed for dead/hidden/boss enemies.
- Added lifecycle cleanup for mob bars on entity removal and bridge destroy.
- Extended test fixture with optional `MockGraphics` support (`withGraphics`) so bridge graphics behavior can be asserted.
- Added unit coverage asserting non-boss enemies receive bars while boss-tagged enemies do not.

## Verification run

- `npm run verify:fast` ✅
- `npm run verify` ✅ (after adding this required handoff)
- `bash scripts/agent/lab-gate-check.sh` ✅

## Unresolved issues

- None identified for this scope.

## Recommended next steps

1. Quick visual pass in `npm run dev` to tune bar offset/width if specific enemy art scales need polish.

## Branch state

- Branch: `nalfeo-mob-health-bars`
- PR created: pending

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
