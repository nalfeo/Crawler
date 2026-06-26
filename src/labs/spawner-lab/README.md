# Spawner Lab

Sandbox for the generic **Spawner** mob-type (`spawnerSystem` + `src/game/spawners/`).

A Spawner is an immobile, killable enemy structure that periodically spawns other
mobs. It has three behaviour modes:

1. **Passive** — a slow trickle of common mobs, capped at a small concurrent count.
2. **Defensive** — latched on the first point of damage the structure takes; it
   then spawns faster, sustains a bigger swarm, and pulls from a harder pool.
3. **On-death** — a one-shot finale wave when the structure is destroyed
   (a boss plus a few stragglers).

## What this lab shows

Two spawners are placed each run:

- **Rats Nest** (left) — rats and rat brutes passively; enrages to a faster,
  brute-heavier mix; bursts a **Rat King or Queen** plus rats on death.
- **Slime Pool** (right) — slimes passively; enrages to more/faster slimes;
  bursts a **Mama or Papa Slime** plus slimes on death.

## Controls

- **WASD / arrow keys** — move the player (5,000 HP so it survives the demo).
- **Poke Rats Nest / Poke Slime Pool** — apply a little damage to that structure
  to trip its defensive (enrage) latch without killing it.
- **Destroy Rats Nest / Destroy Slime Pool** — set the structure's HP to 0 to
  trigger its on-death finale wave.
- **Clear spawned mobs** — remove all spawned children but keep the structures.
- **Respawn nests** — clear everything and replace both structures.
- **Reset** — restart the scene from the fixed seed.

The info panel (bottom-left) reports each structure's HP, current mode
(`passive` / `DEFENSIVE`), live child count, and lifetime spawn total.

## Notes

- Everything is deterministic: all randomness flows through `world.rng`
  (seed `1990`), so a given sequence of inputs reproduces exactly.
- The structure is immobile by design — it has no `Velocity` and no
  `EnemyBehavior`, so `movementSystem` and `enemyAISystem` ignore it. It still
  has `Position` + `Sprite`, so it collides (you take contact damage walking
  into it) and can be attacked.
- Per-spawner concurrency is enforced by tagging children with
  `Owner{eid: spawner}` and counting living owned enemies.
