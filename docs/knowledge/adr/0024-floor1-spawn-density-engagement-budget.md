# ADR 0024: Floor 1 spawn density via a director engagement budget

## Status

Accepted

## Date

2026-06-25

## Estimated Complexity

🍎 x 4 — reworks one gameplay system (the Floor 1 enemy director) plus its data
schema and tests; no new lab and no core-AI changes.

## Context

Floor 1 is meant to feel like a vampire-survivors-like: while exploring the
dungeon the player should be under near-constant attack. In practice, moving
quickly across the map left the player with **no enemies to fight**.

The root causes all lived in `floor1EnemyDirectorSystem`
(`src/game/floor1Scenario.ts`) — the system Floor 1 actually uses. (The generic
`enemySpawnerSystem` is lab-only and does not drive Floor 1 gameplay.)

- **Global cap of 14.** The whole floor could only ever hold 14 ambient enemies.
- **One spawn per 900 ms.** A single enemy trickled in per interval, so the field
  could never keep up with a player who kept moving.
- **Flat despawn at 1920 px.** Trailing mobs were pruned the instant the player
  outran them, draining the field from behind faster than it refilled ahead.
- **Rooms started empty.** Nothing pre-populated a room, so entering a fresh
  combat room was silent until the slow trickle caught up.

The player asked for: a higher total cap (≈100) with a **separate** limit on how
many enemies are actively pursuing/engaging; a despawn rework that frees room to
spawn closer to the player; and a high chance that entering a room for the first
time means walking into a wave that is already there.

## Decision

Adopt a **director-side "engagement budget"** model. All behaviour stays in the
Floor 1 director and is fully data-driven from `enemies.floor1.json`. There are
**no core-AI changes** — enemy behaviour, pathing, and aggro are untouched.

Two independent budgets replace the single cap:

1. **Global cap (`enemyCap = 100`)** — the hard ceiling on ambient enemy entities.
   This fills the dungeon so distant rooms stay populated and pre-population is
   affordable.
2. **Engagement target (`engageTarget = 6` within `engageRadiusPx = 720`)** — the
   desired number of enemies actively engaging the player. Each interval
   (`spawnIntervalMs = 500`) the director counts living enemies inside the engage
   ring and **burst-spawns** up to `maxSpawnsPerTick = 3` near the player to top
   the count back up to the target. This guarantees a steady swarm even when the
   player outruns the field — there are no dead zones.

Supporting mechanics:

- **Recycle-at-cap despawn.** When the field is already at the global cap and the
  player needs closer threats, the director evicts the **furthest** stragglers
  that are _outside_ the engage ring (furthest-first) to free budget for fresh
  near spawns. Enemies inside the ring — the fight the player is actually in — are
  never recycled, and bosses/quest enemies are never touched. The flat far-prune
  distance was also relaxed (`despawnDistancePx = 1920 → 2400`) so rooms behind
  the player stay populated longer.
- **Room pre-population.** The first time the player stands inside a NORMAL combat
  room, the director rolls `roomWaveChance = 0.65` to seed a wave of
  `roomWaveMin..roomWaveMax = 2..3` enemies already inside, kept at least
  `FLOOR_1_ROOM_WAVE_MIN_PLAYER_DISTANCE_PX = 96 px` from the player so the wave
  reads as "already there" rather than materialising on top of them. The room id
  is recorded on first visit regardless of the roll, so leaving and re-entering
  never re-rolls. SPAWN, SAFE, and BOSS_STAIR rooms are never seeded.

The tuning values above were **calibrated against two headless gates**. The Floor
1 completion gate (`tests/headless/floor1-completion.test.ts`) runs seeds 6/2/5 ×
sword/bow/baseball-bat and asserts an honest clear within the 5-minute budget; the
stuck/wiggle gate (`tests/headless/ai-stuck-wiggle.test.ts`) drives seed 6 ×
sword/baseball-bat and asserts the AI never falls into a sustained oscillation
loop (`wigglePct < 12`, longest wiggle episode `< 5 s`, travel efficiency `> 0.7`).
An initial aggressive pass (`engageTarget 22`, `maxSpawnsPerTick 5`, `roomWaveChance
0.7`, waves of 3–6, `spawnIntervalMs 400`) was too brutal: the bow runs were
swarmed at spawn and died around 24 s at level 0. Dialing the engagement target to
8 let every combo clear, but the denser melee crowd then tripped the wiggle gate
(seed 6 · sword wiggled 21.8 % of the run with a 5.25 s episode). The final values
(`engageTarget = 6`, `roomWaveChance = 0.65`, waves of 2–3) clear every completion
combo comfortably (bow seeds clear in ~140–165 s, level 5–6) **and** keep the
worst-case wiggle well inside the gate (seed 6 · sword ≈ 5.6 %, longest episode
≈ 0–1.5 s) while the floor still reads as a constant-pressure swarm.

Determinism is preserved: all randomness flows through `world.rng`, the
pre-population roll consumes no rng for non-NORMAL rooms (a role check precedes
the chance roll), and same-seed worlds spawn identically.

## Consequences

### Positive

- Constant combat: the engagement budget keeps a swarm on the player no matter how
  fast they move, delivering the intended vampire-survivors feel.
- Entering a new combat room usually means walking straight into a fight.
- The global cap and the engagement target are decoupled, so the dungeon can be
  densely populated without making the near-player pressure unbounded.
- Despawn now frees budget for _closer_ spawns instead of just deleting trailing
  mobs, eliminating the "moved too fast → empty map" failure.
- Fully data-driven and deterministic; no new core-AI surface area.

### Negative

- Floor 1 is meaningfully harder and busier. The tuning values are a starting
  point and will likely need balance passes.
- A higher entity ceiling raises the per-frame cost of enemy systems; 100 ambient
  enemies is the new worst case to budget against.

### Risks

- Balance/health regression gates may flag the higher density; values may need to
  come down if Floor 1 reads as too brutal.
- In cramped start-room geometry the engage ring can be only partially fillable;
  the director compensates by flooding toward the global cap, which is bounded but
  denser than a perfectly concentrated swarm.

## Alternatives Considered

- **Hard pursuer cap gated in core AI.** Track and clamp the number of enemies in
  the "pursue/engage" AI state. Rejected: it bleeds spawn-density policy into core
  AI, risks determinism and lab regressions, and is far riskier than a
  director-side budget. The engagement target achieves the same player-facing goal
  ("≈N enemies on me at once") without touching AI.
- **Just raise the cap / lower the interval.** Bumping `enemyCap` and shrinking
  `spawnIntervalMs` alone does not fix fast movement (still one-at-a-time, still
  flat-pruned) and does nothing for empty rooms. The burst + recycle + pre-pop
  trio is what removes the dead zones.
- **Continuous room population (spawn while occupied).** Re-seeding rooms on every
  visit was rejected as non-deterministic-feeling and prone to runaway counts; a
  one-time roll recorded per room keeps it predictable.
