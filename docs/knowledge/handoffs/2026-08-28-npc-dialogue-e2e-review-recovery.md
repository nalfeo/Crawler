# Session Handoff: NPC Dialogue E2E Review Recovery

## Date

2026-08-28

## Persona

QA Engineer

## Systems touched

ci-policy, hud-ux

## Apples

1🍎 exact — the repair remained a one-file E2E synchronization adjustment.

## What Was Done

Changed the NPC dialogue E2E to retry keyboard actions until the scene observes their expected state, then poll the rendered Talk-control bounds before using them for the next click. The focused real `main-scene-probe-lab` E2E artifact passed the full UI-exclusivity file (21 tests).
Also fixed the strict-nullability guards in the release-sweep capacity wiring test exposed by rebasing onto current `main`.

## Key Decisions Made

Kept real keyboard interaction coverage, but retry it because a one-shot Playwright key event can be cleared before Phaser samples `JustDown`; add a rendered-control poll because the scene exposes `conversationOpen: false` one update before it makes Talk visible.

## What's Next / Blockers

No blockers.

## Retrospective

### Lessons Learned

State completion and rendered-control readiness can fall on adjacent Phaser update frames; controls clicked by bounds must be polled independently.

### Mistakes Made

The earlier repair held a single key-down, which did not retry if its first event was cleared before the scene sampled it.

### Opportunities for Future Improvement

Use rendered-affordance polling for E2E clicks that follow asynchronous UI transitions.
