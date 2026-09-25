# ADR 0111: Floor 4 bounded wave pressure

## Status

Accepted

## Date

2026-09-25

## Estimated Complexity

4 apples — extend the existing shared director, authored configuration, and runtime observations.

## Context

Issue #4517 requests about ten nearby enemies during Floor 4 wave combat,
excluding bosses and intermissions. The 9-second cadence from #4384 averages
only 0.05–3.45 living enemies within 60 feet in baseline acts across seeds
404, 1, and 2. Distant idle enemies consume the 24-enemy cap. The current
Headliner runtime and equipment scoring are already merged.

## Decision

- **DEC-001**: Wave contestants pursue throughout the arena, while ranged attack
  reach remains authored. Existing safe-room immunity and detection gates apply.
- **DEC-002**: Keep the immutable scheduled waves and their FIFO debt. Add a
  bounded pressure reserve composed on an isolated seed/act stream. The existing
  director arms at most one small reinforcement batch at a time from a fixed,
  telegraphed pair of feed gates. Scheduled waves and debt have first use of capacity.
- **DEC-003**: Recheck nearby pressure, live capacity, living player, and arena
  occupancy before releasing a batch. Obsolete reinforcements are discarded;
  they never enter scheduled spawn debt. No catch-up burst or per-frame RNG.
- **DEC-004**: Keep an authored per-act reserve ceiling, per-batch limit, release
  interval, nearby target, and incoming-population limit. The hard live/debt
  caps remain 24/18. All entities use ordinary combat, rewards, and wave cleanup.
  The authored nearby refill high-water mark is 20 within 60 feet, with at most
  24 incoming/live wave enemies, four entries per batch, a 1-second interval
  and telegraph, and 320 reserved entries per act. Travel and kills bring the
  measured average toward ten; 20 is not the expected time-weighted population.
  Split entries between the two nearest gates (stable index breaks distance
  ties) to avoid a single packed lane being erased by piercing weapons.
  A simulation-time moving average (5,000 ms response) lowers the refill ceiling
  by twice any sustained excess above eleven. This prevents a stationary player
  with slow-clearing enemies from receiving the same buffer as a moving player
  whose arriving enemies are rapidly killed. It never raises the high-water mark.
  Scheduled admission/debt drainage also pause above that average threshold;
  waiting authored debt blocks adaptive arm/release. The eleven-enemy feedback
  threshold compensates arrival delay while measured acceptance remains 8–12
  in every tested act and in the real MainGameScene.
- **DEC-005**: MainGameScene, headless simulation, and the existing arena lab
  share this scenario implementation. Validate nearby pressure independently of
  the controller, including arrival time, cap behavior, replay, and phase cuts.

## Consequences

### Positive

- **POS-001**: Nearby combat pressure responds to kills without increasing the
  hard entity cap or changing controls, boss phases, or other floors.
- **POS-002**: Seed-isolated content and fixed simulation-time servicing remain
  replayable; a stalled frame cannot release an unbounded reserve.

### Negative

- **NEG-001**: More ordinary kills increase XP and drop income. The reserve is
  finite and does not alter reward values or gear scores.
- **NEG-002**: Gate travel and telegraph time mean the target is an average,
  not a promise of ten enemies on every frame or under every player build.

### Risks

- **RSK-001**: Distant incoming enemies can fill the cap; independent nearby
  measurements must detect this rather than counting all spawned entities.
- **RSK-002**: Recycled entity IDs must not remain owned by a prior wave enemy.
  Ownership is validated against the entity generation before counting/cutting.

## Alternatives Considered

- **ALT-001**: Cadence/budget increases alone leave distant idle enemies and
  long arrival gaps. Pursuit alone fixes idling but not sustained density.
- **ALT-002**: Spawning around the player or teleporting survivors would avoid
  travel but break the authored feed-gate warning and kiting contract.
- **ALT-003**: A new spawner library or ECS system would duplicate the existing
  deterministic director. Reuse its spawn, telegraph, and cleanup helpers.
