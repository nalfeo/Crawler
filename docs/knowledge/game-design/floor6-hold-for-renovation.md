# Floor 6 — "Hold for Renovation" Content Bible

> **Status:** Proposed. The title, protected-objective noun, authored-site model, active-Crawler
> rule, and run-scoped upgrade model are `HUMAN_GATE` proposals, not canon, until approved.
>
> **Season episode:** _"Hold for Renovation."_ The network has sold a live restoration special
> before confirming that the condemned broadcast set can survive its own ratings plan. The
> contestant is the on-site responder: fight through incoming crews, collect their dropped
> requisitions, and use fixed maintenance plinths to keep the proposed **Broadcast Relay** online
> until the final inspection becomes a Deadline.

This is the authored-content reference. The living runtime contract is
[the Floor 6 spec](../../../.specify/specs/floor6-hold-for-renovation.md); durable architecture
choices are in [ADR 0097](../adr/0097-floor6-hold-for-renovation.md); implementation order is
the [Floor 6 epic](../epics/floor-6-hero-tower-defense/floor-6-hero-tower-defense.epic.json).
The spec, not this bible, owns phase behavior, goal IDs, state schemas, and acceptance tests.

## 1. Provenance and distinction

| Claim                                                                              | Traced to                                                                                |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Constructed, entertainment-maximizing dungeon and backstage breaks                 | [Lore Bible](lore-bible.md) §§Dungeon, Tone Guide                                        |
| Director/sponsor voice and season-quirk treatment                                  | [Lore Bible](lore-bible.md) §§The Director, Season Quirks, Sponsor Companies             |
| Floor 4 is a timed survival arena with a continuous act clock                      | [GDD](game-design-document.md), [Floor 4 bible](floor4-arena.md)                         |
| Floor 5 is a siege with opposing lanes, a Command Post, breach, and throne capture | [GDD](game-design-document.md), [Floor 5 bible](floor5-hostile-takeover.md)              |
| Floor 6 proposed requirements, implementation ownership, and approval gate         | [Floor 6 epic](../epics/floor-6-hero-tower-defense/floor-6-hero-tower-defense.epic.json) |

No source conflict was found. This proposal creates no lore about the Gradient, dungeon origin, or
timeline. Any later conflict is an unresolved record in
[lore-contradictions.md](lore-contradictions.md), not a silent edit.

Floor 6 is **not Floor 4**: it has routes, an objective that can be damaged, construction choices,
and no survival-clock win. It is **not Floor 5**: it has no opposing army, castle, siege engine,
breach, capture, or territorial push. Its compact set is a one-sided route-defense problem in
which the Crawler personally fights inside the defense, rather than a stationary tower cursor.

## 2. Player-facing fantasy and set

The proposed set is a shuttered broadcast-renovation floor: taped-off corridors, service bays,
relay conduits, and apologetic sponsor signage. Incoming demolition crews follow a small number
of readable routes toward the Relay. The player moves, attacks, collects ordinary drops and
floor-scoped build currency, and chooses among authored maintenance plinths; a plinth supports at
most one defense and never changes route geometry.

The Relay is the floor's single protected objective and its destruction ends the run. The exact
title and Relay noun remain approval-gated; the structural fantasy—protect one original,
in-fiction broadcast-critical object from scheduled pressure—is what this document proposes.

> Director, proposed cold open: _"Good news: this set is scheduled for a modest renovation.
> Bad news: the contractor has interpreted ‘modest’ as ‘all at once.’"_

Tone is procedural dark comedy, not catastrophe horror. Season quirks flavor delivery only; they
do not change routes, objectives, or mechanics. All later dialogue is static authored data.

## 3. Arc, spaces, and authored content

`SETUP → DEFEND → BREAK → FINALE → VICTORY`, with `DEFEAT` reachable from every non-terminal
phase, is narrated here but specified in `R2`.

