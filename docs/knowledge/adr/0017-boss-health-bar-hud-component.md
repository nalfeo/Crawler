# ADR-0017: Boss Health Bar as a Scaled HUD Component

## Status

Accepted

## Date

2026-06-25

## Estimated Complexity

🍎 x 3 — touches the engine HUD layer and reads game-layer boss-battle state, but
extends the existing `hud-lab` (no new lab) and adds a pure resolver with unit
tests.

## Context

The boss health bar overlapped the floor countdown timer. Both were pinned
top-center, but they were built in two different ways:

- The **floor timer** (`src/engine/HudFloorTimer.ts`) is a HUD component composed
  into the scaled `topCenter` group inside `HudUI` (`y≈14–52`). The group is
  scaled and re-anchored per UI scale (mobile up to ×1.6).
- The **boss health bar** was hand-built **inline** in
  `MainGameScene.ts` (`bossBarY = 16`, depth 1000) and updated by an
  `updateBossHealthBar()` method on the scene. It was never scaled.

Because the two used different layout systems, they collided, and a naive fixed
y-offset on the inline bar would re-collide once the HUD scaled up on mobile.
The selection logic (which boss to show, HP %, color band) was also entangled in
a Phaser scene method, so it could not be unit-tested without a live scene.

## Decision

Treat the boss health bar like every other HUD element: a thin Phaser render
shell composed into the scaled HUD group, driven by a pure, Phaser-free resolver.

### `resolveBossHealthBar` (pure, `src/engine/boss-health-bar-state.ts`)

A pure function `resolveBossHealthBar(bossBattles, ecs, health) → BossHealthBarState | null`:

- Iterates `world.floor1.objective.bossBattles` (a `Map`) in **insertion order**
  and returns the first encounter that is `started` and whose `bossEid` is a live
  entity. Insertion order is the priority order
  ('slime-rat' before 'staircase').
- Clamps `current ≥ 0`, `max ≥ 1`, `pct ∈ [0, 1]`.
- Picks a color band: `pct > 0.5` high (green), `≥ 0.25` mid (amber), else low
  (red).
- Falls back to `'Boss'` when `displayName` is empty.
- Returns `null` when no boss should be shown (bar hidden).

This lives in `src/engine/` because the engine layer may import bitecs + core/
shared **types**; it imports no Phaser.

### `HudBossBar` (`src/engine/HudBossBar.ts`)

A Phaser component mirroring `HudFloorTimer`:
`createHudBossBar(scene, { parent }) → { sync(world), destroy() }`. It owns the
shell/fill/label/name objects, parents them into the passed container, anchors at
`TOP_Y=60` (a clear gap below the timer's 14–52 band), and on `sync` calls the
resolver and shows/hides + repaints accordingly.

### Composition into `HudUI`

`HudBossBar` is added to the existing scaled `topCenter` group, so the timer and
boss bar scale and re-anchor as a single unit and never re-collide at any UI
scale. The inline boss bar (4 fields, creation block, and the
`updateBossHealthBar()` method, ~100 lines) is removed from `MainGameScene.ts`.

### Camera safety

`MainGameScene.refreshCameraMasks()` routes objects with `depth ≥
UI_DEPTH_CUTOFF (900)` to the scroll-locked UI camera. The HUD group and the old
boss bar both render at depth ≥999, so they already shared that camera — moving
the bar into the `topCenter` container does not change which camera draws it.

## Consequences

### Positive

- Timer and boss bar share one scaled layout system, so the overlap cannot recur
  at any UI scale.
- Selection/clamp/color logic is a pure function, unit-tested in isolation
  (`tests/unit/hud-boss-bar.test.ts`, 11 cases) with no scene required.
- `MainGameScene` sheds ~100 lines of HUD construction, matching the existing
  bridge pattern (logic/state out of the Phaser scene).
- `hud-lab` gains a "Boss fight active" toggle + HP slider, so the bar is
  exercisable in isolation.

### Negative

- One more HUD component to keep in sync with the `topCenter` group's
  scale/anchor conventions.

### Risks

- The resolver reads game-layer shape (`Floor1BossEncounterState`,
  `bossBattles`). If that shape changes, the resolver and its tests must follow.
  Low risk: it depends only on `{ started, bossEid, defeated, displayName }`.

## Alternatives Considered

1. **Fixed y-offset on the inline bar.** Smallest diff, but the inline bar is not
   scaled, so it would re-overlap the timer once the HUD scales up on mobile.
   Rejected.
2. **Keep selection logic in the scene method, only move the draw.** Would leave
   the boss-selection/clamp/color logic untestable without a live Phaser scene.
   Rejected in favour of the pure resolver.
3. **New top-level HUD anchor group for the boss bar.** More flexible placement,
   but duplicates the scale/anchor math already in `topCenter` and reintroduces
   the risk of the two top-center elements drifting apart. Rejected; reuse
   `topCenter`.
