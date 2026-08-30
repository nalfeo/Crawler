# Spec: Floor 5 — Hostile Takeover

> **Status:** Proposed — design only.
> **Authored:** 2026-08-30.
> **Estimated complexity:** 🍎🍎🍎🍎🍎 (Massive implementation epic; decomposed below).
> This docs-only design session is 🍎🍎🍎.
> **Authored content:** [`docs/knowledge/game-design/floor5-hostile-takeover.md`](../../docs/knowledge/game-design/floor5-hostile-takeover.md).
> **Architecture:** [ADR 0094](../../docs/knowledge/adr/0094-floor5-hostile-takeover.md).
> **Epic input:** [`docs/knowledge/epics/floor-5-hostile-takeover/floor-5-hostile-takeover.epic.json`](../../docs/knowledge/epics/floor-5-hostile-takeover/floor-5-hostile-takeover.epic.json).

## Context

Floor 5 is a castle siege presented as a hostile corporate acquisition. It must play as a
shifting MOBA front rather than an exploration floor or a room-wave mode with castle art:
allied and enemy minion waves contest an authored lane, enemy Heroes counter-push, the
player completes field tasks to build siege engines, protects the engine that opens a
persistent breach, then clears the courtyard and captures the throne.

The approved planning gate is that lore, objectives, runtime systems, presentation,
balance, and deterministic verification form one dependency-valid implementation DAG.
Exact health, damage, cadence, costs, time limits, and completion-rate targets remain
**HUMAN_GATE** decisions for the balance slice.

## Requirements

### R1 — Authored battlefield and terminal outcomes

- **FR1.1** The authored map contains a Command Post, Siege Yard, primary lane, two flank
  task pockets, checkpoints, outer wall, one breach site, courtyard, throne room, and
  Winner's Balcony. All required routes are reachable for player and relevant unit sizes.
- **FR1.2** The Command Post is a damageable combat objective, never a safe room. Reaching
  zero health immediately transitions to `DEFEAT`, regardless of engine or capture state.
- **FR1.3** The floor completes only after the Regent is defeated and a distinct throne
  capture transaction succeeds. A boss death alone never means the castle is captured.
- **FR1.4** Every run terminates exactly once with `captured`, `player_defeated`,
  `command_post_destroyed`, or `stall_backstop`. Simultaneous events use the deterministic
  ordering in R2.

### R2 — Single-authority phase machine

- **FR2.1** `siegeDirectorSystem` is the only writer of:
  `MUSTER → CONTEST → BUILD → ESCORT → BREACH → COURTYARD → THRONE → CAPTURED`, with
  `DEFEAT` reachable from every non-terminal phase.
- **FR2.2** On each fixed simulation tick, terminal loss is resolved before progress:
  player death, then Command Post destruction, then stall backstop, then phase progress.
  A same-tick base loss therefore defeats a same-tick breach or throne capture.
- **FR2.3** The director owns phase state, latches, manifests, and transition cleanup. It
  does not pathfind, steer units, apply damage, execute attacks, or instantiate individual
  entities.
- **FR2.4** Every transition emits phase, reason, simulation tick, base health, active
  engine state, breach state, and Hero state to `RunStats`.
- **FR2.5** A hard stall backstop ends abandoned/non-terminating runs. Its value is a
  **HUMAN_GATE** informed by measured representative runs, not a player-facing countdown.

### R3 — Lanes, teams, minions, and wave pressure

- **FR3.1** All combatants carry explicit team/faction identity. Target selection never
  infers allegiance from sprite, spawn source, or the presence of `Enemy`.
- **FR3.2** `siegeMinionSystem` owns deterministic allied and enemy lane-march decisions.
  It selects structural or opposing-unit targets from stable ordered candidates and uses
  shared navigation; it is wired through `ScenarioDefinition` into both windowed and
  headless real pipelines. A lab-only reference is insufficient.
