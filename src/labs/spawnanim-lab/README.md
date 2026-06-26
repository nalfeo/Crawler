# Spawn Animation Lab

Sandbox for the baby-slime **spawn-in animation** and **spawn invulnerability**
introduced for the slime split.

When a slime dies it can split into two baby slimes (`dropSystem.maybeSplitSlime`).
The babies are smaller than a full slime and, while they emerge, they:

- **pop out** — grow from nothing, overshoot slightly, then settle (ease-out-back),
- **wiggle** — a decaying jelly squash/stretch, and
- are **invulnerable** until the animation finishes.

The timing and the strip of invulnerability are owned by the deterministic
`spawnAnimSystem` (`src/core/systems/spawnAnimSystem.ts`), and the pop/wiggle math
lives in `src/shared/spawn-anim.ts` so the renderer (`PhaserBridge`) and this lab
share one source of truth.

## Run

```
npm run lab        # then open ?lab=spawnanim-lab
```

## Controls

| Control            | Effect                                                           |
| ------------------ | ---------------------------------------------------------------- |
| Anim / invuln (ms) | Spawn animation duration === invulnerability window              |
| Wiggle amplitude   | Strength of the jelly squash/stretch                             |
| Wiggle cycles      | Number of oscillations across the animation                      |
| Baby size scale    | Final baby size relative to a full slime (dashed reference ring) |
| Auto split (ms)    | Auto-trigger a split on an interval (0 = off)                    |
| Paused             | Freeze the countdown                                             |
| Split now          | Spawn two babies immediately                                     |
| Clear              | Remove all babies                                                |

The cyan ring marks a baby that is still invulnerable; it disappears the moment
the animation settles, exactly when `spawnAnimSystem` removes `Invincible`.
