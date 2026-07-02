# ADR: AI Predictive Safe-Gap Travel Steering

## Status

Accepted

## Date

2026-07-02

## Estimated Complexity

🍎 x 4 — new pure steering subsystem plus provider wiring and a simulation-only
measurement lens; touches `src/core` and `src/game` (2 layers) but needs no new
core-systems lab (the AI runner is exercised by the headless runner + sweep).

## Context

The AI Runner (the deterministic headless auto-player used for balance sweeps and
the Floor-1 completion gate) treated travel and combat as distinct phases. While
travelling to objectives it charged in near-straight lines and only reacted to
mobs with an additive last-moment dodge, so it took heavy avoidable contact damage
and skipped loot/XP it passed. During ENGAGE, by contrast, the same AI already
kites and orbits mobs superbly at close range.

The user asked for the runner to "dance and kite the normal mobs" _while
travelling_, reuse the proven ENGAGE dodging behaviour during explore/approach,
blend in opportunistic farming, and still complete Floor 1 before the ~360s
floor-collapse deadline — under hard constraints: the AI must stay
**damage-agnostic** (no branching on enemy damage), there must be **no
game-engine tweaks** (enemy damage/count/AI/aggression and player stats
untouched), **no hardcoded floor-specific knowledge**, everything stays
deterministic, and success is gated on the **aggregate win-RATE** (never on
cherry-picked seeds).

To _measure_ whether "just run through enemies" is genuinely costly (the point of
the exercise), we also needed a way to scale hostile damage in simulation without
letting the AI see or react to it.

## Decision

1. **Reuse the ENGAGE kite math for travel.** A new pure module
   `src/game/ai/travel-steering.ts` (no ECS/Phaser imports) scores a fan of
   candidate headings around the objective direction, using a continuous-collision
   predicted-minimum-gap (`predictedMinGapFt`) and a shared kite-tangent helper
   (`extractKiteTangent`) so the runner arcs around mobs at the same surface
   spacing the ENGAGE orbit already proves safe.
2. **Blend, don't gate.** `src/game/ai/bt-ai-provider.ts` (`computeTravelSteering`
   - the `poll()` blend) steers the travel heading toward the highest-scoring safe
     arc, folds in opportunistic loot/farm pulls when there is spacing to spare, and
     retires the old additive dodge when steering owns the frame — so farming and
     questing are no longer strictly separate phases.
3. **Anchor tuning to the proven envelope.** `src/game/ai/bt-ai-tuning.ts` holds
   the HARD/SAFE/COMFORT surface-gap constants, body radius, and CCD epsilon,
   anchored to the ENGAGE orbit distances rather than new magic numbers.
4. **Damage as a measurement lens, never an input.** `src/core/world.ts` adds an
   optional `hostileDamageMultiplier` (default `1` ⇒ zero behaviour change) that
   `src/core/systems/damageSystem.ts` applies only to player-facing contact and
   projectile damage. The AI never reads it; `tests/game/ai-damage-invariance.test.ts`
   enforces that AI decisions are identical across multipliers.

## Consequences

### Positive

- On the full 1x sweep (seeds 1-16 × sword/bow/baseball-bat, damage ×1) the runner
  takes ~20% less total contact damage, min-HP rises from ~61% to ~76%, gold +~11%,
  and win-rate improves to 83.3% (40/48) vs main's 81.25%.
- Travel motion is visibly arc-like/kiting instead of straight-line charging.
- The steering core is a pure, deterministic, unit- and property-tested module,
  decoupled from ECS and rendering.
- The measurement lens makes "run through enemies" quantifiably costly without
  coupling the AI to damage.

### Negative

- Clear-time can rise on some seeds (the runner spends time arcing/farming); this
  is accepted per the brief as long as the run still wins before collapse.
- Adds a candidate-scoring pass per travel frame (small, bounded CPU cost).

### Risks

- Adding perceived hostiles as avoidance obstacles can, if over-tuned, tip
  symmetric corridor stand-offs into multi-second nav-wedges. Mitigated by keeping
  the shipped threat set to moving mobs (main-parity) and deferring spawner-inclusion
  / wider body radii to a dedicated nav-layer follow-up (they regressed the
  win-rate envelope when bundled — see the review ledger).
- The remaining losses cluster on seeds 2/12/13 (pre-existing safe-room / nav-wedge
  behaviour, not kiting failures); the 90% target depends on that separate follow-up.

## Alternatives Considered

- **Tune existing dodge scalars only.** Rejected: the user explicitly asked for
  algorithmic pathing changes, and scalar tuning could not produce natural arcs or
  reuse the ENGAGE behaviour.
- **Make dodging scale with enemy damage.** Rejected outright by the user; would
  violate the damage-agnostic constraint.
- **A separate "farm" phase distinct from travel.** Rejected: the goal was to blend
  farming into travel, not add another phase boundary.
- **Ship all five code-review enhancements** (static-spawner threats, per-body
  contact radius, low-gap loot gate). Rejected for now: bundled they flipped three
  previously-winning seeds into nav-wedges (win-rate 83.3% → 77.1%). They are
  main-parity enhancements, not regression fixes, so per the win-rate gate they are
  deferred with root cause rather than shipped. The two behaviour-neutral fixes
  (CCD epsilon hardening, dead-code removal) were kept.
