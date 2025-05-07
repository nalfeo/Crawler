# Session Handoff: Preserve Player State Across Floor Transition

## Date

2026-07-17

## Persona

Producer → QA Engineer

## Systems touched

boss-rooms, inventory, quests, weapons, ci-policy

## Apples

4🍎 estimated, 4🍎 actual (🎯 exact — cross-layer scene lifecycle and progression transfer required the expected ADR, runtime proof, and multi-model review)

## What Was Done

- Replaced the Floor 1 full-page Floor 2 navigation with an in-process
  `MainGameScene` restart that builds a fresh Floor 2 ECS world.
- Added a value-only player carryover contract for identity, level/XP, core and
  base stats, health, score, gold, inventory, equipment, skills, abilities,
  feature unlocks, achievements, and correctly rebased cooldown/timed-modifier
  durations.
- Kept direct Floor 2 starts on their existing level-5 starter baseline while
  carryover starts skip starter mutations and restore the completed build.
- Preserved host-composed scene behavior through an explicit floor-transition
  recomposition hook, including AI Runner input, post-systems, and recording.
- Added deterministic capture/restore and chained Floor 1→Floor 2 regressions
  that pin the preserved build and the tracked settlement-to-Broker starter
  objective.
- Observed in `npm run dev` — before: completion navigated to a new page, replayed
  the intro, and reset a seeded level-7 build to Floor 2 defaults; after: the
  production completion callback restarted directly into Floor 2 with level 7,
  four unspent points, custom core stats, 99 gold, inventory and both equipped
  items intact, while `floor2-find-settlement` was active/tracked and the Broker
  entity was present.

## Key Decisions Made

- ADR 0064 selects a fresh-world in-process restart over in-place world mutation,
  browser storage, a global singleton, or URL-encoded player state.
- The snapshot excludes Floor 1 entities, quests, goal flags, temporary floor
  state, and floor modifiers; Floor 2 initializes those from its own scenario.
- Frame-based cooldowns and expiring ability modifiers cross the boundary as
  elapsed/remaining durations rather than stale absolute frame numbers.
- Holder-scoped skill and ability modifiers are parsed by their canonical source
  ID format, filtered to the player, and remapped to the new player entity ID.

## What's Next / Blockers

No implementation blocker remains. CI should run the full gameplay and PR gates;
the PR must remain unmerged and without auto-merge until explicitly authorized.

## Retrospective

### Lessons Learned

Phaser restart is queued rather than immediate, so replacement options must be
passed as restart data and installed during `init()`; mutating options in the
completion callback can create a one-frame mixed-floor pipeline. ECS value
snapshots also need to preserve mutable aliasing contracts, not only values.

### Mistakes Made

The first implementation copied absolute frame timestamps and restored the two
skill maps with separate `SkillState` objects. It also used loose entity-ID
matching for modifier source strings. Independent reviewers supplied concrete
failure scenarios early enough to replace all three with deterministic,
format-aware behavior and regression tests before commit.

### Opportunities for Future Improvement

Promote the production browser transition probe into a maintained deterministic
Phaser E2E test if floor-to-floor transitions expand beyond Floor 2. A shared
typed owner field on `StatModifier` would eventually remove the need to parse
canonical source IDs when moving entity-scoped progression state.
