# ADR 0093: Floor 4 Slice 3 — Deterministic Wave Manifests, Cap, Debt and the Cut

## Status

Accepted

## Date

2026-08-25

## Context

Floor 4 slice 2 shipped `arenaDirectorSystem` as the single phase authority over an
**empty** rehearsal arena. Slice 3 has to make those phases physical: real enemies,
released on a fixed cadence, from fixed gates, bounded by a live-enemy cap, with
overflow deferred as spawn debt and survivors removed by "the cut" at the end of
each wave window (spec FR3.1–FR3.7, FR7.1–FR7.2).

That crosses several layers at once — a new enemy pack, manifest schema, shared
state/RunStats types, a core component, and the game-layer director — so the
slice-level decisions are recorded here. ADR 0090 remains the Floor 4
architecture; this ADR records how slice 3 realizes R3/R7 within it.

## Decision

1. **Extend the existing director rather than adding a `*System`.**
   `arenaDirectorSystem` is already wired through
   `ScenarioDefinition.afterSpawnerSystems` into both the visual and headless sim
   steps. Wave release is phase-scoped behavior, so giving it to a second system
   would split the phase authority and add a new wiring surface (ADR 0039 /
   rule #14) for no benefit.

2. **Wave plans are immutable seeded manifests, built once per act.** On the
   transition into `WAVES(act)` the director rolls every wave of that act from a
   stream derived only from `(floorSeed, 'floor4', 'waves', act, waveIndex)`. The
   release path then consumes **zero** RNG — it only walks cursors — so the plan
   is identical no matter how the fight goes (FR7.1/FR7.2). Manifest generation
   lives in a pure module (`src/game/floor4/wave-manifest.ts`) with no world, ECS
   or clock, which is what makes it directly testable.

3. **All wave numbers are authored data** in the manifest's `floor4.waves`
   block: budget curve, per-act rosters with **integer** threat costs,
   concurrency cap, debt cap, telegraph lead, gate slot spacing (FR3.3). Integer
   threat is deliberate: the budget spend loop picks only from the affordable
   subset, so `remaining` strictly decreases and termination is structural rather
   than a float-epsilon argument. The schema cross-validates the pack id and
   every roster archetype against the enemy-pack registry at load, so a bad data
   edit fails at startup instead of mid-run.

4. **The tick is a bounded chronological boundary loop.** The slice-2 director
   applied at most one transition per tick and discarded the excess delta. With
   waves that would silently swallow every release inside a large frame delta, so
   the tick now repeatedly consumes `min(remaining, nextBoundary)` — the next
   telegraph, release, or phase boundary — and is unit-tested for equivalence
   between one 90 s call and the same span in fixed steps.

5. **Wave ownership is an ECS tag component (`ArenaWaveEnemy`), not an EID set.**
   bitecs recycles entity ids; a `Set<number>` would let a recycled entity
   inherit a dead wave's membership and be cut by a later act. bitecs strips
   components on `removeEntity`, so the tag cannot lie. Boss summons (slice 4)
   deliberately will not carry it: they share the cap but are exempt from
   manifests, debt and the cut (FR3.7).

6. **The cut emits VFX only, never a combat `death` event.** The headless runner
   counts enemy `death` events as kills, and a cut enemy is explicitly neither a
   kill nor a death and awards nothing (FR3.6). The director runs before damage
   and drop resolution in the frame, so the cut also **skips** entities already at
   zero health or carrying `DeathTimer` — otherwise it could race `dropSystem`
   and erase a kill the player legitimately earned on that frame.

7. **Gate spawn slots are enumerated once at floor init.** Slots fan out along
   the arena edge from each `FloorMap.feedGates` entry and are walkability-checked
   there; a venue with an unusable gate throws at init. Gate placement stays
   fixed and indexed with no player-relative or retry-based search at spawn time
   (FR3.4), and enumeration consumes no RNG.

8. **Live-enemy accounting is "live hostile arena combatants"**: `Enemy` +
   `Health.current > 0`, no `DeathTimer`, team ≠ `PLAYER`. Corpses mid-death
   animation must not hold a wave slot hostage, and companions must not consume
   the arena's threat budget.

## Consequences

- Floor 4 now spawns real combat, so slice 2's idle-player headless victory test
  is retired and replaced by a bounded act-1 wave/determinism test; the
  end-to-end clear returns with slice 7's win-rate gate. This deviation is
  documented in `.specify/specs/floor4-arena.md` and was **not** worked around by
  weakening a gate (rules #11/#12).
- Balance numbers (`baseBudget`, `intraActRamp`, `concurrencyCap`, `debtCap`) are
  provisional first-pass values. They live entirely in the manifest, so slice 7
  can retune them from sweep evidence without touching code — and must never be
  tuned to rescue specific seeds.
- `Floor4ArenaRunStats` gains wave telemetry plus per-act manifest fingerprints,
  which is what lets a determinism test compare two runs of a seed cheaply.
