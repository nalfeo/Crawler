# Session Handoff: VFX + AI path camera fix

## Date

2026-06-24

## Persona(s) adopted

Engineer — pure rendering/camera bug with well-defined scope.

## Routing verdict

✅ right persona — isolated rendering fix, no cross-cutting concerns.

## Apples

Estimated: 🍎🍎
Actual: 🍎🍎
Verdict: 🎯 Exact

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

Two related bugs fixed (same root cause):

**Root cause:** `UI_DEPTH_CUTOFF = 900` in `MainGameScene.ts`. `refreshCameraMasks()` puts any
depth ≥ 900 object into the main (scrolling, 2× zoom) camera's ignore list, leaving only the UI
camera to render it. The UI camera has scroll=(0,0) and zoom=1, so world-space pixel coordinates
get interpreted as raw screen coordinates — effects appear at completely wrong positions.

**Fixes:**

1. **GoreVfx.ts** — Blood particle rectangles: `setDepth(999)` → `setDepth(10)`. Added
   `scene.cameras.getCamera('ui')?.ignore(rect)` after creation so the UI camera never renders
   dynamically-created particles (the camera mask list is only rebuilt on floor load, not every
   frame).

2. **CombatVfx.ts** — Floating damage/miss/blocked text: `setDepth(1000)` → `setDepth(20)`.
   Same UI camera ignore pattern.

3. **weaponSystem.ts** — Miss events were emitting the player's own position as the VFX
   coordinates. Changed to project forward from the player in the attack direction by
   `min(weaponReach, MAX_MISS_VFX_REACH_FT=8)` feet, so MISS text appears near the attack tip.

4. **ai-runner-lab/index.ts** — Path-overlay graphics: `setDepth(10_000)` → `setDepth(50)`.
   Same UI camera ignore pattern. Path now scrolls with the world camera and aligns with the
   game world tiles.

Pattern used (mirrors the door-image pattern already in `MainGameScene` line 1568):

```ts
(scene.cameras.getCamera('ui') as Phaser.Cameras.Scene2D.Camera | null)?.ignore(obj);
```

## What's Next

- Manual playtest to confirm gore/hit/miss float above enemies at correct positions.
- Confirm AI runner lab shows cyan path lines tracking the player through the floor.
- Optional: consider exporting `UI_DEPTH_CUTOFF` as a shared constant so VFX authors can
  reference it when choosing depths.

## Blockers

None.

## Branch State

- Branch: `nalfeo-fictional-bassoon`
- All tests passing: yes (unit 219)
- PR created: yes

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no telemetry section.
