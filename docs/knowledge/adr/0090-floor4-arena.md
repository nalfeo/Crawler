# ADR 0090: Floor 4 — The Main Event (timed survival arena floor)

## Status

Proposed

## Date

2026-08-22

## Estimated Complexity

🍎 x 5 (the full Floor 4 epic) — this ADR records the cross-system architecture for the
first **non-exploration** floor: a bounded arena clock and phase machine, deterministic
wave scheduling layered over the existing spawner stack, seeded graded bosses, a
repeat-visit shop economy with per-visit stock rotation, and a transactional safe-room
hand-off. The **design session** that authored this ADR plus the content bible and spec is
scoped at 🍎 x 3 (docs-only). Every runtime slice is decomposed in
[`.specify/specs/floor4-arena.md`](../../../.specify/specs/floor4-arena.md).

## Context

Floors 1–3 are all exploration floors: generate a map, scatter objectives, descend when the
map is satisfied. Issue #3272 asks for something structurally different — a ten-minute
Brotato-style survival arena with a boss every two minutes and a shopping safe room after
each boss, whose stock re-randomizes on every visit.

Four properties of that brief each cross two or more systems and therefore need a durable
decision record rather than ad-hoc choices inside a new scenario file:

1. **"Ten minutes" needs a definition.** The existing floor timer (`timer.durationMs` +
   `world.elapsedMs`, read by `src/engine/floor-timer-state.ts` and treated as a loss
   condition by `src/game/floor2Scenario.ts`) is a _deadline_. Floor 4's ten minutes is
   _content_. Conflating them would either desynchronize every existing `elapsedMs`
   consumer or make the floor's advertised duration a lie.
2. **Progression is phase-driven, not map-driven.** Nothing in the codebase currently owns a
   floor-level phase machine; Floor 2 infers progression from world contents inside an
   objective tick, which is exactly the pattern that makes state hard to test.
3. **Shop stock must re-randomize per visit and stay deterministic.** The existing seeded
   shop path (`src/core/generateShopInventory.ts`, driven from
   `src/game/floor2Settlement.ts`) rolls **once** per floor. Repeat visits introduce a new
   question — what does a re-roll draw from? — whose obvious answer (the shared `world.rng`)
   is wrong for reasons that are not obvious.
4. **A safe room between combat phases is a state hand-off, not a door.** Floor 4's safe
   room is entered five times mid-combat-floor, each time with live enemies, projectiles,
   pending spawns, and an unopened boss chest in flight.

An adversarial plan review of the first draft of this design classified the timing model as
a `major_fork` and rejected a "wave-time-only, frozen-during-boss" clock; the decisions
below reflect that review.

## Decision

### D1 — A dedicated arena clock, additive to `world.elapsedMs`, running through all combat

Floor 4 maintains its own `arenaElapsedMs` in floor-scoped scenario state, advanced from the
same per-tick delta as `world.elapsedMs`. It **does not replace, shadow, or pause**
`world.elapsedMs`: every existing consumer (cooldowns, VFX, telemetry, floor-timer HUD)
keeps working unchanged.

The arena clock **runs continuously through both waves and boss fights**. A first draft froze
it during Headliner fights so that "ten minutes" meant ten minutes of wave combat; that was
rejected because it makes the floor's actual duration and difficulty unknowable — ten minutes
plus five arbitrarily long boss fights. Running one clock through all combat makes the
advertised ten minutes true, keeps act boundaries at fixed absolute marks (so the wave
schedule can never drift with player performance), and creates real DPS pressure on each
Headliner.

The clock is held only where there is no combat and no risk: the Green Room, and overtime
(D3).

An act therefore always ends on its mark rather than on the kill: defeating a Headliner
early converts the rest of the headline window into a **victory lap** (collect the chest and
leftover drops) instead of shortening the show. Ending the act on the kill would have made
the floor's duration player-dependent again — the exact failure D1 exists to prevent — and
would have needed a separate rule for the boss chest the player had not yet reached.

### D2 — One `arenaDirectorSystem` owns the phase machine

A single system owns the clock, the phase, wave release, the cut, Headliner entry, overtime,
and the intermission transaction. Every other system **reads** phase and never writes it, and
no system may infer phase from entity counts or clock values.

