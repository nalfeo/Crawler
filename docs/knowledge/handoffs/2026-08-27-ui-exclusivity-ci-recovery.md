# Session Handoff: UI Exclusivity CI Recovery

## Date

2026-08-27

## Persona

DevOps Engineer

## Systems touched

ci-policy, hud-ux

## Apples

2🍎 exact

## What Was Done

Stabilized the NPC interaction E2E by waiting for dialogue close and remeasuring the reappearing Talk control before clicking it. Observed in the real `main-scene-probe-lab` artifact through the E2E test: the focused test passes after the transition-aware assertion.

## Key Decisions Made

Kept the production interaction code unchanged because the reported failure was a test timing race between Escape dispatch and the next rendered UI update.

## What's Next / Blockers

No blockers; CI can rerun the full E2E visual shard.

## Retrospective

### Lessons Learned

Canvas-control coordinates must be sampled after an asynchronous UI transition, not reused from the pre-dialogue state.

### Mistakes Made

The original test assumed that `page.keyboard.press('Escape')` synchronously made the Talk control interactive; CI exposed that the scene consumes this input on its next update frame.

### Opportunities for Future Improvement

Other E2E tests that click a control immediately after closing an overlay could use the same rendered-state synchronization pattern.
