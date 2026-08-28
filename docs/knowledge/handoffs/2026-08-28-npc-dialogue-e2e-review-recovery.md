# Session Handoff: NPC Dialogue E2E Review Recovery

## Date

2026-08-28

## Persona

QA Engineer

## Systems touched

hud-ux

## Apples

1🍎 exact — the repair remained a one-file E2E synchronization adjustment.

## What Was Done

Changed the NPC dialogue E2E to poll the rendered Talk-control bounds after Escape, before using them for the next click. The focused real `main-scene-probe-lab` E2E artifact passed the full UI-exclusivity file (21 tests).

## Key Decisions Made

Kept the explicit dialogue-close state wait and added a rendered-control poll, because the scene exposes `conversationOpen: false` one update before it makes Talk visible.

## What's Next / Blockers

No blockers.

## Retrospective

### Lessons Learned

State completion and rendered-control readiness can fall on adjacent Phaser update frames; controls clicked by bounds must be polled independently.

### Mistakes Made

The earlier repair re-read bounds after the close-state wait but did not retry if the rendering frame had not executed.

### Opportunities for Future Improvement

Use rendered-affordance polling for E2E clicks that follow asynchronous UI transitions.