| Beat / space                | Content purpose                                                                                                |
| --------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **Ingress and briefing**    | Shows the Relay, routes, entrances, and vacant plinths before pressure starts.                                 |
| **Compact defense lanes**   | Two or more deliberately legible, short routes converge near the Relay; they are not a Floor 5 front.          |
| **Maintenance plinths**     | Fixed, visually distinct build sites beside—not on—paths; occupied and vacant states read without color alone. |
| **Service break enclosure** | A sealed, non-hostile reset beat where construction/upgrade choices are safe and bounded.                      |
| **Deadline bay**            | Final inspection set-piece where the fixed Deadline encounter uses the established routes.                     |
| **Cleared exit**            | Opens only after the authoritative victory payout; it is never inferred from a missing boss sprite.            |

At a break, hostiles, hostile projectiles, and unspent spawn debt are retired by the spec's
transaction; legal pickups persist or are explicitly converted by manifest policy, and only the
approved safe actions remain. The break is neither a Floor 4 commercial shop reroll nor Floor 5
territory recovery.

## 4. Content/data contract

Slice 8 authors a validated quest pack that only projects spec-owned goal flags:
`floor6.defense.briefed`, `floor6.defense.firstWaveCleared`,
`floor6.defense.firstBuildPlaced`, `floor6.defense.firstUpgradeChosen`,
`floor6.defense.breakCleared`, `floor6.defense.deadlineDefeated`, and
`floor6.defense.relaySecured`. Quest text never writes phase, currency, waves, or victory.

Later content uses append-only, stable-ID registries for route labels, entrances, sites, waves,
reward pools, tower definitions, upgrade offers, and boss/add manifests. Names, art, maps,
dialogue, and designs are original; familiar defense-genre conventions are not a license to copy
protected expression.

## 5. Ownership and later-slice map

| Contract / slice          | Owner                               | Acceptance anchor                                                  |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| S2 foundation/map         | Systems Engineer                    | `FR1`, `FR2`, `FR9.5` reachable, parity-loaded authored geometry   |
| S3 wave director/routing  | Systems Engineer + Game AI Engineer | `FR3`, `FR9.1` immutable routes/manifests and bounded terminal run |
| S4 loot/upgrades          | Game Designer                       | `FR4`, `FR9.2` atomic transactions and no missed-pickup soft lock  |
| S5 construction/combat    | Systems Engineer + Game Designer    | `FR5`, `FR9.2` site legality, stable targeting, teardown           |
| S6 active hero/automation | Game AI Engineer + Systems Engineer | `FR6`, `FR9.2` public-state headless strategy and hero-gated case  |
| S7 Deadline finale        | Game Designer                       | `FR7`, `FR9.6` one outcome/payout/exit                             |
| S8 content/presentation   | Content + UX + Graphics             | `FR8`, deterministic real-game readability evidence                |
| S9 balance/release        | QA + Playtester + Game Designer     | `FR9`, representative sweep and all approved numeric gates         |

## 6. HUMAN_GATE register

| ID             | Proposed non-numeric decision                           | Owner / approval evidence           |
| -------------- | ------------------------------------------------------- | ----------------------------------- |
| `HUMAN_GATE-1` | Episode title and renovation-production identity        | Human + Content Designer            |
| `HUMAN_GATE-2` | Defend-the-Relay objective noun/framing                 | Human + Content Designer            |
| `HUMAN_GATE-3` | Authored, non-blocking tower-site-only construction     | Human + Systems Engineer            |
| `HUMAN_GATE-4` | Crawler remains an active combatant, not a build cursor | Human + Game Designer / UX Designer |
| `HUMAN_GATE-5` | Run-scoped upgrades reset at terminal cleanup           | Human + Game Designer               |

All numeric values—wave cadence/caps, costs, yields, upgrade effects, break duration, finale
pressure, duration/rate targets, and performance budgets—remain `HUMAN_GATE` decisions for S9
after representative evidence. Content Design neither selects them nor substitutes prose for the
owning persona's decision.
