# ADR: Boss room safe cleanup reuses corpse explosion metadata

## Status

Accepted

## Date

2026-08-27

## Estimated Complexity

🍎 x 2 — a localized Floor 1 cleanup repair that exports an existing core VFX helper
and extends the regression test for the real shared pipeline.

## Context

Floor 1 boss rooms become safe rooms after their boss encounter is defeated. The
safe-room transition now removes living, non-spawner enemies centered in the
cleared boss room so they cannot remain trapped in a commercial-break space.

The removal is environmental cleanup, not a player kill:

- it must emit the existing `corpseExplode` feedback before deleting the entity;
- it must bypass `dropSystem`, so no XP gems or safe-room loot spawn;
- it must not count as rat/slime objective kills;
- it must not remove bosses lingering under `DeathTimer`, because the final
  staircase boss unlocks the room while its death animation can still be present.

That cleanup crosses `src/game` orchestration and `src/core` event metadata. A
hand-built event in the Floor 1 scenario would omit core visual snapshots such as
`bloodColor`, sprite texture, appearance key, variant roll, and size scale.

## Decision

- **DEC-001**: Reuse `emitCorpseExplosion` from `src/core/apply-damage.ts` for
  environmental boss-room cleanup. The helper remains core-owned because the
  event shape and body/sprite store snapshots are floor-agnostic.
- **DEC-002**: Delete the entity from `world.floorScenario.enemyArchetypes`
  before clearing stores and removing it. This prevents the next Floor 1
  objective tick from treating environmental cleanup as a player kill, and
  prevents stale archetype attribution if the EID is recycled.
- **DEC-003**: Keep the `DeathTimer` and `Spawner` exclusions in the Floor 1
  cleanup loop. Spawners keep their existing death handshakes, and the staircase
  boss can remain visible while the room becomes safe.
- **DEC-004**: Cover the behavior through `runSimulationStep` in
  `src/game/ai/simulation-step.ts` with canonical Floor 1
  systems from `createFloor1MainSceneOptions`, not by calling only the scenario
  tick. The regression verifies the real post-system transition used by both
  headless and visual pipelines.

## Consequences

### Positive

- Safe-room cleanup uses the same corpse-shatter metadata as normal corpse
  hits, so slime blood remains green and generated sprite variants remain
  available to renderers.
- Objective kill counts and headless kill bookkeeping are not polluted by
  environmental removals.
- Final-boss death animation preservation is explicitly guarded while another
  in-room enemy is still removed.

### Negative

- `emitCorpseExplosion` is now part of the core module surface instead of being
  private to damage application.
- The Slime Rat regression still nulls the removed boss EID to avoid a
  test-only EID recycling artifact; the staircase regression is the authoritative
  lingering-boss pipeline case.

### Risks

- Future changes to `emitCorpseExplosion` now affect both hit-corpse bursts and
  safe-room cleanup bursts. This is intentional, but tests should keep asserting
  blood-color metadata for boss-room cleanup.
- If future boss-room cleanup paths remove enemies without deleting
  `enemyArchetypes`, Floor 1 objective bookkeeping can regress. The focused test
  asserts the tracked entry is gone and the slime count does not increase.

## Alternatives Considered

- **Duplicate the event construction in `floorScenario.ts`.** Rejected because
  it already missed render metadata and would keep two event snapshots in sync
  manually.
- **Let `dropSystem` process the trapped enemies.** Rejected because this would
  award XP/gold/loot in a safe room and count as player kills.
- **Remove all enemies in the room including `DeathTimer` corpses.** Rejected
  because the staircase boss intentionally unlocks the room on lethal frame while
  the boss entity still exists for death animation.
- **Move boss-room cleanup into core.** Rejected because room roles, Floor 1
  boss encounter state, and objective bookkeeping are game-layer concerns.
