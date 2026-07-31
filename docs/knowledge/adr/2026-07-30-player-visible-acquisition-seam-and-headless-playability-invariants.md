# ADR: Player-visible acquisition seam coverage and Floor 2 headless playability invariants

## Status

Accepted

## Date

2026-07-30

## Estimated Complexity

🍎 x 4 — cross-layer seam contract spanning generated-equipment grant state,
engine inventory observation, real-scene probe/e2e coverage, and Floor 2
headless invariant enforcement.

## Context

PR #2368 closes a regression class where generated-equipment grant-side
contracts could pass while the player-visible outcomes silently drifted. The
branch touches multiple layers for one reason:

- Generated equipment can enter the run through several real acquisition
  sources (achievement reward claim, Quartermaster purchase, boss chest, floor
  drop), but the existing tests mostly proved the grant-side mutation in
  isolation rather than the **acquire → render/equip → continue run** seam the
  player actually experiences.
- `InventoryUI` historically projected only static catalog bag entries, while
  generated-equipment instances live in a separate immutable registry. That let
  grant-side systems succeed without guaranteeing the real inventory surface
  could render or equip the awarded gear.
- Floor 2's headless runner is the repo's deterministic playability oracle, but
  before this branch it did not assert that generated-equipment economy actions
  left the run in a playable state (e.g. no unopened reward boxes, no empty slot
  left alongside matching bagged generated equipment, no spent-equipment-gold run
  ending with no generated equipment at all).

The branch therefore needs an explicit architecture decision tying these layers
into one contract instead of letting each subsystem validate itself separately.

## Decision

Treat generated-equipment acquisition as a **player-visible seam contract** with
both observation-side and headless-runtime enforcement:

1. **Registry-backed source coverage.** Maintain a single acquisition-source
   registry for the real generated-equipment grant paths we promise to support,
   and require the e2e seam harness to cover every registered source.
2. **Inventory observation includes generated instances.** `InventoryUI` builds
   its render/filter/signature/equip model from both static catalog items and
   generated-equipment instances, using the frozen instance display metadata as
   the player-facing source of truth and the base equipment id only for lookups
   such as art/equip behavior.
3. **Real-scene probe helpers mutate through real grant paths, then refresh the
   observed surface.** The main-scene probe stays a lab-only test seam, but it
   must drive the same runtime APIs the game uses and refresh the visible scene
   surface after those mutations so paused-scene e2e assertions observe the same
   state a player would.
4. **Headless runner enforces playability, not just progress.** On Floor 2, the
   deterministic runner classifies end-of-run equipment playability violations
   and fails the run immediately when the generated-equipment economy leaves the
   player in an obviously inconsistent state.

This keeps gameplay authority in core/game systems, keeps rendering authority in
engine/UI code, and uses labs/e2e/headless checks to verify the seam where those
layers meet.

## Consequences

### Positive

- New generated-equipment acquisition sources cannot land silently without a
  deterministic seam test proving the result reaches rendered inventory output.
- Generated-instance rewards are observable and equip-capable through the same
  runtime inventory surface players use, rather than through test-only internal
  state inspection.
- Floor 2 headless runs become a stronger fail-fast oracle for economy
  regressions that would otherwise appear only as "the grant succeeded but the
  run still became unwinnable / misleading."

### Negative

- The seam contract couples several existing layers, so follow-up changes to new
  acquisition sources, inventory rendering, or headless playability rules must
  be kept in sync rather than evolving independently.
- Some probe helpers need explicit UI refreshes after runtime mutations in
  paused-scene tests; forgetting that refresh can make e2e failures look like
  gameplay bugs when the issue is really an observation seam.

### Risks

- Headless invariant rules that are too strict could reject quirky-but-valid play
  states, so every new violation type must remain deterministic, specific, and
  grounded in clearly player-visible broken outcomes.
- Inventory rendering now depends on frozen generated-instance presentation data;
  any future schema drift there must preserve the existing observable fields or
  degrade fail-closed.

## Alternatives Considered

1. **Keep grant-side unit/integration tests only.** Rejected because it preserves
   the exact blind spot this PR is fixing: grant APIs can stay green while the
   player-visible inventory/equip seam regresses.
2. **Solve the problem entirely in the engine layer by synthesizing fake catalog
   items for generated instances.** Rejected because it duplicates generated
   instance state and risks the UI diverging from the canonical immutable
   instance registry.
3. **Rely on broad seed sweeps without explicit acquisition seam tests.** Rejected
   because a long headless run can miss source-specific observation bugs and is a
   slower, less local signal than a deterministic acquire-and-observe contract.
