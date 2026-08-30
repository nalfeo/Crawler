# ADR: Generic systems ask the floor for behavior and copy, never for its identity

## Status

Accepted

## Date

2026-08-30

## Estimated Complexity

🍎 x 2 — one new `FloorBehavior` flag, one new presentation-contract member, and
three converted call sites; behavior-preserving, no new system and no new lab.

## Context

Issue #3902 ("Remove floor specific code") asks that all floors be configured
through generic composable systems rather than floor-specific branches. Two
earlier slices established the mechanism:

- `docs/knowledge/handoffs/2026-08-03-floor-behavior-config.md` added
  `src/shared/floor-behavior.ts` — per-floor, zod-validated behavior flags read
  by generic systems through `getWorldFloorBehavior(world)`.
- ADR `2026-08-22-scenario-presentation-contract.md` added
  `src/shared/scenario-presentation.ts` — the contract `src/engine/` renders so
  the renderer never branches on floor identity.

Three generic call sites still branched on a hardcoded floor:

1. `attackWaveSystem` (`src/game/attack-wave-system.ts`) returned early unless
   `world.floorId === 'floor1'`, and sized its off-screen spawn ring from
   `floor1Config.camera.zoom` even when running on another floor.
2. `requiredShopPurchaseReserve` (`src/game/ai/required-purchase-reserve.ts`)
   returned `0` unless `world.floorId === 'floor1'`. The gate was load-bearing:
   `getShopkeeperStage` reports the unpaid `not-met` stage for any world that
   has no shop errand at all, so without a scope the AI would reserve gold
   forever on every other floor.
3. `MainGameScene.openLoadoutModal` rendered the literal
   `'Floor 1 is paused until you confirm a starter weapon.'` on its **generic**
   starter-loadout path — copy that would narrate the wrong floor for any other
   scenario reusing that picker.

Each is a case where adding a floor means editing generic code.

## Decision

Extend the two existing config channels; do not add a third.

- **`FloorBehavior` gains `trashAttackWaves`.** `attackWaveSystem` gates on
  `getWorldFloorBehavior(world).trashAttackWaves`. `GameWorld.attackWaveFlags.attackWaves`
  stays the run-local kill switch layered above it, so waves need both the floor
  opt-in and the run opt-in. The spawn-ring viewport now comes from the running
  floor's manifest (`getWorldFloorManifest(world)?.camera.zoom`), falling back to
  `CAMERA.BASE_ZOOM`.
- **The required-purchase reserve keys on existing config.** It applies only
  when the world has an explicitly assigned `floorId` _and_ that floor's manifest
  declares `merchantCharmGatesEquipment` — i.e. the floor genuinely gates
  progression behind the merchant charm. The explicit-`floorId` requirement
  matters because `getWorldFloorBehavior` falls back to `floor${world.floor}`,
  and `world.floor` defaults to `1`; without it every synthetic world would
  inherit Floor 1's charm gate.
- **`ScenarioPresentationContract` gains an optional `starterLoadout` member**
  (`title`, `pausedNotice`, `prompt`, `optionDescriptionPrefix`).
  `src/game/scenarioDefinitions.ts` supplies Floor 1's copy;
  `MainGameScene` renders it and presents no generic picker when a scenario
  omits it.

Every new flag continues to default to `false`/absent, so a new floor opts in
explicitly rather than silently inheriting Floor 1 semantics.

## Consequences

### Positive

- Adding a floor that wants trash attack waves, a required merchant charm, or the
  generic starter-loadout picker is a manifest/scenario edit, not a code edit.
- `src/game/attack-wave-system.ts` no longer imports `floor-config.js` at all,
  removing the last Floor 1 coupling from that system.
- The starter-loadout copy is now covered by a deterministic real-artifact e2e
  assertion (`tests/e2e/main-game-scene-boot.test.ts`) rather than by nothing.

### Negative

- `FloorBehavior` keeps growing one flag at a time; the schema is now 12 flags
  and will need grouping if it keeps expanding.

### Risks

- A future floor that enables `attackWaveFlags.attackWaves` but forgets
  `trashAttackWaves` gets silence rather than an error. This is the deliberate
  default-off contract of `FloorBehavior`, and it is covered by the per-floor
  inertness tests in `tests/game/attack-wave-system.test.ts`.

## Alternatives Considered

- **Delete the floor gates outright.** Rejected: that would silently enable
  attack waves and the gold reserve on Floors 2–4, a real gameplay change.
- **A `check:floor-branches` deterministic guard in this change.** Rejected for
  now: floor scenarios, floor manifests, and the floor registry are legitimately
  floor-shaped, so the guard needs a designed allowlist. It belongs to the epic,
  not to this slice.
- **Unify the settlement-return-routing default onto one behavior flag.**
  Rejected here: `headless-runner.ts` (Floor 1), `headless-runner-cli-lib.ts`
  (Floor 2) and the AI-runner lab (Floor 1 or 2) disagree _by design_ today — an
  existing regression test pins "the RUNNER default stays off on Floor 2" — and
  sweeps call `runHeadless` directly, so collapsing them would change AI behavior
  in Floor 2 sweeps. That needs sweep evidence, not a mechanical refactor.
