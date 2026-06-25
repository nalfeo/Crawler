# BT Exploration Lab

Visualises the Behavior-Tree AI's four exploration directives (C1–C4), driven by
the **pure decision kernels** in [`src/game/ai/exploration.ts`](../../game/ai/exploration.ts)
— the same functions `BehaviorTreeAI` delegates to in production. No Phaser, no
ECS: the lab runs a tiny deterministic fog-of-war simulation so the kernels are
the only moving parts.

Open with `npm run lab` → `?lab=bt-exploration`.

## What it shows

| Directive                         | Kernel                                         | In the lab                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1** unexplored-tile preference | `findNearestFrontierTile`                      | Green target tile + dashed line; recomputed every frame as fog clears while the walker auto-explores.                                                               |
| **C2** minimap / POI seeking      | `pickNearestPoi`                               | Purple line to the nearest still-relevant POI inside the blue scan radius. Click a POI to toggle it handled/needed.                                                 |
| **C3** locked-door memory         | `updateLockedDoorMemory` / `isDoorKnownLocked` | Doors render red once remembered as locked; they block the BFS so the far chamber stays unreachable. Unlock one (Doors folder) and the frontier search re-opens it. |
| **C4** stuck / wiggle reduction   | `nextStuckFrames` / `DwellTracker`             | Live `stuckFrames` + dwell readout. Flip **Wiggle in place** to oscillate the walker inside the escape circle and watch the dwell watchdog accumulate and `fire`.   |

## Controls (lil-gui)

- **Reveal radius / Walk speed** — tune the auto-explorer.
- **POI scan radius** — C2 selection radius.
- **Dwell escape (px) / Dwell frame limit** — rebuild the `DwellTracker`; lower
  the frame limit to make C4 fire sooner.
- **Wiggle in place (C4)** — force an oscillation deadlock to exercise the watchdog.
- **Doors (C3)** — lock/unlock each door at runtime.
- **Reset scenario** — restart the sweep.

## Determinism

The layout is fixed and the wiggle motion is a sine of the frame counter — no
`Math.random`, no `Date.now`. The same controls always produce the same sweep.
