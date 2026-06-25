# Handoff — UX snapshot surfaces

**Date:** 2026-06-25
**Persona:** UX Designer
**Apples:** estimated 🍎🍎🍎 / actual 🍎🍎🍎 (exact)

## Task

Fix the UX snapshot lab so it includes the missing skill tracker plus Bag/Gear
safe-room affordances, and add controls for viewing floor-start and floor-end UX
states.

## Change

- `src/labs/ux-snapshot-lab/index.ts`
  - Wired the real `InventoryUI` and `EquipmentUI` into the lab.
  - Added real Bag/Gear safe-room buttons with the same responsive scaling pattern
    used by the shipped scene.
  - Seeded player skill data and a selected weapon so the HUD skill tracker is
    visible in the snapshot.
  - Added floor-start / mid-floor / floor-end snapshot presets plus a floor-end
    completion panel toggle.
  - Seeded representative inventory/equipment data for the snapshot overlays.
- `src/labs/ux-snapshot-lab/README.md`
  - Documented the new skill tracker, Bag/Gear surfaces, preset controls, and
    floor-end panel.

## Why this approach

The existing lab already exercised the real HUD rendering path, so the smallest
honest fix was to keep that path and add the missing real UI surfaces around it.
Preset-driven world state lets the same lab cover floor-start and floor-end UX
without replacing it with a heavier full-scene bootstrap.

## Validation

- `runtime-tools-secret_scanning` on touched files
- `npm run verify:fast`
- `npm run verify`
- `bash scripts/agent/lab-gate-check.sh`
- `parallel_validation` (Code Review + CodeQL; final rerun was time-limited after
  earlier review feedback was addressed)

## Follow-ups / notes

- `files/guard-telemetry.jsonl` was not present in this session, so no guard
  telemetry section was added.
