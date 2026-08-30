# ADR 0094: Floor 5 — Hostile Takeover siege architecture

## Status

Proposed

## Date

2026-08-30

## Estimated Complexity

🍎 x 5 for the implementation epic; 🍎 x 3 for the docs-only design package.

## Context

Floor 5 replaces exploration and arena survival with a deterministic siege front: autonomous
allied and enemy minions contest structures, named enemy Heroes counter-push, field tasks
authorize a siege engine, an escort creates a permanent breach, and fixed inner-castle
encounters end in a distinct throne capture.

This crosses scenario state, navigation, factions, AI, objectives, structures, bosses, quests,
HUD, authored maps, and headless verification. The living behavioral contract is
[the Floor 5 spec](../../../.specify/specs/floor5-hostile-takeover.md); this ADR records the
durable architecture choices.

## Decision

### D1 — One phase authority, separate strategic actors

`siegeDirectorSystem` is the sole phase/latch/manifest authority. It does not steer units,
pathfind, apply damage, or instantiate individual entities. `siegeMinionSystem` owns
lane-march targeting and `siegeHeroSystem` owns Hero strategic modes; existing systems retain
movement, navigation, attacks, and damage.

All new systems register through the existing `ScenarioDefinition` slots so the windowed and
headless floor-agnostic wrappers execute the same logic. Labs remain required but do not count
as runtime wiring.

### D2 — One authored lane plus task pockets

MVP uses one primary push lane and two lateral task pockets. This preserves the MOBA decision
— advance the front or leave it to defend/prepare — without three simultaneous lane economies
that neither one player nor the current headless runner can reliably read.

The map is authored because the breach, engine route, structural targets, and set-piece plot
beats are semantic geometry. Required routes are validated for every relevant footprint.

### D3 — Explicit team and structure contracts

All combatants and objectives carry explicit team identity. Allied minions target the next
enemy structure; enemy minions target the next allied structure; Heroes select from stable
role-specific priorities. Allegiance is never inferred from entity kinds or render data.

The Command Post is an ordinary damageable combat objective with an extraordinary terminal
effect: zero health is immediate defeat. Terminal loss resolves before progress on the same
fixed tick, so simultaneous base destruction and castle capture has one answer.

### D4 — Immutable wave manifests and isolated streams

Opposing waves, Hero selection, task placement, dressing, and rewards use independent streams
derived from the floor seed and stable purpose labels. Wave manifests are immutable; capped
spawn debt releases in order without consuming RNG and clears at phase boundaries.

Candidate collections are append-only and stably ordered. Combat timing can alter outcomes,
but cannot shift downstream content selection.

### D5 — Floor-scoped requisition and one complete engine

Construction prerequisites are durable floor-scoped milestones, not gold, inventory items, or
persistent crafting materials. MVP builds one complete engine, the Ratings Ram, rather than
three shallow engine types. Destroyed rams have a deterministic rebuild path so failure adds
cost without creating a soft lock.

### D6 — Breach is an atomic navigation transaction

The wall is not considered breached because an entity disappeared or a sprite changed. The
director latches `BREACH`, retires the engine and outer-front transient state, updates collision
and navigation atomically, fixes the front at the courtyard, and only then exposes the
courtyard phase. All consumers read the breach latch plus navigation state.

### D7 — Boss defeat and castle capture are separate

The Crown Auditor closes the courtyard; Regent Emeritus closes the throne encounter. Defeating
the Regent disables royal authority and enables a separate capture interaction. Capture clears
hostile damage sources, records the terminal outcome once, and opens the Winner's Balcony.

### D8 — Headless playability grows with the feature

The minimal headless Floor 5 route lands with phase plumbing, not as the final slice. Every
behavioral slice adds and proves its scenario-AI task before later work depends on it. The final
balance slice measures completion rate, duration, structure/engine health, Hero pressure,
navigation stalls, and terminal integrity on GitHub-backed representative sweeps.

Exact tuning and acceptance thresholds remain human approval gates.

## Consequences

### Positive

- The siege has a reconstructible state machine and deterministic same-tick outcomes.
- Explicit team identity supports allies without overloading hostile-entity semantics.
- The director stays small enough to test; strategic AI remains independently replaceable.
- One complete engine validates build, escort, destruction, recovery, and breach seams.
- Atomic breach state prevents visual/navigation split-brain.
- Every implementation slice has a real-pipeline verification artifact.

### Negative

- Three coordinated authorities introduce ordering contracts that integration tests must lock.
- An authored map offers less layout variety than procedural floors.
- One lane is less conventionally MOBA-like than three lanes.
- Engine rebuild and dual-front pressure widen the balance surface.

### Risks and mitigations

- **God-object drift:** the spec explicitly denies steering, combat, and entity-spawn ownership
  to the director.
- **Allied AI stalls:** stable priorities, shared navigation, footprint reachability, and
  slice-level headless gates are mandatory.
- **Base defense overwhelms objective play:** all pressure numbers are HUMAN_GATE tuning backed
  by rate and duration telemetry.
- **Breach desynchronizes layers:** collision, pathfinding, render state, and phase transition
  occur as one tested transaction.
- **Presentation becomes color-dependent:** silhouettes, banners, health-bar treatments, and
  minimap shapes carry allegiance redundantly.

## Alternatives considered

1. **Three independent lanes.** Rejected for MVP: multiplies pathing, wave economy, camera
   legibility, and headless portfolio work before the core siege loop is proven.
2. **One director owns every unit.** Rejected: phase authority would become a per-entity
   god object and duplicate existing movement/combat systems.
3. **Player damage can breach the wall.** Rejected: bypasses the defining task/build/escort
   arc and turns siege art into an HP gate.
4. **Siege parts use persistent inventory/gold.** Rejected: couples a floor-scoped objective
   to cross-floor economy and risks unwinnable arrival states.
5. **Boss death auto-completes the floor.** Rejected: collapses the authored capture beat and
   makes simultaneous loss/capture ambiguous.
6. **Import a general MOBA framework.** Rejected after build-vs-buy review: online match,
   replication, and champion-framework packages solve a different problem and would undermine
   Crawler's deterministic ECS/layer contracts. Reusing current navigation, damage, scenario,
   quest, and boss systems leaves only small strategic kernels to build.
