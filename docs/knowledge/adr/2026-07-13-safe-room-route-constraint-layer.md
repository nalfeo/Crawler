# ADR: Safe-Room Route Constraint Layer (Supersedes Semantic Egress Ownership)

## Status

Accepted

## Date

2026-07-13

## Estimated Complexity

🍎 x 5 — new pure semantic-commitment/route reducer, provider rewiring across
movement execution, four telemetry surfaces (`SimEvent`, `RunStats`,
`winrate-sweep.ts` JSON, provider debug accessor), a new ADR, and deterministic
unit/property/provider/headless tests; touches `src/game/ai` (AI layer) and
`scripts/agent/perf` (2+ systems). Adversarial plan review completed
(`docs/knowledge/review-ledgers/2026-07-13-safe-room-route-constraints.review-ledger.json`,
`plan_divergence: major_fork`).

## Context

Floor 1's safe room needs the AI to leave through the correct door once a
legitimate objective (a threat to engage, loot to collect, an NPC to reach,
etc.) lies outside it. Every prior attempt at this modeled "leaving the safe
room" as its own **behavior-tree owner node** — a dedicated `LeaveSafeRoom` /
`SafeRoomEgress` priority (Track A priority 3.5) that seized `decision.state`,
`targetEid`, and `targetX/Y` whenever `world.playerInSafeRoom` was true and a
threat was detected outside.

That ownership model was rebuilt at least four times and never stopped
oscillating/deadlocking at the doorway:

- `9140124c fix: prevent safe-room egress oscillation relatch`
- `ac4958d4 fix(ai): separate egress latch from movement`
- `c55cb95b fix(ai): bound active egress ownership`
- `6c2ff3ca fix: resolve floor1 class-B safe-room egress deadlock (#1022)`
  (documented in
  `docs/knowledge/handoffs/2026-07-10-floor1-safe-room-egress.md`, itself the
  fourth iteration — latching a waypoint and clearing it on `playerInSafeRoom`
  flips)

Each iteration fixed a narrower symptom (relatch thrash, latch-vs-movement
coupling, moving-threat re-coupling) but the underlying problem was
architectural: **a dedicated owner node structurally competes with every other
semantic intent for the same three fields**, and the raw `playerInSafeRoom`
boolean flickers at the tile boundary, so completion/re-trigger timing was
never stable. The final egress-owner candidate, measured on a 600-run
Floor-1 sweep, still showed only 511/600 clean resolutions with 58 runs
carrying anomalous lingering "safe" flags (per the historical sweep evidence
supplied for this session) — i.e. the owner-node family had a real, bounded,
non-trivial failure rate, not a single fixable bug.

## Decision

**Delete the egress owner node entirely and replace it with a generic,
post-selection route constraint layer** that never competes for semantic
ownership:

1. **Semantic ownership is untouched and sole.** `decision.state`,
   `targetEid`, and `targetX/Y` are set exclusively by the existing intents
   (Progression, Retreat, Interact, Engage, Collect, Explore/Hunt). The new
   module (`src/game/ai/safe-room-route.ts`) never writes to `AIDecision`; it
   only ever proposes a separate movement-only **route override target**
   consumed by the provider's movement execution step, never by interaction
   or telemetry code that reads `targetX/Y` semantically.
2. **Stable, non-coordinate commitment identity.** A "commitment key" is
   derived from the winning `AIState` plus the target entity id (or a
   quantized 0.5 ft position when there is no entity), never from raw,
   continuously-moving coordinates — so a wandering hunted enemy can move
   every frame without re-triggering route recomputation, and permutation
   tests over candidate ordering are deterministic.
3. **Uniform across every external semantic target**, not a `LeaveSafeRoom`
   special case: after Track A selects a winning intent, if the player's
   current safe room differs from the room containing the (already-resolved)
   target, the constraint activates — the same code path for Progression,
   Retreat, Interact, Engage, Collect, and Explore. No intent-specific
   control-flow forks; only typed, data-only policy facts.
4. **Path-prefix / door-edge completion**, not `playerInSafeRoom` flicker.
   Once activated, the module computes a short legal exit prefix via the
   existing door-aware grid A\* and advances a monotonic `segmentIndex`
   through that precomputed tile path. Completion is "reached the end of the
   precomputed prefix," never a re-read of the raw boundary boolean, so
   threshold flicker cannot re-trigger or stall the state machine.
5. **Reuse, not reinvention.** The module takes `findPath` and `navEpoch` as
   injected dependencies — the same door-aware `findTilePath` /
   `groundPathOptions()` A* and the same door-topology epoch counter the
   provider already maintains for its own navigation cache. It recomputes a
   route only on a commitment-key change or a `navEpoch` change (a real door
   lock/unlock), never by polling A* every frame. Build-vs-buy: the existing
   rot-js-backed A\* is pinned, deterministic, and already models door-aware
   passability; adding a second navigation library would duplicate topology
   knowledge and threaten determinism for no behavioral gain.
