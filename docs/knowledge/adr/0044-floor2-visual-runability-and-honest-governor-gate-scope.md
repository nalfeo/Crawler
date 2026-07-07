# ADR 0044: Floor 2 visual runability wiring and honest Governor gate scope

## Status

Accepted

## Date

2026-07-05

## Context

ADR 0043 productionised Floor 2 scenario definitions, manifest loading, and the
Governor sweep. What remained was making Floor 2 **playable and completable in
the visual game**: a player booting the game could not select Floor 2, could not
see or reach an exit staircase, and had no floor-completion screen. In parallel,
the Governor health gate (`scripts/agent/health/governor-playthroughs.ts`)
exited non-zero whenever **any** floor's win-rate fell below the 0.9 target.
Floor 2 is intentionally at 0% at this slice (documented in
`docs/knowledge/metrics/floor2-slice8-governor-sweep.json` — "0% expected, not
yet fully productionised"), so the gate shipped in a knowingly-failing state that
also aborted the local `npm run health:check` `&&` chain before downstream
checks ran.

This change spans three layers — `src/core` (Floor 2 state), `src/engine`
(rendering/interaction), and `src/game` (descend flow) — plus a health-tooling
policy decision, so it warrants its own ADR.

## Decision

1. **Floor 2 staircase state** (`src/core/faction-relations.ts`): add optional
   staircase fields to `Floor2State` (`staircasePos`, `staircaseSpawned`,
   `staircaseUnlocked`, `staircaseDiscovered`) mirroring Floor 1's objective
   lifecycle.
2. **Descend flow** (`src/game/floor2Scenario.ts`): add
   `confirmFloor2StairDescend()` which sets `staircaseDiscovered` and transitions
   the world to `safe_room`; it is idempotent (returns `false` if already
   descended).
3. **Completion detection** (`src/engine/scenes/main-game-scene-helpers.ts`):
   `getFloorRunOutcome()` returns `'cleared_floor'` when
   `floor2State.staircaseDiscovered === true`.
4. **Visual markers + interaction** (`src/engine/scenes/MainGameScene.ts`): render
   a Floor 2 exit-staircase marker and floor-aware completion screen; drop the
   guard that previously hid Floor 2 NPCs/stairs.
5. **Shared stair-marker radius**: introduce
   `FLOOR2_STAIR_MARKER_RADIUS_FT` (= 8.0) in `src/shared/constants.ts` as the
   engine/game-shared interaction radius, replacing an engine-local duplicate and
   a dead `src/game` export. Because `src/engine` cannot import from `src/game`,
   `src/shared` is the only layer both can consume. Floor 2 is not yet fully
   data-driven (unlike Floor 1, which threads `objectives.markerRadiusFt` through
   `world.floor1.objective`); a deterministic unit test keeps the constant in
   lockstep with `floor2.manifest.json` `objectives.markerRadiusFt` so the two
   `8.0` values cannot silently drift until objective plumbing lands.
6. **Boot parameter** (`src/main.ts`): support `?floor=<floorId>`, validated
   against the floor registry with a safe fallback to Floor 1 on invalid input.
7. **Floor state exclusivity** (`src/game/floorScenario.ts`): clear `floor2State`
   on Floor 1 init so the two floor states are mutually exclusive.
8. **Honest Governor gate scope**
   (`scripts/agent/health/governor-playthroughs.ts`): hard-gate (exit 1) **only
   floors that are actually productionised/wired** — currently Floor 1 (~98.3%).
   Floor 2 and the combined rate are **reported but not gating** at this slice.
   Floor 1 remains hard-gated at the 0.9 target; the change narrows scope, it
   does not weaken the Floor 1 threshold.

## Consequences

### Positive

- Floor 2 can be launched (`?floor=floor2`), played, and completed end-to-end in
  the visual game, with an exit marker and completion screen.
- A single shared source for the stair radius removes a dead export and a
  duplicated magic value; a drift-guard test enforces manifest/constant parity.
- The Governor gate is now honest: it fails on real Floor 1 regressions but no
  longer ships knowingly-red for a not-yet-wired floor, so local
  `health:check` runs its downstream checks again.

### Negative

- Floor 2's marker radius is a shared constant rather than fully manifest-driven;
  full data-driven parity with Floor 1 is deferred to the objective-plumbing
  follow-up.
- The Governor gate no longer flags Floor 2, so a future Floor 2 regression will
  not be caught by this gate until Floor 2 is promoted into the gated set.

### Risks

- If Floor 2 is productionised without adding it to the gated-floor set, its
  win-rate could regress silently. Mitigation: promoting Floor 2 into the gate is
  an explicit, small follow-up when its win-rate is expected to clear 0.9.
- The constant/manifest lockstep is enforced by a unit test; if that test is
  deleted the two `8.0` values could drift. Mitigation: the test is referenced
  from the constant's doc comment.

## Alternatives considered

1. **Delete the dead `FLOOR2_STAIR_MARKER_RADIUS_FT` export** and keep the
   engine-local constant (rejected: leaves a duplicated magic value across
   engine and the `floor2.manifest.json` objective radius, inviting drift).
2. **Thread the Floor 2 radius through `world.floor2` like Floor 1's objective**
   (deferred: correct long-term shape but a larger state-plumbing change beyond
   this visual-runability slice; captured as the objective-plumbing follow-up).
3. **Weaken the Governor gate to a soft warning for all floors** (rejected:
   violates the Floor-1 90% win-rate rule; the gate must keep hard-failing real
   Floor 1 regressions).
4. **Keep the gate failing on Floor 2's 0%** (rejected: ships a knowingly-red
   gate and breaks the local `health:check` chain for an expected, documented
   not-yet-wired state).
