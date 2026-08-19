# ADR: Unified den-boss diagnostic telemetry contract

## Status

Accepted

## Date

2026-08-18

## Estimated Complexity

🍎🍎🍎 — one new shared schema + collector, wired into three existing runtime
surfaces (headless, AI-Runner lab, real game), no new lab required.

## Context

Floor 2 seed 42 exposed a diagnostic split: headless `RunStats.floor2Progression`
only carried lifecycle latches (encounter started/defeated), while the
player/AI-Runner session JSONL carried player state, kills, and quests but
neither surface recorded den-boss spatial evidence (is the boss inside its den,
is the den door sealed, is the boss visible/alive). Diagnosing the Queen Mab
sealed-den softlock from a 3,707-line recording was not possible because none
of the three telemetry paths agreed on what to capture or how to capture it —
this decision affects `src/game/ai/` (headless runner + player-session
recorder), `src/shared/` (the schema), and `src/core/`-adjacent floor systems
that the collector reads, so it crosses the 2+ system ADR threshold.

## Decision

Add one versioned schema — `DenBossSnapshot`, `DenBossTransition`,
`DenBossDiagnostics`, `DenBossEventPayload` — in
`src/shared/den-boss-telemetry-types.ts` (leaf layer, no `core`/`game` imports,
mirroring the existing `weapon-telemetry-types.ts` split). A single collector
and transition tracker, `createDenBossTransitionTracker` in
`src/game/ai/den-boss-telemetry.ts`, reads world state once per poll and is
shared by all three runtime surfaces instead of each surface re-deriving den
state independently:

- `headless-runner.ts` polls the tracker every simulation frame and sets
  `RunStats.denBoss` at every return path, including before the player-death
  exits, so a lethal frame's den transition is never dropped.
- `player-session-recorder.ts` (shared by the real game and the AI-Runner lab)
  polls the same tracker, emits `den` `SimEvent` records into the downloadable
  JSONL, and exposes `getStats().denBoss`.
- Both runtime callers use the tracker's own `getSnapshots()` for periodic
  aggregate records so `lastKnownBossEid` survives boss defeat (the stateless
  `_collectDenBossSnapshots` helper, used only for the tracker's own baseline
  observation, always sees the current tick and cannot recover an already-nulled
  `bossEid`).

The rollup accumulates inside the tracker so it lands on `RunStats`/recorder
stats even when no event sink is wired; `eventStreamType: 'den'` documents the
join key (`familyId` + `frame`) between the rollup and the `den` event stream,
not a guarantee that the stream exists — when no sink is wired, the rollup
(`transitions`/`transitionsTruncated`) is the only surviving evidence.

## Consequences

### Positive

- One collector eliminates drift between headless, AI-Runner, and real-game
  den-boss evidence — the softlock signature (`denSealed && !bossInDen`) can be
  queried identically from any of the three artifacts.
- Non-den floors pay zero cost: `_hasDenBossTelemetry` short-circuits on a map
  lookup before any snapshot work runs.
- Quiet-frame polling reuses per-den scratch snapshots; durable clones are
  materialized only when a transition fires, bounding steady-state allocation.

### Negative

- `RunStats.denBoss` is a new top-level field alongside the pre-existing
  `RunStats.floor2Progression`; consumers must know both are Floor-2-family
  keyed rather than nested.
- The scratch-snapshot design still allocates in components it calls
  (`worldToTile`, `getRoomAt`) that were not built allocation-free; the
  collector's own hot path is allocation-free but its callees are not.

### Risks

- Boss/door entity ids are recycled by bitecs; every poll re-validates by
  component membership rather than trusting a cached eid, which is the
  documented mitigation but relies on every future den-adjacent system
  continuing to null/reassign ids through the same component removal path.

## Alternatives Considered

- **Keep headless and player-session den evidence separate.** Rejected: this is
  exactly the split that made the seed-42 softlock undiagnosable; two divergent
  ad hoc implementations would drift again on the next Floor 2 change.
- **Nest `denBoss` under `floor2Progression`.** Rejected: `floor2Progression` is
  headless-only lifecycle state; `denBoss` is produced identically by all three
  surfaces and is a spatial/diagnostic layer, not a progression latch — nesting
  would imply a dependency that does not exist.
- **Emit periodic snapshots from the stateless collector call.** Rejected: it
  always observes the current tick, so once `floor2ObjectiveTick` nulls
  `encounter.bossEid` on defeat, no post-defeat sample can recover the boss
  identity; the stateful tracker's `getSnapshots()` retains `lastKnownBossEid`
  across the same clear.
