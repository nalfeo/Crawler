# Handoff: Remove enemy orientation-axis sensor gating

**Date**: 2026-06-28  
**Session**: remove-enemy-orientation-axis-sensor  
**Persona**: Producer  
**Apples**: 🍎🍎 estimated -> 🍎🍎 actual (exact)

## Systems touched

enemies, mobile-ux

## Summary

Removed `silhouette-orientation-axis` scoring from `enemy` briefs so enemy candidates are no longer rejected for not being vertically aligned. Character orientation checks remain unchanged.

## Files touched

- `scripts/sprites/score-candidate.ts`
  - Orientation-axis sensor now runs only for `character` briefs.
- `tests/unit/sprites/score-candidate.test.ts`
  - Updated enemy tests to assert no orientation-axis sensor is included, including when `sensors.enemy.facing: front`.
  - Removed redundant enemy-default-facing test that is no longer applicable.
- `scripts/sprites/brief-schema.ts`
  - Updated `sensors.enemy` comment to reflect that enemy scoring no longer uses orientation-axis gating.

## Verification run

- `npm run verify:fast` (pass)
- `npm run verify` (pass)

## Unresolved issues

- None.

## Recommended next steps

- Monitor the next enemy sprite generation runs to confirm reduced false rejects from orientation-axis checks.

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