- **FR3.3** Wave contents and release ticks are immutable manifests generated from isolated
  seeded streams. Live caps and bounded spawn debt apply per team; debt is discarded on
  phase transitions and consumes no RNG when released.
- **FR3.4** Allied minions advance toward the next enemy objective. Enemy minions
  counter-push toward the Command Post. Neither waits for player proximity.
- **FR3.5** Checkpoint ownership changes the legal spawn/front line but never consumes RNG
  or changes already-authored manifests.
- **FR3.6** Structures and minions use explicit target-priority contracts. Player and Hero
  actions may change the battle result, never iteration order or RNG consumption.

### R4 — Field tasks and build authorization

- **FR4.1** The player completes authored field tasks while the lane battle continues:
  secure the Siege Yard, recover three component classes, and clear the forward checkpoint.
- **FR4.2** Task progress is durable scenario state backed by explicit events. Escort
  distance, structure health, lane control, construction progress, and timed occupation are
  system state, not overloaded quest booleans.
- **FR4.3** The quest presentation consumes that state through stable goals:
  `opening-push-repelled`, `yard-secured`, `components-ready`, `ram-built`,
  `checkpoint-cleared`, `wall-breached`, `courtyard-cleared`, `regent-defeated`,
  and `castle-captured`.
- **FR4.4** Build resources are floor-scoped requisition milestones, not inventory items,
  gold, or persistent materials. This prevents Floor 5 from consuming cross-floor gear
  economy and keeps headless decisions bounded.
- **FR4.5** Construction begins only after all prerequisites latch. The build site is
  attackable; interruption pauses progress rather than rerolling or deleting milestones.

### R5 — Siege engines, escort, and breach

- **FR5.1** MVP ships one required engine, the **Ratings Ram**. Trebuchet and sapper concepts
  are future variants, not parallel mandatory systems hidden inside this epic.
- **FR5.2** The ram has deterministic states:
  `LOCKED → BUILDING → READY → ADVANCING → ATTACKING → BREACHED | DESTROYED`.
- **FR5.3** Once ready, the ram advances on a fixed authored route when its protection
  condition is met. It never teleports, recomputes a random route, or targets arbitrary wall
  tiles.
- **FR5.4** A destroyed ram is rebuildable from the latched prerequisites after a
  **HUMAN_GATE** recovery delay/cost. Destruction cannot soft-lock the floor.
- **FR5.5** Only the ram damages the outer-wall breach objective. Player and minion damage
  may suppress defenders but cannot bypass the construction/escort arc.
- **FR5.6** `BREACH` is an explicit transition seam. It latches exactly once, retires the
  ram and its route markers, stops outer-lane wave debt, freezes the final front at the
  courtyard, updates navigation/collision atomically, and opens the courtyard ingress.
  Surviving Heroes and minions follow manifest-authored cleanup/retreat rules.
- **FR5.7** S6 consumers enter the courtyard only by reading the breach latch and open
  navigation state; they never infer a breach from wall entity absence.

### R6 — Enemy Heroes

- **FR6.1** Heroes are boss-strength named defenders selected without replacement from an
  append-only, stably ordered roster using a dedicated derived stream.
- **FR6.2** Each Hero declares a tactical role and stable priorities: counter-push,
  checkpoint defense, engine disruption, minion support, or artillery.
- **FR6.3** `siegeHeroSystem` owns Hero strategic mode selection; existing combat systems
  execute movement and attacks. It responds to latched task/build state and is wired into
  both real simulation paths.
- **FR6.4** Defeated field Heroes respawn at fixed manifest-authored ticks or remain defeated
  according to their slot. Respawn timing never depends on wall clock or RNG draws.
- **FR6.5** The Crown Auditor is the fixed courtyard momentum check and Regent Emeritus is
  the fixed throne boss. Neither is drawn from the field-Hero card.

### R7 — Courtyard and throne handoff

- **FR7.1** `COURTYARD` begins only after FR5.6 completes. Outer-lane spawns remain stopped;
  surviving allied units hold at the authored courtyard line and cannot enter the throne
  room.
