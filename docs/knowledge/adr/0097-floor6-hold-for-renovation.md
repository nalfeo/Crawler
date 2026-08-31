# ADR 0097: Floor 6 — Hold for Renovation defense architecture

## Status

Proposed

## Date

2026-08-31

## Estimated Complexity

🍎 x 4 — proposed cross-system design contract; runtime is decomposed in the Floor 6 epic.

## Context

Floor 6 needs a deterministic, original defense floor without confusing it with Floor 4's
survival arena or Floor 5's siege. It coordinates authored geometry, scenario phases, routing,
rewards, floor-scoped construction, combat, UI, quests, and headless verification. The living
requirements are [the Floor 6 spec](../../../.specify/specs/floor6-hold-for-renovation.md);
the [content bible](../game-design/floor6-hold-for-renovation.md) owns only presentation and
canon proposals.

## Decision

### D1 — One phase/wave authority, separate executors

`defenseDirectorSystem` owns phase, terminal precedence, manifests, and transition cleanup.
Routing remains Game AI ownership; existing combat/damage owns effects; economy owns transactions;
UI only requests and projects. All systems register through `ScenarioDefinition` for windowed and
headless parity.

### D2 — Compact authored routes and non-blocking sites

The map uses a compact, original defense set with fixed routes and semantic build sites beside
them. Defense construction can never mutate navigation topology. This makes route reachability,
occupancy, and build-break recovery testable.

### D3 — Immutable manifests and isolated purpose streams

Wave, route, rewards, upgrade, dressing, and boss/add choices derive from independent named
streams and append-only stable-ID collections. Runtime combat timing cannot consume or shift
content-selection RNG.

### D4 — Floor-scoped economy and safe lifecycle

Build currency, upgrade offers, purchases, towers, and site occupancy are explicit floor-scoped
state. They neither spend persistent inventory nor persist across terminal cleanup. Breaks clear
hostile activity/debt transactionally while retaining only manifest-authorized pickups/state.

### D5 — Relay loss wins races; finale victory is explicit

Player death, Relay loss, and a bounded backstop resolve before same-tick phase/finale progress.
The Deadline encounter is a fixed, bounded final manifest; its defeat enables an idempotent
payout/exit transaction rather than inferring success from entity absence.

### D6 — Human choices approved; numeric tuning stays deferred

The title, objective framing, site-only model, active-Crawler rule, and run-scoped upgrade model
(`HUMAN_GATE-1` through `HUMAN_GATE-5`) are **approved** — [#3963](https://github.com/nalfeo/Crawler/issues/3963)
was closed as completed by the human owner. All numeric values remain Game Designer/Playtester
evidence decisions in S9; Content Design does not decide them.

## Consequences

### Positive

- Keeps the director testable and prevents UI, AI, or content from becoming a hidden authority.
- Guarantees fixed topology, replayable manifests, safe breaks, and one terminal outcome.
- Lets the player remain an active combatant while tower construction is bounded and readable.

### Negative

- Authored maps trade procedural variety for semantic, testable geometry.
- Break cleanup and floor-scoped lifecycle require explicit integration coverage.
- The final balance surface spans route pressure, player contribution, and construction economy.

### Risks

- **Tower-only play:** S6 has hero-gated acceptance coverage.
- **Path or site soft lock:** S2/S5 require all-footprint reachability and atomic site transactions.
- **Replay drift:** stable IDs/order and purpose streams are part of the schema contract.
- **Unfair terminal races:** fixed precedence and one-shot terminal telemetry are tested.

## Alternatives Considered

1. **Procedural, place-anywhere towers.** Rejected: player construction would alter routes and
   create hard-to-prove reachability and soft-lock states.
2. **A Floor 4 arena clock with defense art.** Rejected: it loses the protected-objective and
   placement loop, producing a cosmetic reskin rather than a distinct floor.
3. **A Floor 5-style opposing lane/siege.** Rejected: autonomous allied fronts, breach, and
   territorial capture duplicate Floor 5 rather than providing one-sided defense.
4. **One god system controlling waves, AI, combat, economy, and towers.** Rejected: duplicates
   existing ownership and makes deterministic tests brittle.
