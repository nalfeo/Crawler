# Spec: Floor 4 — The Main Event (Arena)

> **Status:** **In implementation.** Slice 1 (floor plumbing + authored arena venue) is
> implemented in code; slices 2–8 in §Epic decomposition remain planned.
> **Authored:** 2026-08-22.
> **Estimated complexity:** 🍎🍎🍎🍎🍎 (Massive epic — a new floor archetype spanning the
> floor-manifest/registry/scenario stack, a new phase-driven arena director, deterministic
> wave scheduling, seeded bosses, a repeat-visit shop economy, HUD surfaces, and headless-AI
> support; sliced below). _This design session is 🍎🍎🍎 (docs only)._
> **Authored content:**
> [`docs/knowledge/game-design/floor4-arena.md`](../../docs/knowledge/game-design/floor4-arena.md)
> (fantasy, act structure, Headliner roster, Green Room, economy, UX inventory).
> **Architecture:** [ADR 0090](../../docs/knowledge/adr/0090-floor4-arena.md).
> **Canonical home:** this spec is the living Floor 4 contract; ADR 0090 is the architecture
> rationale.
> **Reused ADRs:** 0005 (parameterized floor config), 0010 (door-lock conditions), 0011
> (data-driven quests), 0023 (generic special-room sealing), 0024 (engagement budget), 0025
> (generic spawner mob-type), 0039 (every `*System` must be wired to a real pipeline), 0044
> / 0045 / 0050 (spawner-arena precedent + the dynamic barrier primitive), 0064
> (data-driven boss-ability catalog), 0070 (boss-chest lifecycle & reward policy), 0086
> (scenario-definition pipeline slots).
> **Code source-of-truth (planned, slice → files):** see §Epic decomposition.
> **Labs (planned):** `src/labs/floor4-arena-lab/`.
> **Test suites (planned):** `tests/unit/floor4-arena-*.test.ts`,
> `tests/integration/floor4-arena.integration.test.ts`,
> `tests/headless/floor4-arena-completion.test.ts`.
> **Known gaps (by design):** acts/waves/Headliners/Green Room transaction/HUD are not yet
> implemented; final tuning numbers are deliberately unfixed and are set by the balance slice
> against the win-rate gate (project rule #12); the paid shop re-roll and audience-vote
> mutators are explicitly out of scope.

## Context

Floors 1–3 are all **exploration** floors: a generated map, objectives scattered across it,
and a descent when the map is satisfied. The game-design document's stated genre DNA is
Brotato-derived, but no floor has yet delivered the arena-survival loop that DNA implies.

Floor 4 is that floor. The brief (issue #3272) fixes four hard requirements:

1. A **ten-minute** arena survival run.
2. **Waves** of enemies, not a populated map.
3. A **boss every two minutes** — five bosses.
4. A **safe room after each boss** where the player can purchase and equip, with **shop
   inventory randomized between each visit**.

Each of those crosses several existing systems (floor manifest/registry/scenario, map
generation, spawning and the engagement budget, safe rooms, shops and the generated-equipment
economy, boss chests, HUD, and the headless AI runner), which is why the architecture is
recorded in an ADR and the contract here.

Two constraints shape everything:

- **Determinism.** The wave schedule, wave composition, Headliner card, and every Green
  Room's stock are **seeded** from the floor seed and must reproduce byte-identically for a
  given seed, headless or windowed. Never `Math.random()`, never `Date.now()` (project
  rules #3/#4).
- **Win-rate, not seeds.** Balance targets a floor-level win-rate gate across a seed sweep;
  numbers are never tuned to rescue individual seeds (project rule #12).

## Requirements

### R1 — The arena clock

- **FR1.1** The floor maintains an **arena clock** (`arenaElapsedMs`), advanced from the
  same per-tick delta that drives `world.elapsedMs`. It is a floor-scoped value in the
  Floor 4 scenario state; it does **not** replace, shadow, or reinterpret `world.elapsedMs`,
  which continues to advance normally for every existing consumer (cooldowns, VFX,
  telemetry, `resolveFloorTimerRemainingMs`).
- **FR1.2** The arena clock advances during **all combat phases** (`WAVES`, `HEADLINE`) and
  is **held** during `OVERTIME`, `INTERMISSION`, and any modal/paused state. It advances
  during `HEADLINE` whether or not the Headliner is still alive (FR1.4).
- **FR1.3** The arena's total combat budget is **600,000 ms**, divided into **five acts of
  120,000 ms**. Act boundaries are absolute marks at 120k / 240k / 360k / 480k / 600k and
  never drift.
- **FR1.4** Each act is split into a **wave window** (first 90,000 ms) and a **headline
  window** (last 30,000 ms). The headline window always runs to the act mark. Defeating the
  Headliner before the mark does **not** end the act early; the remainder of the window is
  the **victory lap**, during which the player collects the boss chest and the act's
  leftover drops. This is what makes FR1.3's marks absolute and keeps the floor's duration
  a known constant.
- **FR1.5** The clock is derived from accumulated fixed-timestep deltas only (the same
  `GAME.DELTA_MS` accumulator that advances `world.elapsedMs`). No wall-clock source may be
  read.

### R2 — Phase state machine

- **FR2.1** The floor is always in exactly one phase:
  `COUNTDOWN → WAVES(act) → HEADLINE(act) → [OVERTIME(act)] → INTERMISSION(act) → …
→ VICTORY`, with `DEFEAT` reachable from any combat phase on player death. `HEADLINE(n)`
  carries a **cleared latch** distinguishing "Headliner alive" from "Headliner defeated,
  victory lap running"; it is a latch rather than a separate phase so that no consumer has
  to special-case two combat phases with identical rules.
- **FR2.2** Transitions and their triggers are exhaustive and total:

  | From                       | Trigger                                       | To                |
  | -------------------------- | --------------------------------------------- | ----------------- |
  | `COUNTDOWN`                | countdown elapsed                             | `WAVES(1)`        |
  | `WAVES(n)`                 | arena clock reaches act `n`'s wave-window end | `HEADLINE(n)`     |
  | `HEADLINE(n)`, latch clear | Headliner `n` defeated                        | `HEADLINE(n)`\*   |
  | `HEADLINE(n)`, latch set   | arena clock reaches act `n`'s mark            | `INTERMISSION(n)` |
  | `HEADLINE(n)`, latch clear | arena clock reaches act `n`'s mark            | `OVERTIME(n)`     |
  | `OVERTIME(n)`              | Headliner `n` defeated                        | `INTERMISSION(n)` |
  | `OVERTIME(n)`              | overtime cap reached (finisher resolves)      | `DEFEAT`          |
  | `INTERMISSION(n)`          | player takes the Green Room exit, `n < 5`     | `WAVES(n + 1)`    |
  | `INTERMISSION(5)`          | player takes the stairs                       | `VICTORY`         |
  | any combat phase           | player death                                  | `DEFEAT`          |

  \* Sets the cleared latch and begins the victory lap; the phase itself is unchanged.
  Defeat during `OVERTIME(n)` skips the victory lap — the act mark has already passed — and
  intermission begins immediately.

- **FR2.3** Phase is single-authority: exactly one system advances it, and every other
  system reads it. No system may infer the phase from entity counts or clock values.
- **FR2.4** Every phase transition emits a telemetry record (phase, act, arena clock,
  reason) so a run's shape is reconstructible from `RunStats` alone.

### R3 — Waves

- **FR3.1** Each act schedules **8 waves**, at act-relative offsets `0, 12_000, … 84_000` ms.
- **FR3.2** Each wave's contents are **precomputed into an immutable spawn manifest** when
  its act begins — an ordered list of `(archetypeId, gateIndex)` entries — drawn from a
  **derived, isolated `SeededRandom` stream** (R7). Composition is never rolled at spawn
  time and never depends on live world state.
- **FR3.3** Wave budget follows
  `waveBudget(act, waveIndex) = baseBudget × actMultiplier[act] × (1 + intraActRamp × waveIndex)`,
  with the multipliers and per-archetype threat costs authored in the Floor 4 manifest/data,
  not hardcoded.
- **FR3.4** Spawn gates are **fixed and indexed**. A manifest entry names its gate index;
  placement never runs a player-relative or retry-based search, because a retry loop would
  make RNG consumption path-dependent.
- **FR3.5** A live-enemy **concurrency cap** bounds the arena. Entries that cannot spawn
  become **spawn debt**, released in manifest order as capacity frees. Debt is capped at a
  fixed maximum (excess is discarded), is cleared on every phase transition, and consumes no
  RNG on release.
- **FR3.6** At the end of a wave window every surviving wave enemy is **cut**: removed with
  standard death VFX, awarding **no** XP, gold, or drops, and counting as neither a kill nor
  a death in telemetry.
- **FR3.7** Boss-summoned enemies (notably the Showrunner's scripted mid-fight wave, FR4.8)
  are **not** scheduled waves: they are owned by the encounter, are excluded from wave
  manifests and from spawn debt, count against the same live-enemy cap, and are removed with
  the encounter rather than by the cut.

### R4 — Headliners

- **FR4.1** Acts 1–4 draw a Headliner **without replacement** from a graded candidate pool
  (≥8 entries) using a derived seeded stream; act 5 is the fixed finale `floor4-showrunner`.
- **FR4.2** Each act slot declares its eligible grades; the draw may only pick an eligible
  candidate, so a seed cannot front-load the hardest fight.
- **FR4.3** The candidate pool is **append-only and stably ordered**. Reordering or
  renumbering entries changes every existing seed's card and is a breaking change.
- **FR4.4** The encounter identity is the **act slot** (`floor4-headliner-act-<n>`), not the
  archetype id. Defeat latches, chest attribution, achievements, and telemetry key off the
  slot.
- **FR4.5** On defeat, a Headliner drops a boss chest (existing boss-chest path, ADR 0070)
  plus a fixed act-scaled gold **appearance fee**. The chest is collected during the victory
  lap (FR1.4). Any chest still unopened when the act mark arrives is **force-resolved into
  the player's possession** as part of the intermission transaction (FR5.2); a chest that is
  neither collected nor force-resolved is a hard error, never a silent skip.
- **FR4.6** `OVERTIME` applies a deterministic escalation ramp (damage/speed steps on a
  fixed schedule) and is hard-capped at **60,000 ms**, at which point a telegraphed
  guaranteed-lethal finisher resolves. Overtime is announced on the HUD before it begins.
- **FR4.7** Every Headliner ability must be expressible in arena geometry (no corridor-,
  door-, or cover-dependent abilities) and must carry an observable telegraph.
- **FR4.8** The finale's scripted summon is a bounded boss ability: a fixed, manifest-authored
  roster and count drawn from the Headliner-selection stream, subject to FR3.7.

### R5 — The Green Room (intermission)

- **FR5.1** The Green Room is a physically separate sealed room, not a menu overlay — the
  brief asks the player to _enter_ a safe room. It must be tagged `RoomRole.SAFE` in the
  room graph so that `safeRoomSystem` (`src/core/safe-space.ts`) recognises it; the
  `spawnRoomIsSafe` flag is **not** used, because it protects only `floorMap.spawnRoom`,
  which on Floor 4 is the arena itself. The `safeRoomWeaponImmunity` and
  `safeRoomDoorsAutoClose` behavior flags are enabled (FR8.7).
- **FR5.2** Entry is an ordered **transaction**, and every step is mandatory:
  1. Headliner death detected and its defeat latch set (FR2.1); the victory lap runs to the
     act mark.
  2. Any unopened boss chest force-resolved and the appearance fee collected (FR4.5).
  3. All remaining arena enemies, projectiles, ground effects, and spawn debt cleared.
  4. Arena sealed (dynamic barrier / door lock, ADR 0023 / 0050).
  5. Player relocated into the Green Room; arena clock held.
  6. Visit stock rolled (R6) for `visitIndex = n`.
- **FR5.3** Exit is the reverse transaction: retire the visit's stock, arm act `n + 1`'s
  wave manifests, unseal the arena, relocate the player, resume the arena clock. In
  `INTERMISSION(5)` the exit is the **stairs** and the floor completes instead.
- **FR5.4** The Green Room supports purchase, sale, and **full equip/unequip of anything the
  player owns**, not only newly-purchased items.
- **FR5.5** The Green Room applies **no** free healing or resource reset. Recovery is a
  purchase.
- **FR5.6** No combat, no enemies, no countdown, and no player damage may occur in the Green
  Room. This is an invariant, not a behavior — an integration test asserts an empty hostile
  set for the whole visit. "No countdown" is a **HUD** guarantee: the arena clock is held
  (FR1.2) and the generic floor-timer readout is suppressed on Floor 4 (FR8.4), so the
  player sees no advancing number while shopping. `world.elapsedMs` itself keeps advancing,
  as it must for every existing consumer.

### R6 — Shop stock and re-randomization

- **FR6.1** Each visit rolls the stock of every table via the existing pure
  `generateShopInventory(rng, archetype, options)` (`src/core/generateShopInventory.ts`).
  Floor 4 introduces no second inventory generator.
- **FR6.2** Each `(visitIndex, tableId)` pair uses its **own derived `SeededRandom`**
  (R7), making stock **path-independent**: visit `n` for a given floor seed is identical
  regardless of what happened during the acts.
- **FR6.3** Tables are **fixed identities** across all five visits (same set, same room
  positions); only branding and stock rotate.
- **FR6.4** Stock is **immutable within a visit** — no mid-visit restock.
- **FR6.5** Purchased entries are removed for that visit; unsold entries are **retired** on
  exit and do not carry into the next visit.
- **FR6.6** Generated-equipment offers follow the existing Floor 2 Quartermaster lifecycle
  (`src/game/quartermaster-stock.ts`): instances are generated when the visit's stock is
  rolled and every unpurchased instance is **retired** on exit, tracked by instance id, so
  retiring a visit leaves no orphaned instance in the registry. Floor 4 reuses that
  epoch-and-retire pattern rather than introducing deferred instantiation.
- **FR6.7** Price bands and tier pools scale with `visitIndex` from manifest-authored data.
- **FR6.8** **Affordability invariant.** Every visit's rolled stock must contain at least one
  entry priced at or below the declared worst-case gold-on-hand for that visit, computed
  from the guaranteed appearance fees alone (no wave income, all prior gold spent). This is
  asserted per seed in the headless sweep, so no roll can produce a window-shopping break.

### R7 — Determinism contract

- **FR7.1** All Floor 4 randomness is drawn from **derived, isolated streams**, never from
  the shared combat `world.rng`. A stream is constructed as
  `new SeededRandom(hashStringToSeed(streamKey))` where
  `streamKey = [floorSeed, 'floor4', purposeLabel, ...indices].join(':')`, indices are
  base-10 integers, and `hashStringToSeed` (`src/shared/random.ts`) is the repo's existing
  deterministic string-to-seed hash (the same one used for named sub-seeds elsewhere). The
  delimiter is `:` and labels may not contain it, so distinct purposes can never collide.
  The _architectural_ commitment (isolated per-purpose streams) is owned by ADR 0090; this
  recipe is the data contract.
- **FR7.2** Canonical purpose labels and their indices:

  | Purpose             | Label      | Indices                   |
  | ------------------- | ---------- | ------------------------- |
  | Wave manifests      | `waves`    | act, waveIndex            |
  | Headliner selection | `headline` | — (one draw for the card) |
  | Shop stock          | `stock`    | visitIndex, tableId       |
  | Green Room dressing | `dressing` | visitIndex                |

- **FR7.3** Re-running a seed must reproduce: identical phase timeline, identical wave
  manifests, an identical Headliner card, and identical stock for all five visits — asserted
  by unit tests, not by inspection.
- **FR7.4** Spawn debt, cap pressure, player behavior, and frame timing must not perturb any
  draw (this is what FR3.2, FR3.5, and FR6.2 exist to guarantee).

### R8 — Floor integration

- **FR8.1** A `floor4.manifest.json` is authored under `src/shared/data/floors/`, imported by
  `src/shared/floor-manifest.ts`, exported as `floor4Manifest`, and registered in
  `FLOOR_REGISTRY` (`src/shared/floor-registry.ts`).
- **FR8.2** The manifest schema gains a **`floor4` block** (strict, optional, mirroring the
  existing `floor2` block) carrying: act count and durations, wave cadence and budget
  curves, per-act rosters and threat costs, the concurrency cap and debt cap, the Headliner
  pool with grades and per-slot eligibility, overtime ramp and cap, per-visit shop tables,
  price bands, and the arena/Green Room geometry parameters.
- **FR8.3** Floor 4 sets `objectives.*` to zero — it has no kill/gold/junk gate — and gates
  the stairs through the scenario's `onStairDescend`, which returns false unless the phase
  is `INTERMISSION(5)`.
- **FR8.4** `timer.durationMs` is a **hard stall backstop on `world.elapsedMs`**, not a
  broadcast countdown. Because `resolveFloorTimerRemainingMs`
  (`src/engine/floor-timer-state.ts`) derives from `world.elapsedMs`, which advances during
  Green Room visits, the backstop must be sized to cover the bounded worst case
  (600,000 ms of combat + 5 × 60,000 ms of overtime) **plus** a generous allowance for five
  untimed shopping visits. Floor 4 **suppresses the generic floor-timer HUD readout**
  (FR5.6) so this value is never surfaced as a countdown; the act clock is the only clock
  the player sees. Reaching the backstop means a non-terminating bug or an abandoned run,
  and the floor must record that explicitly rather than treating it as an ordinary timeout.
  This raw elapsed-time safeguard is distinct from FR8.5's active-time win budget.
- **FR8.5** `implemented.mvp` stays `false` until the floor is finishable end-to-end and the
  headless gate passes; `implemented.winBudgetMs` is set to **900,000 ms** as an
  **active-time** budget (`gameTimeMs - safeRoomMs`, per `src/game/ai/floor-run-budget.ts`),
  covering 600,000 ms combat (FR1.3) + 5 × 60,000 ms overtime (FR4.6). `COUNTDOWN` must run
  while safe-room-tracked so it does not consume this budget; this field is not the raw
  elapsed-time stall backstop from FR8.4.
- **FR8.6** A `ScenarioDefinition` for `floor4` is registered in
  `src/game/scenarioDefinitions.ts` with its Director intro/victory/timeout lines, its
  pipeline slots, and its `onStairDescend`.
- **FR8.7** `behavior` flags: `bossChests: true`, `equipmentEconomy: true`,
  `safeRoomWeaponImmunity: true`, `safeRoomDoorsAutoClose: true`, `lineOfSightAggro: true`
  (open arena geometry). Every other flag stays off explicitly.

### R9 — Map

- **FR9.1** The arena is an **authored, bounded** single room plus an adjoining sealed Green
  Room and a connecting tunnel. There is no exploration and no procedural room graph.
- **FR9.2** Four fixed, indexed feed gates sit at the arena's cardinal edges.
- **FR9.3** **Kiting invariant:** the arena must contain no geometry that can trap the
  player in a dead end. Asserted by a map-gen test, not by eyeballing.
- **FR9.4** The Green Room and the arena are never simultaneously reachable — the connecting
  tunnel is sealed on both sides outside the transition.

### R10 — Headless AI & telemetry

- **FR10.1** The headless runner must complete a Floor 4 run without human input: fight
  waves, fight Headliners, traverse the intermission transaction, make purchase/equip
  decisions in the Green Room, and take the exit.
- **FR10.2** A minimal, walk-through-able Floor 4 route lands in **slice 2**, not at the end
  — the headless path is a prerequisite for validating the later slices, not a capstone.
- **FR10.3** `RunStats` gains Floor 4 fields: per-phase timeline, arena clock at completion,
  per-Headliner fight duration, overtime occurrences, cut counts, discarded spawn debt,
  per-visit purchases and gold spend, and the act in which a defeat occurred.
- **FR10.4** The floor declares a win-rate target and a seed-sweep gate. The target is set
  by the balance slice from swept evidence; it is never met by tuning to specific seeds
  (project rule #12).

### R11 — Carried-in state (Floor 3 co-star)

- **FR11.1** If the incoming carryover snapshot contains a kept Companion (Floor 3's
  producer contract), it enters the arena as an ally for the whole floor.
- **FR11.2** The co-star is **strictly additive**. Balance must hold with no co-star present,
  which is the case for every run that reaches Floor 4 without a completed Floor 3.
- **FR11.3** The co-star never gates progression: it cannot be required to defeat a
  Headliner, and its death does not fail the run.

## Design

### D1 — `arenaDirectorSystem` is the single phase authority

One new system owns the arena clock, the phase machine, wave release, the cut, Headliner
entry, overtime escalation, and the intermission transaction. Every other system reads phase
state and never writes it. This is the direct lesson of the phase-scattered logic in
`src/game/floor2Scenario.ts`: an objective tick that infers state from world contents is hard
to test and easy to desynchronize.

Per project rule #14 and ADR 0039, `arenaDirectorSystem` must be wired through the canonical
scenario/bootstrap path: `ScenarioDefinition` pipeline slots (`src/game/scenarioDefinitions.ts`)
consumed by `createFloorMainSceneOptions` (`src/bootstrap/floor-main-scene-options.ts`) and
threaded into both sim wrappers via `preSystems` / `postSystems` on
`src/engine/sim/simulation-step.ts` and `src/game/ai/simulation-step.ts`. Lab-only validation
does not satisfy rule #9 for this system.

### D2 — Floor 4 state lives in floor-scoped scenario state

`arenaElapsedMs`, phase, act index, wave cursor, spawn debt, Headliner card, defeat latches,
and `visitIndex` live in a Floor 4 scenario state object reached through the existing
floor-scenario/extended-state seam, exactly as Floor 2's family state does. No new global
world fields, and no reinterpretation of `world.elapsedMs`.

### D3 — Waves reuse spawner tech; the director owns scheduling

Enemy instantiation reuses existing spawn helpers and archetype defs. What is new is the
_schedule_: precomputed immutable manifests plus a deterministic release cursor. Splitting it
this way means the arena inherits the engagement-budget and AI contracts already validated on
Floors 1–2 instead of forking a second spawn stack.

### D4 — Isolated derived RNG streams

Every Floor 4 draw uses a stream derived from the floor seed and a purpose label rather than
the shared `world.rng`. This is the decision that makes shop stock path-independent, wave
manifests immune to cap pressure, and the Headliner card stable — and it is why FR3.4 forbids
retry-based spawn placement, which would reintroduce path dependence through the back door.

### D5 — The intermission is a transaction, not a doorway

FR5.2/FR5.3 specify an ordered, all-or-nothing hand-off. The failure modes this exists to
prevent are concrete: projectiles crossing into a safe room, a boss chest stranded in a
sealed arena, a wave manifest armed before the player is back on the floor, and a headless
runner that walks through a door mid-transition.

### D6 — Green Room shops reuse `generateShopInventory`

Floor 4 adds no inventory generator. It adds a **visit epoch** (`visitIndex`) and a stock
lifecycle (roll on entry, immutable during, retire on exit). The generated-equipment path
keeps its existing ownership semantics; a Floor 4 offer is an _offer_ until purchased.

### D7 — Deliberately deferred

The paid shop re-roll, audience-vote mutators, sponsor modifiers, destructible arena
fixtures, and multi-arena variants are **out of scope**. Each multiplies economy, RNG, UI,
and headless-decision surface at once; none is needed for the brief.

## Epic decomposition

Slices are ordered so that each one is independently observable in a **real** artifact
(game or headless runner), never only in the lab.

| #   | Slice                                      | Introduces / extends                                                                                                                                                                                                                                         | Done when                                                                                                                                         |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Floor plumbing + arena map**             | `src/shared/data/floors/floor4.manifest.json`, `floor4` block in `src/shared/floor-manifest.ts`, registration in `src/shared/floor-registry.ts`, `src/game/floor4Scenario.ts` skeleton, `scenarioDefinitions.ts` entry, authored arena + Green Room geometry | The player can load Floor 4 in `npm run dev`, stand in an empty arena, and walk into the Green Room.                                              |
| 2   | **Phase machine + clock + headless route** | `arenaDirectorSystem` (clock, phases, transitions), wiring via scenario pipeline slots into both sim steps, `RunStats` phase timeline, minimal headless traversal                                                                                            | A headless run walks the full `COUNTDOWN → … → VICTORY` timeline on an empty arena, and the timeline is byte-identical across two runs of a seed. |
| 3   | **Waves**                                  | `enemies.floor4.json`, per-act rosters/threat costs, precomputed wave manifests, release cursor, concurrency cap + debt, the cut, gate telegraphs                                                                                                            | Waves spawn on schedule in the real game; two runs of a seed produce identical manifests; the cap holds.                                          |
| 4   | **Headliners**                             | Headliner pool data + graded seeded draw, act-slot encounters, entry/announcement, boss chest + appearance fee, overtime ramp and cap, `boss-abilities.floor4.json`                                                                                          | Five Headliners appear on the seeded card, drop their chests, and overtime terminates a stalled fight.                                            |
| 5   | **Green Room**                             | Intermission transaction, sealed room, shop tables, per-visit stock roll + retire, purchase/sell/equip surfaces, exit/stairs                                                                                                                                 | Five visits occur, stock differs between visits and matches across two runs of a seed, and nothing hostile ever exists in the room.               |
| 6   | **HUD & feedback**                         | Act clock + overtime state, wave pips, Headliner banner, cut notice, break summary, Winner's Circle                                                                                                                                                          | Deterministic visual checks (`tests/e2e/helpers/pixels.ts` / `ui-probe.ts`) cover each surface.                                                   |
| 7   | **Economy & balance**                      | Per-act income budgets, price bands, tuning pass, `tests/headless/floor4-arena-completion.test.ts` win-rate gate, achievements/quests data                                                                                                                   | The floor holds its declared win-rate gate over a seed sweep, with sweep evidence linked.                                                         |
| 8   | **Floor 3 co-star (optional)**             | Kept-Companion carryover consumption                                                                                                                                                                                                                         | A run carrying a kept Companion fights with it; a run without one is unchanged.                                                                   |

### Slice-1 deviation: the curtain tunnel ships open

Slice 1's done-when ("walk into the Green Room") and **FR9.4** ("the arena and the
Green Room are never simultaneously reachable") cannot both hold before the
intermission transaction exists. Slice 1 therefore ships the tunnel **permanently
open**, with no doors and no sealing logic, so the venue is observable in the real
game. FR9.4 is satisfied by the **slice-5** intermission transaction, which owns
the seal; until that lands, Floor 4 is explicitly non-conformant to FR9.4 and is
marked `implemented.mvp: false`.

For the same reason slice 1 does not stub the act clock: Floor 4 shows no
countdown (FR5.6), and `timer.durationMs` is only the FR8.4 stall backstop, so the
generic floor-timer HUD is suppressed and the backstop raises its own
`floor4-stall-backstop` flag rather than an ordinary floor timeout.

### Slice-2 deviation: empty broadcast rehearsal

Slice 2 proves the **single-authority phase machine** and arena clock before the
systems that make those phases physical exist. It therefore runs as an empty
broadcast rehearsal: headline windows are marked cleared immediately, and each
intermission auto-advances after a short deterministic hold. This is deliberately
non-conformant with the final FR2.2 triggers where the player takes the Green
Room exit and final stairs; slice 5 replaces this rehearsal hand-off with the
real Green Room transaction.

The arena clock still obeys FR1.2/FR1.3 during the rehearsal: it advances only in
`WAVES`/`HEADLINE`, holds during `COUNTDOWN` and `INTERMISSION`, and reaches
exactly 600,000 ms at `VICTORY`.

## Test Plan

| Level            | Coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**         | Phase transition table totality (every trigger from every phase); arena clock advances in combat (including the victory lap) and holds in overtime/intermission; an early kill does not shorten the act; wave manifest determinism for a fixed seed; budget curve maths; debt cap and phase-boundary clearing; debt release consumes no RNG; Headliner draw is without-replacement, grade-legal, and seed-stable; per-visit shop stock is seed-stable **and** path-independent (identical after divergent simulated combat); stock retires on exit and retires unpurchased generated instances; the affordability invariant (FR6.8) holds for every visit. |
| **Integration**  | Full act cycle `WAVES → HEADLINE → INTERMISSION → WAVES`; the intermission transaction in order, including force-resolution of an uncollected chest at the act mark; zero hostile entities and zero player damage across a Green Room visit; the Green Room is `RoomRole.SAFE` and the generic floor-timer HUD is suppressed; the cut awards nothing; overtime terminates at its cap; stairs refuse to descend outside `INTERMISSION(5)`.                                                                                                                                                                                                                  |
| **Headless**     | `tests/headless/floor4-arena-completion.test.ts` — a seed sweep asserting the declared win-rate gate; a determinism test asserting identical `RunStats` fingerprints across repeated runs of the same seed; a bounded-episode assertion (no run exceeds the configured raw elapsed-time stall backstop).                                                                                                                                                                                                                                                                                                                                                   |
| **E2E / visual** | HUD surfaces from slice 6 via `tests/e2e/helpers/pixels.ts` and `ui-probe.ts`, deterministic only — never an LLM judge.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Lab**          | `src/labs/floor4-arena-lab/` for exploratory phase/wave/boss inspection. **Lab proof is never sufficient** for a wiring or behavior claim (project rule #9); each slice's "done when" names a real-pipeline artifact.                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## Constitutional Compliance

| Principle                   | How Floor 4 complies                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Lab-gated development       | `floor4-arena-lab` ships with the phase machine; every later slice extends it.                                                                                                      |
| Deterministic CI only       | Every gate is a script with an exit code; the win-rate gate is a seed sweep, never a judge.                                                                                         |
| Never `Math.random()`       | All draws come from derived `SeededRandom` streams (R7).                                                                                                                            |
| Never `Date.now()`          | The arena clock accumulates per-tick deltas (FR1.5).                                                                                                                                |
| Every system sim-side wired | `arenaDirectorSystem` is wired via scenario pipeline slots into both `src/engine/sim/simulation-step.ts` and `src/game/ai/simulation-step.ts` in the slice that introduces it (D1). |
| Observe before done         | Each slice's "done when" names the real game or headless artifact; HUD work adds deterministic visual checks.                                                                       |
| Win-rate, not seeds         | Balance is gated on a seed sweep; per-seed tuning is prohibited (FR10.4).                                                                                                           |
| ADR for 2+ system decisions | [ADR 0090](../../docs/knowledge/adr/0090-floor4-arena.md).                                                                                                                          |
| Layer boundaries            | Clock/phase/wave-schedule logic is pure and core-eligible; spawning and scenario glue live in `src/game/`; HUD lives in `src/engine/`.                                              |

## Docs / index updates required

- `.specify/specs/README.md` — current-specs table row. ✅ (this session)
- `docs/knowledge/adr/README.md` — by-number row + Floors thematic entry. ✅ (this session)
- `docs/knowledge/game-design/game-design-document.md` — Floor Design section. ✅ (this session)
- `docs/knowledge/game-design/lore-bible.md` — floor-identity source register row. ✅ (this session)
- `docs/systems/06-map-generation.md` and the systems catalogue — **when slice 1 lands**.
- Handoff at `docs/knowledge/handoffs/2026-08-22-floor4-arena-design.md`. ✅ (this session)
