# Session Handoff: Floor 5 lane war

## Date

2026-08-30

## Persona

Producer → Systems Engineer / Game AI / QA

## Systems touched

ai-pathfinding, ai-behavior-tree, quests, hud-ux, enemies, ci-policy, devtools

## Apples

4🍎 estimated, 4🍎 actual (exact; multi-layer gameplay slice with core ECS
contracts, real ScenarioDefinition wiring, headless evidence, ADR, and review
ledger)

## What Was Done

Implemented Floor 5 Slice 2 for issue #3912.

- Added dedicated siege team IDs and ECS marker stores for `SiegeMinion` and
  `SiegeStructure`.
- Added immutable Floor 5 opposing wave manifests generated from the isolated
  `waves` RNG stream.
- Added bounded per-team spawn debt with manifest-index preservation for delayed
  minion spawns.
- Added explicit Floor 5 structure entities for the allied Command Post, allied
  checkpoint, enemy checkpoint, and outer wall.
- Added `siegeMinionSystem` in the real ScenarioDefinition
  `beforeEnemyAISystems` slot for wave release, minion spawn, target selection,
  and shared pathfinding steering.
- Extended `floor5ObjectiveTick` to apply minion contact damage through
  `applyDamage`, audit legal/illegal damage events, update the checkpoint front,
  synchronize structure health, and resolve Command Post defeat immediately on
  the same post-damage tick.
- Extended Floor 5 RunStats and the Floor 5 siege lab readout with structure,
  wave, debt, checkpoint, and lane telemetry.
- Added Floor 5 headless progress scoring so active siege pressure is not
  misclassified as a quest stall.
- Added ADR
  `docs/knowledge/adr/0095-floor5-lane-war-entity-contracts.md` and review
  ledger `docs/knowledge/review-ledgers/2026-08-30-floor5-lane-war.review-ledger.json`.

Real-artifact observation: `tests/headless/floor5-lane-war.test.ts` runs Floor 5
through the real headless pipeline for seed 505 and observes an opposing-wave
cycle, checkpoint contest, legal-only damage telemetry, bounded spawn debt,
structure damage, explicit siege teams, valid manifest indexes, no path stalls,
and no headless stall reason.

## Verification

- `bash scripts/agent/preflight.sh` — passed.
- `npm test -- tests/headless/floor5-lane-war.test.ts tests/headless/floor5-siege-foundation.test.ts tests/game/floor1-main-scene-options.test.ts` — passed, 3 files / 27 tests.
- `npm run typecheck` — passed.
- `npm run verify:fast` — passed before review-fix follow-ups, 147 files / 2397
  tests plus data-contract and integrity checks. Local silent-merge-revert guard
  skipped because history is shallow; CI runs it with full history.

## Review Harness

- Plan review: `gpt-5.4` adversarial review rejected the initial sidecar-heavy,
  single-system plan. The implementation adopted explicit Floor-5 ECS markers,
  split pre/post authority, stable manifest identities, entity-health-authoritative
  structures, independent damage audit, and real ScenarioDefinition wiring.
- Code review: `claude-sonnet-4.6` found stale combat-event cursor handling; the
  cursor now resets when the transient queue was drained before scanning.
- Multi-model review: `claude-sonnet-4.6`, `gpt-5.3-codex`, and
  `gemini-3.1-pro-preview` found four valid issues that were fixed:
  per-frame path-stall overcount, out-of-bounds manifest indexes, stale
  structure EID aliasing, and checkpoint-front measurement against only one
  checkpoint structure. The A\* cost concern was adjudicated non-blocking for
  Slice 2 because the live cap is bounded at eight minions and the issue asks to
  reuse shared navigation.
- Independent grade: pending at handoff authoring time; record it in the review
  ledger before publishing.

## Key Decisions Made

- **Explicit siege markers, not generic enemies.** Siege minions/structures are
  visible to Floor 5 systems without leaking into enemy AI, drops, or XP side
  effects.
- **ScenarioDefinition remains the runtime seam.** `siegeMinionSystem` is wired
  into the same floor-agnostic pipeline used by the real game and headless
  runner.
- **Post-damage objective authority owns terminal state.** Command Post health is
  synchronized from its real entity after damage, then DEFEAT is recorded before
  any same-tick progress can win.
- **Shared navigation/damage are reused.** Minions use tile pathfinding and
  `applyDamage`; Floor 5 adds only the strategy and legality layer.
- **Transient IDs require identity checks.** Stored structure EIDs are trusted
  only when the live entity still has the expected siege marker kind and team.

## What's Next / Blockers

- No known implementation blocker remains for Slice 2.
- Future slices should consider cached waypoint/front routing before raising the
  live minion cap or adding multiple lanes.
- Hero waves, Ratings Ram construction/escort, breach transaction, courtyard
  fights, throne capture, and final Floor 5 balance gates remain later-slice work.
- Floor 5 remains unreleased/non-MVP until later slices provide the complete win
  condition.

## Retrospective

### Lessons Learned

The adversarial plan review materially improved the design: explicit ECS markers
and split tick authority avoided the sidecar-only/god-system approach that would
have been harder to wire and test.

### Mistakes Made

The first implementation stamped minions with a post-advance manifest cursor and
counted route failures every frame. Review caught both before final publication.
The first damage audit also assumed a monotonic combat-event queue, which is true
headlessly but false in the rendered game because `CombatVfx` drains the queue.

### Opportunities for Future Improvement

Floor 5 lane routing should grow a cached waypoint/front representation before
the design raises minion counts beyond the current bounded smoke slice.