- **FR7.2** Defeating the Crown Auditor and clearing the authored defenders opens the throne
  doors and transitions to `THRONE`.
- **FR7.3** Regent Emeritus is a fixed, seeded encounter with bounded summons and explicit
  telegraphs. Summons count against the encounter cap and retire with the encounter.
- **FR7.4** Defeating the Regent enables, but does not complete, capture. The player must
  interact with the throne capture point; the transaction latches royal authority disabled,
  clears hostile damage sources, records victory, and opens the Winner's Balcony.
- **FR7.5** Capture interaction versus timed occupation is a **HUMAN_GATE**. The recommended
  MVP is one explicit interaction because it is legible, bounded, and headless-friendly.

### R8 — Determinism and random-stream isolation

- **FR8.1** All Floor 5 variation derives from the floor seed plus stable purpose labels:
  `waves`, `heroes`, `tasks`, `dressing`, and `rewards`. No Floor 5 content reads the shared
  combat RNG.
- **FR8.2** Same seed and same input trace produce identical map identity, manifests, Hero
  card, task placement, phase sequence, and outcome telemetry in windowed and headless runs.
- **FR8.3** Stable candidate ordering is a data contract. Reordering existing Hero, wave, or
  task entries is a seed-breaking change.
- **FR8.4** Breach collision and navigation update in one deterministic transaction. There
  is no frame where the wall looks open but remains blocked, or is passable before it looks
  breached.

### R9 — Presentation and authored content

- **FR9.1** The HUD shows phase, next objective, Command Post health, construction/ram state,
  checkpoint control, active Hero identity/health, and throne capture availability.
- **FR9.2** Distinct deterministic cues announce base danger, build completion, Hero arrival,
  ram damage/destruction, breach, throne opening, and capture.
- **FR9.3** Team silhouettes, banners, health-bar treatment, and minimap markers make
  allegiance readable without relying on color alone.
- **FR9.4** All Director lines and plot beats are authored static content. No LLM runs in
  gameplay or CI.
- **FR9.5** The real game is observed before completion: primary-lane readability, opposing
  wave direction, Hero salience, base alerts, engine damage states, persistent breach, and
  throne escalation must be captured with deterministic visual/runtime evidence.

### R10 — Headless strategy, balance, and performance

- **FR10.1** Scenario AI exposes explicit tasks to defend base, complete field tasks,
  escort/protect the ram, suppress a Hero, enter the breach, defeat the Auditor/Regent, and
  capture the throne.
- **FR10.2** Slice-level headless gates exist before final balance:
  S2 completes one opposing-wave cycle and damages a structure; S3 completes each task
  contract; S4 observes Hero spawn/defeat/respawn; S5 builds, destroys/rebuilds, escorts, and
  breaches; S6 reaches exactly one terminal capture.
- **FR10.3** The final sweep reports outcome, failure cause, phase durations, base health,
  engine lifecycle, breach tick, Hero defeats/respawns, and path stalls.
- **FR10.4** Hard balance targets are **HUMAN_GATE**: target completion rate, median and p95
  duration, minimum base-health cushion, ram survival/rebuild rate, Hero pressure, and live
  entity/frame budgets. Broad sweeps use GitHub infrastructure.
- **FR10.5** The acceptance gate includes zero unreachable required objectives, phase-order
  violations, invalid target allegiances, navigation mismatches, unbounded spawn debt, and
  non-terminal runs across the representative sweep.

## Design decisions

1. One authored primary lane plus two task pockets preserves MOBA push/pull without creating
   three independent battle simulations the player cannot read.
2. One required ram gives the epic a complete engine lifecycle; additional engine classes are
   follow-up content after this contract is proven.
3. Dedicated minion and Hero strategic systems keep the director a phase authority instead of
   a god object.
4. Base loss is immediate defeat and resolves before same-tick progress.
5. Breach is a durable state transaction, not a missing wall sprite.
6. Floor-scoped requisition milestones avoid coupling siege construction to persistent
   inventory/economy.
