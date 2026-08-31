# ADR: Floor 4 arena HUD as a pure shared projection over sim state

## Status

Accepted

## Date

2026-08-29

## Estimated Complexity

🍎 x 4 — new `src/shared/` HUD projection module, sim-side `src/game/floor4Scenario.ts`
state additions, and a new `src/engine/` HUD surface wired through `HudUI`, each with
dedicated unit/e2e coverage.

## Context

Floor 4 needed dedicated HUD feedback for its arena/Green Room loop — act clock, show
clock, overtime countdown, manifest-driven wave pips, Headliner HP, cut notice, break
summary, and Winner's Circle copy — none of which existed on any prior floor's HUD
surfaces. This change spans two architectural layers: `src/game/` (sim-side
`Floor4ArenaState` gains an `actBaseline` and `breakGoldSnapshot` so the break summary
can report THIS act's delta instead of the run-cumulative totals or the live,
continuously-mutating gold balance) and `src/engine/` (a new `HudFloor4Arena` surface
mounted through `HudUI`, offsetting the boss bar/announcement stack while Floor 4's
panel is visible).

## Decision

Model the HUD as a pure, read-only projection (`buildFloor4HudState()` in
`src/shared/floor4-hud.ts`) over `Floor4ArenaState`/`Floor4GreenRoomState` plus the
floor's manifest-derived phase config. The projection owns all formatting/derivation
(clock strings, wave pips, cut-notice suppression, break-summary deltas); the sim owns
only the minimal state needed to make those derivations correct across act boundaries:

- `actBaseline`: a snapshot of the cumulative wave/gold counters taken the instant a new
  act's `WAVES` phase is armed, so a non-final break can diff "this act only" instead of
  re-reporting every prior act's numbers.
- `breakGoldSnapshot`: a snapshot of `playerGold` taken the instant `INTERMISSION` opens,
  so "Gold earned" is locked at the moment the break starts and does not shrink in real
  time as the player spends gold at sponsors during that same break.

`HudUI` mounts `HudFloor4Arena` unconditionally but keeps it invisible outside Floor 4,
and suppresses the floor-generic timer plus offsets the boss bar/announcement stack only
while the Floor 4 panel is visible, so floors 1-3 render byte-identically to before this
change.

## Consequences

### Positive

- The HUD layer stays render-free of gameplay logic: every displayed string is a pure
  function of already-persisted sim state, so it is trivially unit-testable and reusable
  from both the HUD lab and the real scene without duplicating formatting logic.
- Per-act deltas and the gold snapshot are proven against a real, sim-driven integration
  test (`tests/unit/floor4-arena-director.test.ts`) that drives `arenaDirectorSystem`
  through two full acts, not just hand-authored fixtures — this is deliberate given the
  wiring-vs-lab-only failure mode this repo has hit before (ADR 0039).

### Negative

- `Floor4ArenaState` grows two more fields (`actBaseline`, `breakGoldSnapshot`) that only
  exist to serve HUD presentation, slightly widening sim-side state for a UI concern.

### Risks

- Any future change to `recordFloor4PhaseTransition()`'s phase-boundary ordering could
  silently move where `actBaseline`/`breakGoldSnapshot` are captured; both captures are
  colocated with the existing wave-telemetry-flush boundary logic and covered by the
  sim-driven integration test to catch regressions.

## Alternatives Considered

- **Sim-owned HUD state**: have `floor4Scenario.ts` itself compute and store the final
  display strings. Rejected because it would leak presentation formatting into sim-side
  state and prevent the HUD lab from exercising the same projection deterministically
  without a full sim boot.
- **Reuse existing generic encounter/boss HUD widgets**: rejected because Floor 4 needs a
  combined act clock/wave-pip/break-summary/Winner's Circle panel that no existing widget
  exposes, and retrofitting one would have coupled unrelated floors' HUD surfaces.
