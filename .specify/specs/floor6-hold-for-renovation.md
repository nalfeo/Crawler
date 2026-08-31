# Spec: Floor 6 — "Hold for Renovation"

> **Status:** Proposed; no Floor 6 runtime/data is shipped by this contract.
> **Authored content:** [Floor 6 content bible](../../docs/knowledge/game-design/floor6-hold-for-renovation.md).
> **Architecture:** [ADR 0097](../../docs/knowledge/adr/0097-floor6-hold-for-renovation.md).
> **Epic:** [Floor 6 implementation graph](../../docs/knowledge/epics/floor-6-hero-tower-defense/floor-6-hero-tower-defense.epic.json).

## Context

Floor 6 is an original compact, one-sided defense production set. It is neither Floor 4's
clock-survival arena nor Floor 5's opposing-lane siege. Proposed names are human-gated; all
numeric tuning is deferred to S9 and must be supported by representative sweep evidence.

## Requirements

### R1 — Authored set and one terminal objective

- **FR1.1** The map has player ingress, one protected Relay, at least two readable authored enemy
  routes, wave entrances, authored build sites, a sealed break enclosure, pickup-safe access, and
  an exit. Every supported footprint reaches its required destination.
- **FR1.2** Sites are off-route, fixed semantic geometry. Occupancy cannot block, reroute, or
  overlap an enemy route.
- **FR1.3** Relay destruction latches `DEFEAT`; finale entity absence never implies victory.

### R2 — Phase and terminal authority

- **FR2.1** `defenseDirectorSystem` is sole writer of
  `SETUP → DEFEND → BREAK → FINALE → VICTORY` and `DEFEAT`, phase latches, manifests, and
  transition cleanup; it does not steer, attack, damage, or instantiate individual combatants.
- **FR2.2** Each fixed tick resolves terminal loss before progress: player death, Relay
  destruction, then bounded stall/backstop, then wave/phase/victory progress. A same-tick loss
  beats break entry or victory.
- **FR2.3** Break entry atomically stops releases, clears hostile combat/projectile ownership,
  clears debt, and records pickup carryover/conversion. Break actions are only those explicitly
  allowed by the manifest; break exit creates the next immutable manifest before releases resume.
- **FR2.4** Every transition emits reason, tick, Relay health, manifest index, active sites,
  floor-scoped currency/upgrades, and terminal state to `RunStats`.

### R3 — Waves, routes, and enemy authority

- **FR3.1** The director owns immutable wave and entrance manifests; deterministic AI owns
  route-following and legal target choice; existing movement/combat owns execution.
- **FR3.2** Every manifest uses isolated `waves`/`routes` purpose streams, fixed release ticks,
  stable route IDs, and bounded live cap/debt. Releasing debt consumes no RNG; debt clears at
  every break and terminal transition.
- **FR3.3** A missing/dead/invalid wave entity cannot leave the phase waiting forever; its
  deterministic resolution is telemetry-visible.
- **FR3.4** Route, entrance, enemy roster, reward, site, tower, offer, and boss/add candidate
  collections are append-only and stable-ID ordered. Reordering existing entries is seed-breaking.

### R4 — Loot and run-scoped upgrades

- **FR4.1** Enemy/wave rewards are authored data and emitted by the authoritative reward path;
  ordinary loot remains compatible while build currency is floor-scoped.
- **FR4.2** Offers use an isolated `upgrades` stream, stable IDs, and without-replacement
  manifests. Rejected, duplicate, or unaffordable selection is an atomic no-op.
- **FR4.3** Missed pickups, destroyed towers, and skipped offers cannot permanently block the
  required route. Persistent inventory never pays or receives floor-scoped construction state.
- **FR4.4** Currency, offers, purchases, and effects reset once during every terminal cleanup and
  cannot leak into another Floor 6 run.

### R5 — Authored-site defenses

- **FR5.1** Construction is limited to approved unoccupied sites. UI requests transactions but
  cannot own occupancy, cost, upgrade, sell, or teardown state.
- **FR5.2** Site/tower state is an explicit schema, not a render inference. Build, upgrade, sell,
  break, and terminal teardown are idempotent transactions; a broken defense frees its site
  safely and preserves no illegal route state.
- **FR5.3** Towers use existing combat primitives where possible; their target ties are stable,
  effects/projectiles are bounded, and their definitions/values are validated data.

### R6 — Active Crawler and automation

- **FR6.1** The Crawler retains normal movement, combat, abilities, pickups, equipment, and death
  handling. Towers complement rather than replace player combat.
- **FR6.2** Scenario AI chooses sites, pickup/upgrade transactions, priority threats, and retreat
  from public scenario state only; it has no omniscient shortcut.
- **FR6.3** At least one S6 acceptance case is hero-gated and cannot pass with towers alone.

### R7 — Finale, victory, and safety

- **FR7.1** The fixed Deadline encounter and bounded add manifest pressure approved routes and
  the Relay without bypassing site or route rules.
- **FR7.2** Boss defeat enables one authoritative payout and exit transaction. It retires hostile
  state, emits one victory, opens one exit, and wins only if terminal-loss precedence did not fire.
- **FR7.3** A bounded backstop and all cleanup paths yield exactly one terminal outcome.

### R8 — Presentation and authored content

- **FR8.1** HUD/cues expose phase, incoming route, Relay danger, site state, loot/build currency,
  offer choice, break safety, and finale state without color-only meaning.
- **FR8.2** Quest data reads exactly the stable goal IDs in the content bible; it never reimplements
  scenario state. Director copy is static authored data; runtime LLM generation is prohibited.
- **FR8.3** S8 supplies deterministic real-game evidence for route direction, occupied/vacant
  sites, range/tier, pickup/offer, break quiescence, Relay danger, and finale readability.

### R9 — Determinism, telemetry, and acceptance

- **FR9.1** Same floor seed and input trace produce identical map identity, manifests, offers,
  phase/terminal trace, and telemetry in windowed and headless pipelines.
- **FR9.2** S2 proves geometry/parity; S3 proves routes, caps/debt, and loss precedence; S4
  proves economy/reset; S5 proves site/combat/teardown; S6 proves hero-gated automation; S7
  proves finale/one-shot terminal state; S8 proves presentation; S9 proves integrated release.
- **FR9.3** S9 reports phase durations, manifests, leaks, Relay health, build/upgrade/loot flow,
  hero/tower contribution, boss state, stalls, live entities, frame cost, cleanup, and outcome.
- **FR9.4** S9's completion rate, durations, Relay cushion, wave/tower/economy values, break
  duration, boss pressure, and entity/frame budgets are HUMAN_GATE values tested on GitHub-backed
  representative sweeps. No cherry-picked seed substitutes for a rate.
- **FR9.5** Every new system has a lab and ScenarioDefinition wiring in both real pipelines; a
  lab-only reference is insufficient.
- **FR9.6** Focused unit/integration/property/headless/E2E checks cover terminal precedence,
  stable ordering/replay, site legality, atomic transactions, route reachability, break cleanup,
  no soft lock, and exactly one terminal outcome.

## Constitutional compliance

| Principle              | Contract                                                                                                    |
| ---------------------- | ----------------------------------------------------------------------------------------------------------- |
| Determinism            | Fixed-tick authority, isolated streams, immutable manifests, stable ordering; no wall clock or runtime LLM. |
| Layering               | ECS/scenario state remains core/game-side; UI and Phaser only request/project it.                           |
| Wiring and observation | Each behavior is lab-tested and executed in both real pipelines; S8 observes the game.                      |
| Balance                | S9 tunes only through owned data using representative rates and human approval.                             |
