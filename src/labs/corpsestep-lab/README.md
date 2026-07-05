# Corpse Step Lab

Interactive sandbox for `corpseStepSystem` (`src/core/systems/corpseStepSystem.ts`).

Run it with `npm run lab` → open `?lab=corpsestep-lab`.

## What it tests

`corpseStepSystem` gives the player a small (`CORPSE_STEP_TRIGGER_CHANCE`, 10%)
chance to **burst a corpse** each time they take a fresh step onto it (within
`CORPSE_STEP_RANGE_FT`). A burst is a **real gameplay state change**: it emits a
`corpseExplode` event and zeros the corpse's `DeathTimer`, so `deathTimerSystem`
reaps the body that same frame — one fewer corpse for future corpse-consuming
systems (e.g. necromancy).

This lab drives the **real** system on a real `GameWorld`, running the shipped
pipeline order each fixed step:

```
playerInputSystem → movementSystem → corpseStepSystem → deathTimerSystem
```

## How to use it

- **WASD / arrow keys** move the player (blue dot). The faint ring is the
  step radius.
- **Red circles** are ordinary corpses. Walk onto one and there's a 10% chance
  per fresh step it bursts (orange ring flash) and is removed. The `Bursts`
  counter climbs.
- **The green `NEST` square** is a `Spawner` corpse. It is tagged `Enemy` +
  `DeathTimer` like any corpse, so it matches the corpse query — but the system
  **excludes it**. Stomp it repeatedly: `Spawner steps` climbs while
  `Spawner bursts` stays `0` and the body never disappears.

## Why the Spawner exclusion matters

A spawner's death is a multi-tick scripted handshake (`spawnerSystem`'s finale
wave + `deathResolved`, then `spawnerArenaSystem`'s LOCKED→RESOLVED transition
that lowers the fence and grants banked XP). Bursting a spawner corpse early —
the player is standing on it the instant it dies from a melee kill — destroys
the entity before that handshake completes, permanently orphaning the arena and
trapping the player. This lab is the visual proof that the fix (skip `Spawner`
corpses) keeps the feature intact for real corpses while never touching nests.

See `tests/unit/corpse-step.test.ts` for the deterministic regression coverage
and `tests/headless/ai-arena-lockin-resolution.test.ts` for the real-pipeline
gate this fix restores to 100%.

## Controls

| Control         | Effect                                        |
| --------------- | --------------------------------------------- |
| Corpse count    | How many red corpses to scatter on respawn.   |
| Player speed    | Scales the player's movement speed.           |
| Paused          | Freeze the simulation.                        |
| Respawn Corpses | Rebuild the world (fresh scatter + one nest). |
| Clear Corpses   | Remove every corpse (including the nest).     |
