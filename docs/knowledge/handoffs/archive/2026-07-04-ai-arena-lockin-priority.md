# Session Handoff: AI arena lock-in priority (stacked on PR #764)

## Date

2026-07-04

## Persona

BT AI Engineer

## Systems touched

ai-behavior-tree, enemies

## Apples

2🍎 exact — pure detector + one BT priority slot + tests + ADR/ledger. No new systems, no wiring changes to preSystems/postSystems.

## What Was Done

Introduced a new BT Track A priority slot — **1.5 (Arena lock-in)**, between
Retreat and Interact — that pins the objective (spawner or Floor-1 boss)
as the current target whenever the AI is physically caged inside an arena.
Driven by a pure, deterministic detector at `src/game/ai/arena-lockin.ts`
that requires a **barrier-verified** state: an arena only counts as
"locked in" when `world.spawnerArenaFence.get(eid)` is non-empty (open
fence) OR `world.spawnerArenaDoors.get(eid)` is non-empty (sealed room),
matching the physical reality of the cage from PR #764. Boss rooms are
handled via `world.floor1?.objective?.bossBattles`; spawner wins the
tie-breaker when both are true; lowest eid wins between multiple locked
spawners. Retreat still outranks lock-in (life-critical).

Observed in the new synthetic headless sweep (`tests/headless/ai-arena-lockin-resolution.test.ts`) —
before: 0/8 arenas resolved (baseline "AI walks past" caveat from PR #764).
After: 8/8 (100 %) resolved at frames 331, 403, 295, 439, 259, 259, 331,
295 within a 60 s budget.

## Key Decisions Made

- **Priority slot 1.5, not 0.5.** Retreat outranks arena lock-in — a
  dead player never resolves the arena either. Everything below Interact
  is preempted because interact/progress/wander are all only reachable
  after the cage lowers.
- **Barrier-verified rule.** `arenaState === 1` alone would false-fire on
  Floor-1 spawners whose fence/door snapshots come back empty (spawner
  outside a room, ring tiles not passable-to-start). Committing to those
  "arenas" measurably regressed the natural Floor-1 win-rate floor
  during development. Requiring at least one snapshot entry keeps the
  detector faithful to _physical_ lock-in and preserves the win-rate.
- **Spawner wins over boss in the tie-breaker.** The fence ring is the
  more localized cage (≤ ~8 ft vs a whole room), so the spawner is the
  more urgent objective.
- **For spawner lock-in, do not chase adds.** The rats-nest defensive
  spawn rate (~2 s cadence, 5-cap) makes add-clearing Sisyphean; sinking
  time into adds is time the spawner uses to add more. The lock-in
  behavior only pre-empts to clear an add for **boss** targets, where
  adds are finite. The synthetic sweep confirms 100 % resolution with
  that strategy.
- **Dedicated synthetic sweep instead of relying on natural Floor-1.**
  The current Floor-1 fixture produces 0 barrier-armed arenas per the
  telemetry in `spawner-arena-win-rate.test.ts`, so the observable
  contract "AI knows it is stuck AND prioritizes the objective" can
  only be measured on synthetic arenas that actually cage the player.
  The natural sweep keeps its win-rate floor and reports the metric,
  but the gate is vacuous until Floor-1 starts producing real barriers.

## What's Next / Blockers

- Future Floor-1 tuning that starts producing real fence-tile rings or
  door locks will automatically activate the `resolved / barrierArmed ≥
0.95` gate in `spawner-arena-win-rate.test.ts`. If it starts failing
  once real barriers appear, revisit `bt-ai-provider.ts`
  `buildArenaLockinBehavior` (in particular whether Retreat's re-entry
  from outside a real barrier needs handling).
- The synthetic sweep intentionally uses `hp = 1000` on the player to
  isolate the priority-slot contract from Retreat's interaction. A real
  physics barrier makes that boost unnecessary; if we ever ship one in
  a test fixture, drop the boost and reassert.

## Retrospective

### Lessons Learned

- Optimistic `arenaState = 1` from `spawnerArenaSystem` is not enough
  signal for AI targeting — `raiseFence` and `lockRoomDoorsImpl` can
  both return empty snapshots on natural Floor-1 (no passable ring
  tiles, roomless spawners). The detector must check the
  fence/doors _maps_, not just the state byte, or it commits the AI to
  a phantom arena.
- Retreat is a silent priority-slot invalidator: once HP drops enough
  to trigger it, everything below is skipped. When a test observed the
  AI abandoning a half-dead spawner and never returning, the culprit
  was Retreat, not the arena logic itself — the fix was to give the
  synthetic-test player enough HP that Retreat can't fire, not to
  demote Retreat below lock-in.
- The rats-nest defensive spawn budget (5 alive, 2 per pulse, 2 s
  cadence) is dense enough that any add-chasing pass regenerates faster
  than it clears. Committing to the spawner and eating add contact
  damage is strictly cheaper on time-to-resolution.

### Mistakes Made

- Initially tried "clear adds first" universally in the lock-in behavior;
  this oscillated the AI between spawner and adds and stalled at
  ~63 % resolution. Signal that catches this sooner: watch per-tick
  `decision.targetEid` transitions on a failing seed — if the target
  flips repeatedly between the spawner and one of its children, the
  hysteresis is too small or the strategy is wrong. Fix: restrict add
  pre-emption to boss lock-in only.
- Initially used `hp = 100` on the synthetic-test player, which put
  Retreat in play and produced deterministic 5/8 failures (seeds 2, 4,
  7). Signal: log spawner HP + player HP + decision.state per tick on
  a failing seed — Retreat's `state=2` transition and player HP
  crossing the retreat threshold appear together.

### Opportunities for Future Improvement

- Consider promoting the barrier-verified rule into `spawnerArenaSystem`
  itself: only set `arenaState = 1` when at least one of fence/doors
  snapshots is non-empty. That would remove the need for the AI-side
  guard and might simplify the HUD/announcement path too. Deferred
  because it changes user-visible arena-start behavior and belongs in a
  separate PR.
- A helper that returns the _arena boundary distance_ would let the
  detector distinguish "just barely inside the cage" from "dead-center"
  and could inform kite radius selection for boss lock-ins.