This is deliberately unlike Floor 2's `floor2ObjectiveTick`, which reconstructs progression
from world contents. A single write-authority is what makes the timeline unit-testable, makes
`RunStats` a faithful reconstruction of a run, and gives the headless runner one thing to
read.

Per rule #14 / ADR 0039 the system must be referenced from both real sim-side wiring sites
(`src/engine/sim/simulation-step.ts` and `src/game/ai/simulation-step.ts`); a lab reference
does not count, and lab-only validation does not discharge rule #9.

### D3 — Overtime: a bounded, self-terminating boss failure path

If an act's mark arrives with the Headliner alive, the arena clock **holds** at that mark —
letting a boss fight bleed into the next act would corrupt the fixed wave schedule — and the
fight enters **Overtime**: a deterministic escalation ramp with a hard 60-second cap ending
in a telegraphed guaranteed-lethal finisher.

Overtime exists so the floor's worst case is a _number_: 600,000 ms of combat plus at most
5 × 60,000 ms of overtime. A bounded episode is a precondition for headless win-rate gating;
an unbounded boss phase is not testable. It also avoids the alternative failure handling
(despawn the boss and continue), which would contradict the brief's "safe room after each
boss" gating.

### D4 — Wave composition is precomputed and immutable; overflow becomes bounded debt

Each wave's contents are computed into an **immutable spawn manifest** when its act begins,
not rolled at spawn time. Entries that cannot spawn under the live-enemy cap become **spawn
debt**, released in manifest order, capped at a fixed maximum, discarded at every phase
boundary, and consuming **no** RNG on release. Gates are fixed and indexed; placement never
runs a player-relative or retry-based search.

Every clause here exists to kill one specific hazard: rolling at spawn time would let cap
pressure change RNG consumption and shift every downstream draw; uncapped debt would let a
stalling player accumulate a lethal post-boss burst; retry-based placement would reintroduce
path dependence through the back door.

### D5 — Isolated derived RNG streams per purpose

All Floor 4 randomness is drawn from streams derived as a pure function of the floor seed
plus a purpose label and index — wave manifests, Headliner selection, shop stock (per visit,
per table) — never from the shared combat `world.rng`.

The consequence that matters to players: **shop stock is path-independent.** Green Room visit
_n_ for a given seed is identical no matter how the preceding acts went, so shopping is a
build decision rather than an RNG-manipulation minigame. The consequence that matters to us:
the economy is reproducible in sweeps and assertable in tests. The exact derivation recipe —
key format, delimiter, labels, and hash — is a data contract owned by the spec (FR7.1/FR7.2);
the architectural commitment — isolated per-purpose streams — is owned here.

### D6 — The Headliner card is a graded, append-only, without-replacement draw keyed by act slot

Acts 1–4 draw without replacement from a graded candidate pool using a derived stream; act 5
is a fixed finale. Each act slot declares eligible grades, so no seed can front-load the
hardest fight. The pool is **append-only and stably ordered** — reordering it changes every
existing seed's card, which is a breaking change.

Encounter identity is the **act slot** (`floor4-headliner-act-<n>`), not the archetype id, so
chest attribution, defeat latches, achievements, and telemetry remain stable regardless of
which archetype the seed drew.

### D7 — The intermission is an ordered transaction

Entering the Green Room is an ordered, mandatory sequence: defeat latch → chest and
appearance fee resolved and collected → arena entities, projectiles, and spawn debt cleared →
arena sealed → player relocated → visit stock rolled. Exit reverses it: retire stock → arm
the next act → unseal → relocate → resume the clock.

The safe room is a **physical sealed room**, not a menu overlay, because the brief asks the
player to enter one — but a physical room is only safe if the hand-off is transactional.
`src/core/safe-space.ts` sets a flag; it does not pause the world, remove enemies, or stop
projectiles. The named failure modes are concrete: projectiles crossing into the room, a boss
chest stranded in a sealed arena, a wave manifest armed before the player is back on the
floor.

### D8 — Reuse, don't fork: manifest, spawners, shops, chests

Floor 4 extends the existing stack rather than forking it: a `floor4` block in the strict
floor-manifest schema (mirroring `floor2`), registration in the floor registry and
`scenarioDefinitions.ts`, spawn instantiation through existing spawner/archetype tech,
`generateShopInventory` for stock, and the existing boss-chest reward path. What is genuinely
new is only the _scheduling and phase_ layer.

