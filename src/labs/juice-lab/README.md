# Juice Lab

Preview sandbox for the `EffectsVfx` "juice" library (`src/engine/EffectsVfx.ts`).

## What it tests

The generic VFX-effect pipeline and every Phase 1 preset:

- **Pickup sparkle** — gem (cyan), gold, item (white) collect twinkle
- **Level-up burst** — golden ring + flash + rising motes
- **Hit spark** — bright impact spark on a weapon hit
- **Crit burst** — extra orange spark fan on a critical hit
- **Death pop** — expanding, blood-tinted pop ring + scatter
- **Player hurt** — throttled red camera flash + shake

## How to use

Run `npm run lab` and open `?lab=juice-lab`.

- The **Trigger** folder has one button per effect; each fires once at screen centre.
- The **Auto-fire** folder runs a continuous, randomised mix to stress-test
  density (the Vampire-Survivors "screen chaos" target from the art style guide).
  Tune the rate (ms between effects).

## Notes

The lab pushes `VfxEvent`s onto `world.vfxEvents` and `CombatEvent`s onto
`world.combatEvents`, then calls `effects.update(world, elapsedMs)` each frame.
Because the lab has no `CombatVfx`, it drains `world.combatEvents` itself after
the update — in the real game `CombatVfx` owns that drain.
