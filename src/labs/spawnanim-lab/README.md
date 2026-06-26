# Spawn Animation Lab

Sandbox for the baby-slime **spawn-in animation** (pop-out + wiggle) introduced for
the slime split.

When a slime dies it can split into two baby slimes (`dropSystem.maybeSplitSlime`).
The babies are smaller than a full slime and, while they emerge, they:

- **pop out** — grow from nothing, overshoot slightly, then settle (ease-out-back),
- **wiggle** — a decaying jelly squash/stretch.

The animation is **purely cosmetic** — it grants no invulnerability. Babies survive
only the single swing that killed their parent, via swing-immunity owned by
`dropSystem` + `meleeSwingSystem` (`markImmuneToActiveMeleeSwings`), not by this
animation.

The animation timing is owned by the deterministic `spawnAnimSystem`
(`src/core/systems/spawnAnimSystem.ts`), which counts the timer down and strips the
`SpawnAnim` component on expiry, and the pop/wiggle math lives in
`src/shared/spawn-anim.ts` so the renderer (`PhaserBridge`) and this lab share one
source of truth.

## Run

```
npm run lab        # then open ?lab=spawnanim-lab
```

## Controls

| Control          | Effect                                                           |
| ---------------- | ---------------------------------------------------------------- |
| Anim (ms)        | Spawn animation duration                                         |
| Wiggle amplitude | Strength of the jelly squash/stretch                             |
| Wiggle cycles    | Number of oscillations across the animation                      |
| Baby size scale  | Final baby size relative to a full slime (dashed reference ring) |
| Auto split (ms)  | Auto-trigger a split on an interval (0 = off)                    |
| Paused           | Freeze the countdown                                             |
| Split now        | Spawn two babies immediately                                     |
| Clear            | Remove all babies                                                |

The cyan ring marks a baby whose spawn animation is still in progress; it
disappears the moment the animation settles, exactly when `spawnAnimSystem` removes
the `SpawnAnim` component.