Two manifest fields are given Floor-4-specific meaning, explicitly: `objectives.*` are all
zero (the floor has no kill/gold gate; the stairs are gated by `onStairDescend` on phase),
and `timer.durationMs` is a **hard backstop** far above the bounded worst case, whose only
purpose is to catch a non-terminating bug.

## Consequences

### Positive

- The floor's advertised duration is literally true, and its worst case is bounded — which
  is what makes it gateable by a headless win-rate sweep at all.
- A single phase authority makes the run timeline reconstructible from `RunStats` and
  unit-testable without a world full of entities.
- Path-independent shop stock removes an entire class of player-side RNG manipulation and
  makes economy balance reproducible across sweeps.
- The wave scheduler is a thin, deterministic layer over already-validated spawner and
  engagement-budget tech, so the arena inherits Floors 1–2's AI contracts.
- A new floor archetype (timed survival) becomes available to future floors, and the
  authored-arena map path is reusable for any future venue floor.

### Negative

- A second clock in the codebase invites "which clock?" confusion. Mitigated by making
  `arenaElapsedMs` strictly additive, floor-scoped, and read by exactly one system.
- The `floor4` manifest block is large. The strict Zod schema means every field is validated,
  but it is still a lot of authored configuration.
- The intermission transaction is intricate and is a genuine correctness risk; it needs
  integration coverage from the slice that introduces it, not later.
- Overtime is extra design and tuning surface that only fires on a failure path.

### Risks

- **Headless traversal is the schedule risk.** The AI runner must fight, shop, equip, and
  traverse five transitions. The spec pulls a minimal headless route into slice 2 precisely
  so later slices are validated rather than assumed.
- **Economy tuning across five shops is a wide surface.** Five guaranteed buying
  opportunities could flatten difficulty. Per-act income budgets and per-break price bands
  are the declared brakes; the win-rate gate is the check.
- **Arena geometry could trap the player.** A dead end in a wave floor is fatal; the kiting
  invariant must be an asserted map-gen test, not a visual impression.
- **Boss ability portability.** Abilities authored for corridors or cover will not read in an
  open arena; every Headliner ability must be arena-legal and telegraphed.

## Alternatives Considered

1. **Wave-time-only clock, frozen during boss fights (the original draft).** Made "ten
   minutes" mean ten minutes of _wave_ combat, with untimed boss fights as the reward for
   surviving an act. **Rejected:** the floor's real duration and difficulty become unknowable
   (ten minutes plus five unbounded fights), and an unbounded boss phase cannot be gated by a
   headless win-rate sweep. Adopted instead: one continuous combat clock (D1) with bounded
   overtime (D3).
2. **Bosses as concurrent wave modifiers rather than a separate phase.** Spawn the Headliner
   into the ongoing arena at each two-minute mark and keep waves flowing. **Rejected for
   MVP:** it removes the authored "act closer" beat the brief describes, makes each boss's
   difficulty depend on the live trash count at the moment it spawns (undermining
   reproducible balance), and requires every Headliner ability to be designed to coexist with
   a full wave. Worth revisiting as a difficulty modifier once the base floor is balanced.
3. **The safe room as a menu overlay instead of a physical room.** Freeze the sim, present a
   shop/equip UI, restore. **Rejected:** the brief explicitly says _enter_ a safe room, and
   the physical room is the floor's pacing beat. The overlay's real advantage — no leakage,
   no traversal — is recovered by making the hand-off transactional (D7).
4. **Draw shop stock from the shared `world.rng`.** Simplest to implement and still
   deterministic per seed. **Rejected:** stock would depend on how many RNG calls combat
   consumed, so it would be path-dependent — farmable by the player and effectively
   unassertable in tests. Isolated derived streams (D5) cost one helper and remove the whole
   class of problem.
5. **Reuse `timer.durationMs` as the arena clock.** No second clock. **Rejected:** that field
   is a deadline consumed by the floor-timer HUD and by Floor 2's loss condition; overloading
   it would desynchronize existing consumers and leave no backstop for a non-terminating run.
6. **A procedurally generated arena.** More variety per run. **Rejected for MVP:** the floor's
   variety comes from the seeded Headliner card and rotating shops, and an authored arena is
   the only cheap way to guarantee the kiting invariant (FR9.3).
