# ADR: Scenarios declare their presentation contract; the engine renders it

## Status

Accepted

## Date

2026-08-22

## Estimated Complexity

🍎 x 4 — one new shared contract module plus four engine call sites rewired
(Director commentary, stair marker, stair-descend prompt, floor-completion
screen) across the engine, game, bootstrap, and shared layers.

## Context

`MainGameScene` (`src/engine/scenes/`) hard-coded Floor 1 and Floor 2 behavior
in four places:

- **Director commentary** branched on `world.floor === 1`, read a Floor 1 copy
  table (`FLOOR_1_COMMENTARY`) declared inside the engine, and used a separate
  Floor 2 branch keyed on the `floor2-victory` goal flag.
- **The floor-exit marker** had one branch reading `floorScenario.objective` and
  another reading `floorExtendedState.familyState`, each with its own label,
  radius source, and lock styling.
- **Stair proximity and the descend confirmation modal** recomputed the same
  dual-path check and picked modal copy from an `isFloor2` boolean.
- **The completion screen** derived the terminal outcome from two unrelated
  world shapes (`runSummary.outcome` vs `familyState.staircaseDiscovered`) and
  then selected one of four hard-coded copy blocks.

Adding Floor 3 therefore meant editing the renderer, which contradicts the
layer model in `docs/architecture.md`: `src/engine/` is the replaceable Phaser
bridge and must not own game content. ADR 0086 (`2026-08-04`) established that
the engine consumes normalized, id-addressed data instead of per-concept
special cases for generated art; this ADR applies the same rule to floor
presentation.

The blocker is that the natural owner of this content is `src/game/`, and
`src/engine/` must not import `src/game/` (enforced by `eslint.config.js`).

## Decision

Introduce a **scenario presentation contract** declared in the leaf layer,
`src/shared/scenario-presentation.ts`, and consumed by both sides:

- `ScenarioPresentationContract<TWorld>` carries the Director contract (intro,
  ordered milestones with stable ids, victory/timeout beats and their
  predicates), a canonical `getRunOutcome`, `getCompletionCopy`,
  `getStairMarkerState`, `stairConfirmation`, and `nextFloorId`.
- Every member is generic over the world type because `src/shared/` must not
  import `src/core/`; both consumers instantiate it as
  `ScenarioPresentationContract<GameWorld>`.
- `selectScenarioCompletionVariant(outcome, { nextFloorId, isTerminalRunVictory })`
  is the single pure completion-variant selector, replacing the engine's
  `getFloorRunOutcome` / `getFloorCompletionPresentation` helpers (both deleted).
- `src/game/scenarioDefinitions.ts` owns the per-floor data; bootstrap
  (`createFloorMainSceneOptions`) passes `getScenarioPresentationContract(scenario)`
  into `MainGameSceneOptions.scenarioPresentation`.
- `MainGameScene` reads only the contract. It no longer references
  `world.floor`, `floorScenario.objective`, `familyState`, or the
  `floor2-victory` flag for any of these four surfaces, and its Floor 1 copy
  table is gone.

Marker semantics are normalized: `visible` means "the marker should be shown",
and `locked` means exactly "descent is barred". `locked` is derived from the
same `staircaseUnlocked` flag that `confirmFloor1StairDescend` /
`confirmFloor2StairDescend` enforce, so the prompt can never be offered for a
descent the scenario would reject.

## Consequences

### Positive

- A new floor ships entirely inside `src/game/` + `src/shared/data/`; the
  renderer is untouched.
- Terminal outcome has one canonical definition per scenario instead of two
  structural world-shape probes in the engine.
- Director beats are ordered, id-latched data, so a floor can add or reorder
  commentary without touching a scene method.
- The prompt/confirmation disagreement that the old Floor 2 path allowed
  (offering descent while `staircaseUnlocked` was false) is now impossible by
  construction.

### Negative

- The contract types are generic over `TWorld`, which is slightly noisier than
  naming `GameWorld` directly. This is the cost of keeping `src/shared/` a leaf.
- A scene booted without a contract (labs with a bare world) presents no
  Director commentary, stair marker, stair prompt, or completion screen. That
  matches the previous behavior for labs that already passed no `director`, but
  it is now uniform across all four surfaces.

### Risks

- A scenario that reports `locked: false` while its `onStairDescend` still
  rejects would strand the player at a prompt that does nothing. Mitigated by
  deriving `locked` from the confirmation's own gate and by unit tests that
  assert the contract and `confirmFloor{1,2}StairDescend` agree.
- Milestone ids are latched per run; reusing an id for a different beat would
  silently suppress it. Documented on `ScenarioDirectorMilestone`.

## Alternatives Considered

- **Manifest-only DSL** (floor copy in JSON): rejected — milestone predicates
  are real world queries, not data.
- **A `floorId` switch in bootstrap**: rejected — moves the branch one layer
  down without deleting it.
- **Module augmentation of `MainGameSceneOptions` from bootstrap**: implemented
  first, then rejected — the engine could not name the type it was handed, so
  the field stayed unread and the branches survived (a dead parallel path).
- **Declaring the contract inside `src/engine/` and relying on structural
  typing from `src/game/`**: rejected — duplicated declarations drift, and the
  shared types would have had no non-test production consumer in the game layer.
- **A single `ScenarioUiSnapshot` recomputed per frame**: rejected — forces
  every surface to allocate on every tick.
- **Event-stream rewrite of Director commentary**: rejected — far larger blast
  radius than the ordered-milestone list this issue needs.