6. **Explicit `blocked` outcome, no silent stalls.** When no legal route
   exists (e.g. the only door is genuinely sealed), the module reports
   `phase: 'blocked'`, the provider zeroes movement output for that poll, and
   the semantic owner/decision is left completely untouched — no teleport, no
   through-wall creep, no oscillation.
7. **Compact, durable diagnostics everywhere a divergence investigation would
   look.** Lifecycle counters (`totalActivations`, `totalCompletions`,
   `totalBlocked`, `totalReseeds`) and the current phase/segment are exposed
   through `BehaviorTreeAI.getSafeRoomRouteDebug()`, carried on `SimEvent`
   (`src/game/ai/event-log.ts`), summarized into `RunStats`
   (`src/game/ai/headless-runner.ts`), and emitted as sweep-level JSON metrics
   (`scripts/agent/perf/winrate-sweep.ts`) — so cloud sweep artifacts retain
   first-divergence evidence even when raw per-frame events are sampled or
   skipped.

The `SafeRoomEgress` / `LeaveSafeRoom` string and type may still appear in
historical docs/handoffs/tests-as-negative-assertions (proving the ownership
model is gone), but it is no longer a runtime priority, arbiter owner, lease,
or sticky latch anywhere in `src/`.

## Consequences

### Positive

- Semantic intents can no longer be starved or hijacked near a safe-room
  doorway — there is structurally only one owner of `AIDecision` at a time,
  matching every other part of the behavior tree.
- The same mechanism now benefits Retreat/Interact/Collect/Explore/Engage
  uniformly; previously only "leaving to fight a detected threat" got any
  egress help at all.
- Completion is driven by a precomputed path prefix, which is immune to the
  boundary-tile flicker that caused every previous relatch/oscillation bug.
- The module is a pure, fully unit- and property-tested reducer
  (`tests/game/safe-room-route.test.ts`, 31 tests) with zero ECS/Phaser
  coupling, independently verifiable without a running world.
- Real provider-level tests
  (`tests/game/behavior-tree-ai.test.ts`) and a real headless regression
  (`tests/headless/floor1-safe-room-egress-seed2-bow.test.ts`) confirm the
  historical seed2+bow deadlock signature no longer reproduces end-to-end.

### Negative

- Adds one more per-poll reducer call and a small persisted state object to
  the provider, though it only recomputes a path on commitment/nav-epoch
  changes (not every frame).
- The route module reads the target entity's live raw position rather than
  Track A's already-resolved "reachable anchor" position, which is
  intentional (see Alternatives) but means the two subsystems' internal
  notions of "the target" are subtly different and must not be conflated by
  future readers.

### Risks

- Still depends on `navEpoch` being bumped correctly whenever real door
  lock/relock state changes; if a future door-state change bypasses
  `refreshDoorNavigation()`, a stale route could persist one extra poll longer
  than ideal. Mitigated by an explicit provider-level test that exercises a
  real ECS `DoorState`/`setDoorLockConfig` relock mid-egress.
- The uniform "any external target reseeds a route" rule means a moving
  semantic target that oscillates in and out of the origin room at the
  commitment-key granularity could cause repeated reseeds; mitigated by
  keying on quantized position/entity id (not raw coordinates) plus explicit
  moving-target-identity-stability tests.

## Alternatives Considered

(All raised by the adversarial plan reviewer; ledger `plan_divergence:
major_fork`, 3 alternatives considered, all 8 concerns adopted.)

- **Pathfinding legal-mask alone (no explicit lifecycle state).** Rejected:
  a bare "is this tile passable" mask has no notion of segment progress,
  commitment stability, or blocked/reseed diagnostics — it would reproduce the
  same "which frame did this actually start/finish" ambiguity that made the
  historical owner-node bugs hard to diagnose, just without an owner fighting
  over `AIDecision`.
- **Full-corridor prefix lock (compute the entire route once and hold it
  regardless of target movement).** Rejected: for a moving semantic target
  (a hunted enemy, a moving NPC) this risks locking onto a stale full path
  that no longer terminates near the real target, reintroducing exactly the
  "re-coupling to a moving threat" bug the fourth owner-node iteration fought.
  The chosen design recomputes only a short legal **exit** prefix (enough to
  clear the doorway) and lets the semantic owner's own movement take over
  once outside, rather than routing the entire trip.
- **Room-graph portal planning (a dedicated higher-level portal/route
  planner over the room graph).** Rejected as unnecessary duplication: the
  existing door-aware grid A\* (`findTilePath` / `groundPathOptions()`) already
  models door-aware passability deterministically; a second planning layer
  over the same topology would risk the two disagreeing and would not be
  reusing existing, pinned, tested infrastructure.
- **Keep the owner-node design and add a fifth mitigation.** Rejected by the
  human up front: four iterations already fought the same structural
  conflict (one node competing with every other intent for `AIDecision`);
  the fix is architectural (move enforcement below intent selection), not
  another patch on the ownership model.
