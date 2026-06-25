# Handoff: Quest Indicator Offset — 2026-06-25

## Session Summary

Moved Floor 1 quest exclamation markers closer to NPC heads so the affordance reads
as attached to the character instead of floating too high above them.

## Apple Estimate

- Declared: 🍎
- Actual: 🍎
- Verdict: **on-estimate**. Single-file UI offset tweak with standard validation.

## What Shipped

- `src/engine/scenes/MainGameScene.ts`
  - Reduced the vertical quest-indicator offset in `updateNpcQuestIndicators()`
    so the exclamation bottom now sits closer to each NPC's head while preserving
    the existing bob animation and coloring behavior.

## Validation

- `bash scripts/agent/preflight.sh`
- `npm run verify:fast`
- `npm run verify`
- `bash scripts/agent/lab-gate-check.sh`
- Secret scan: `src/engine/scenes/MainGameScene.ts`

## Notes

- No guard telemetry handoff section was required because
  `files/guard-telemetry.jsonl` was not present in this session.
