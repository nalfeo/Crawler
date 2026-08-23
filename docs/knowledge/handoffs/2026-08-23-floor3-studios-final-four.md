# Session Handoff: Floor 3 Slice 8 — Studios + Final Four + objective tick

## Date

2026-08-23

## Persona

Producer → Game Systems Engineer

## Systems touched

enemies, ai-behavior-tree, mapgen, companion-progression

## Apples

4🍎 estimated, 4🍎 actual — full JSON in
`docs/knowledge/metrics/apples/2026-08-23-floor3-studios-final-four.json`.

## What Was Done

Implemented spec slice 8 of `.specify/specs/floor3-companion-league.md` (issue #3419):
seeded selection of 6 Studios + the Final Four (`initializeFloor3Studios`), a new
non-party roster Companion spawner (`spawnRosterCompanion`), and a full rewrite of
`floor3ObjectiveTick` that tracks per-Studio defeat, soft-gates + lazily spawns the
Final Four once all 6 Studios fall, latches victory + pops the exit staircase, and
still handles timeout/party-wipe loss. Wired `scenarioDefinitions.ts`'s `'floor3'`
entry for the full win path (`onStairDescend`, `getStairMarkerState`,
`stairConfirmation`, `isTerminalRunVictory: true`).

Critical discovery mid-session: the `floor3-biomes` map generator
(`tryGenerateFloor3BiomeOverworld` in `cave-system.ts`) never carves a physical
`BOSS_DEN`/`RESOURCE_HEART` room — that belongs to spec slice 9 ("Set-pieces"). Slice 8
was rescoped to the logical/mechanical layer only: Studios spawn into the existing
`TERRITORY` zones, the Final Four "sealed den" gate is a deferred/lazy spawn rather
than a physical door-lock, and the exit stairs pop at the player's spawn point. This is
documented directly in the spec (R6 section) and in code comments, not just here.

Runtime/real-artifact observation (rule #9/#10): ran the real headless AI pipeline
(`npx tsx src/game/ai/headless-runner-cli.ts --floor floor3`, seeds 606/999) for up to
1000 simulated seconds — no crashes, correct ambient wild spawning, clean shutdown on
player death. The win/lose objective-tick logic itself is exercised end-to-end by
`tests/unit/floor3-victory-system.test.ts`, which calls the exact production
`initializeFloor3Scenario`/`floor3ObjectiveTick`/`confirmFloor3StairDescend` functions
(not lab doubles) — before: Floor 3 had no win path at all (`isTerminalRunVictory:
false`, `floor3ObjectiveTick` was timeout-only); after: Studio defeat → Final Four
unlock+spawn → Final Four defeat → victory latch → stair pop → confirmed descend all
verified to actually flip world state end to end.

## Key Decisions Made

- **Deferred-spawn gate instead of door-lock**: because there's no physical den to
  lock, the Final Four's Companions are not created in the ECS world at all until
  `floor3ObjectiveTick` sees `studiosDefeatedCount >= studios.length`. This avoids
  requiring any generator changes in this slice and keeps slice 9 (set-pieces)
  cleanly separable.
- **Arena tile = nearest passable tile to map center** via outward spiral scan
  (`findFloor3ArenaTile`), since there's no `RESOURCE_HEART` room to spawn into yet.
- **Exit stairs pop at `floorMap.playerSpawn`** rather than scanning for
  `BOSS_STAIR_FLOOR` terrain (which floor3 never stamps).
- **Floor 3 is now `isTerminalRunVictory: true`** with no `nextFloorId` (Floor 4
  doesn't exist yet) — mirrors Floor 2's existing terminal-victory shape so neither
  floor's tests needed conflicting changes.
- **Companion HP scaling** reuses `archetype.hp * formForLevel(species,
level).statScale` — no new balance numbers invented; slice 16 owns real tuning.

## What's Next / Blockers

- Slice 9 (Set-pieces: 6 Studio dens + Final Four arena) is the natural follow-up —
  it can now replace the `TERRITORY`-zone/arena-tile placeholders with real physical
  rooms without touching slice 8's objective-tick logic.
- Slice 16 (balance/win-rate gate) will need a real win-rate sweep once Studio/Final
  Four combat is playable; the current headless AI is not tuned against structured
  companion encounters, so a headless run dying is expected at this stage, not a bug.
- Consider whether Trainer/Handler NPC visual entities (R1's "handler entities carry
  Invincible tag") should land in a set-piece/UX slice — deliberately deferred.

## Retrospective

### Lessons Learned

- `enemies.floor3.json` archetype hp/speed/detectRange/aiType/collisionRadius are
  **identical across every affinity for a given fighting style** (e.g.
  `ember-charger` == `bloom-charger` == `stone-charger`). This makes a
  fighting-style-keyed fallback lookup safe and exact-match-equivalent — useful any
  time a species needs base combat stats but isn't itself a wild-pack archetype.
- The `floor3-biomes` map generator layout is a genuinely separate code path
  (`tryGenerateFloor3BiomeOverworld`) from the floor2-families layout in the same
  generator file — reading only the shared preamble of `cave-system.ts` and assuming
  both layouts share the same room-role vocabulary is a trap.

### Mistakes Made

- Initially wrote `spawnFloor3RosterCompanion` to look up an archetype by **exact**
  `speciesId` match only. This silently dropped every Final Four "signature" species
  (`signature-volcanix`/`signature-tempestryn`/`signature-eclipsewyrm`), which have
  `PetSpeciesDef` entries but no wild-pack archetype (they're not ambient wild spawns
  by design). The bug was caught only because a determinism/wipe unit test asserted
  the exact live-companion count on the Final Four's teams — a "does it not crash"
  check would have missed it entirely, since the objective tick's `_isEncounterTeamsWiped`
  guard (all-teams-must-have-≥1-companion) would have just silently never latched
  victory for a Final Four with an all-signature roster. Fixed via
  `findFloor3ArchetypeForSpecies`'s fighting-style fallback. Lesson: when a lookup can
  legitimately return "no data for this id", write a test that asserts the **positive**
  outcome (all N companions exist), not just "no throw."

### Opportunities for Future Improvement

- A dedicated `floor3-victory-system.test.ts`-style test file existed for Floor 2
  (`floor2-victory-system.test.ts`) before this slice; consider adding the equivalent
  pattern reference to `AGENTS.md`/persona docs so new floor scenarios reach for it
  by default instead of relying on tribal knowledge of the precedent file.