7. The Headless route lands in slice 1 and grows with every behavioral slice.

## Epic decomposition

| #   | Slice                                                      | Persona                             | Depends on | Done when                                                                                                                    |
| --- | ---------------------------------------------------------- | ----------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 1   | Architecture, floor plumbing, authored map, phase skeleton | Systems Engineer                    | —          | Windowed and headless real pipelines load Floor 5 and produce the same empty phase trace on a reachable map.                 |
| 2   | Teams, lane minions, waves, structures, base defense       | Systems Engineer + Game AI Engineer | 1          | Headless opposing waves contest a checkpoint and damage the correct structure with stable allegiance and no stalls.          |
| 3   | Field tasks, requisition milestones, construction          | Game Designer                       | 1          | Headless completes every prerequisite, pauses/resumes construction under attack, and cannot build early.                     |
| 4   | Field Hero roster, strategic AI, defeat/respawn            | Game AI Engineer                    | 2, 3       | A seeded Hero card spawns, chooses valid strategic targets, is defeated, and follows its deterministic respawn contract.     |
| 5   | Ratings Ram lifecycle, escort, destruction/rebuild, breach | Systems Engineer                    | 2, 3, 4    | Headless exercises the full ram state machine and atomically opens a navigable breach without a soft lock.                   |
| 6   | Courtyard, Crown Auditor, Regent, throne capture           | Game Designer                       | 5          | A real headless run crosses the breach, clears both fixed encounters, captures once, and emits one terminal outcome.         |
| 7   | Narrative, quests, HUD, audio, sprites, visual evidence    | Content + UX + Graphics             | 1–6        | The real game communicates every objective/state without color-only cues and deterministic captures prove the full plot arc. |
| 8   | Integrated QA, performance, balance, achievements          | QA Engineer + Playtester            | 2–7        | Human-approved rate/duration/resource budgets pass a representative GitHub-backed sweep with zero structural violations.     |

Every node is materialized with the same dependency graph in the epic JSON. No
implementation node may start until the human review issue for that exact revision is closed
as completed.

## Test plan

- **Unit:** phase ordering, target priorities, manifests, task prerequisites, engine state
  transitions, Hero card/respawn, breach transaction, terminal idempotency.
- **Integration:** opposing teams, structure damage, construction interruption, base-loss
  precedence, destroy/rebuild/escort/breach, courtyard cleanup, throne capture.
- **Headless:** per-slice gates from FR10.2 plus the final representative sweep.
- **E2E/visual:** HUD fit and accessibility, base alarm, Hero arrival, ram damage states,
  collision-matched breach, throne/capture presentation.
- **Property-based:** same-seed replay, candidate-order stability, no friendly fire unless
  explicitly authored, reachability, and exactly one terminal outcome.

## Constitutional compliance

| Principle                | Compliance                                                                                                                                                        |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deterministic simulation | Isolated seeded manifests; fixed-tick schedules; no wall clock or runtime LLM.                                                                                    |
| Layer boundaries         | Strategic state is core/game-side; Phaser only projects state.                                                                                                    |
| Lab-gated systems        | Each new system requires a lab plus real ScenarioDefinition pipeline wiring.                                                                                      |
| Observe before done      | Every behavioral slice names a headless real-pipeline gate; S7 captures the real game.                                                                            |
| Balance by rates         | Final values and gates require human approval and representative sweeps, never cherry-picked seeds.                                                               |
| Build vs buy             | Reuse existing ECS, navigation, damage, boss, quest, and scenario contracts; custom deterministic strategic kernels are narrower than importing a MOBA framework. |

## Non-goals

- Three playable lanes, PvP, direct minion commands, online networking, procedural castle
  layouts, destructible arbitrary walls, runtime-generated dialogue, or multiple mandatory
  siege-engine classes.
- Final tuning numbers before the balance slice produces evidence and receives human approval.
