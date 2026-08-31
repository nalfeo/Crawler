# Session Handoff: Floor 5 field-Hero roster

## Date

2026-08-30

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, ai-pathfinding, enemies, boss-abilities, quests, devtools

## Apples

4🍎 estimated, 4🍎 actual (exact; multi-layer slice touching a core ECS marker,
Floor 5 scenario authority, shared roster data/types, the manifest schema, lab
readout, headless + unit evidence, and an ADR)

## What Was Done

Implemented Floor 5 Slice 4 for issue #3914 — the enemy Hero roster, the
role-scoped strategic AI, and the defeat/respawn contract.

- Added `src/shared/floor5-heroes.ts`: the append-only eight-entry
  `FLOOR5_FIELD_HERO_ROSTER` from design-bible §9, plus
  `buildFloor5FieldHeroCard`, which shuffles the whole roster without
  replacement once from the manifest-reserved `heroes` RNG stream.
- Added the closed `Floor5FieldHeroRole` union and typed Hero slot state to
  `src/shared/floor-types.ts`. `heroState` survives as a derived display string
  so the existing phase-trace contract is untouched; the authoritative state is
  the new typed `heroes` block on `Floor5SiegeState`/`Floor5SiegeRunStats`.
- Added the `SiegeHero` ECS marker and store (`src/core/components.ts`,
  `src/core/world.ts`), mirroring `SiegeMinion`/`SiegeStructure`.
- Added manifest-authored Hero cadence (`heroes.activeSlots: 1`,
  `firstSpawnFrame: 600`, `respawnDelayFrames: 180`) to
  `floor5.manifest.json` with a strict zod schema in `floor-manifest.ts`.
- Added `siegeHeroSystem` to `src/game/floor5Scenario.ts` and wired it into the
  real Floor 5 `beforeEnemyAISystems` slot in `scenarioDefinitions.ts`. It owns
  slot occupancy, fixed-tick spawn/respawn, role-scoped target selection, and
  role-scoped stance. Movement reuses the shared tile pathfinder via the newly
  extracted `stepFloor5Movement`; damage reuses `applyDamage`.
- Extended `floor5ObjectiveTick` with post-damage Hero attacks and defeat
  resolution, so the recorded defeat frame is the frame of the killing blow.
- Added `src/game/floor5HeroAbilities.ts`: one telegraphed ability per role,
  registered through the existing `src/core/mob-abilities` runtime. Floor 5 is
  the first production floor to enable that runtime.
- Extended the Floor 5 siege lab readout with the Hero card, slot status,
  cursor, active identity/role, HP, spawn/defeat/respawn frames, and totals.
- Added ADR `docs/knowledge/adr/0096-floor5-field-hero-roster.md`.

Real-artifact observation, seed 505, real headless pipeline:

- **Before:** `heroState = "PENDING"`, two enemy-team entities (both
  structures), no Hero entity anywhere in the world.
- **After:** the Hero card is drawn from `505:floor5:heroes`, the slot opens on
  the authored frame, exactly one `SiegeHero` on `TeamId.SIEGE_ENEMY` is live,
  it holds inside its role's leash, and it casts its role ability.

## Verification

- `bash scripts/agent/preflight.sh` — passed.
- `npm run typecheck` — passed.
- `npm run lint` — passed (`--max-warnings 0`).
- `npx vitest run tests/headless/floor5-hero-roster.test.ts tests/unit/floor5-heroes.test.ts` — passed, 16 tests.
- `npx vitest run tests/headless/floor5-lane-war.test.ts tests/headless/floor5-siege-foundation.test.ts tests/unit/floor-registry.test.ts tests/unit/scenario-definitions.test.ts tests/unit/floor5-siege-map.test.ts` — passed, 63 tests, with no assertion edited.
- `npm run check:wired-systems` — 59 systems checked, all wired; 0 blocking.
- `bash scripts/agent/verify-fast.sh` — passed.

## Key Decisions Made

- **The without-replacement draw does not cycle.** The whole roster is shuffled
  into a frozen card once at floor init; each defeat advances a cursor; when the
  eighth Hero falls the slot is `retired` forever. This is the spec's "remain
  defeated according to their slot" branch.
- **Committing the card up front makes the RNG-free respawn guarantee
  structural**, not incidental: a respawn cannot consume a draw because the next
  Hero was decided before the first spawn.
- **One role for life.** Role fixes a single anchor rule, the engage/aggro/leash
  radii, and one telegraphed ability. There is no cross-role fallback ladder.
- **Heroes engage minions only; structures are anchors, never Hero damage
  targets.** Letting a Hero demolish structures was measured to destroy an allied
  structure and latch `buildSiteUnderAttack`, silently rewriting Slice-2 and
  Slice-3 contracts this slice does not own.
- **The Hero is a last-resort minion target.** Putting it ahead of the lane
  objective was measured to stall the Slice-2 push entirely; a 165-HP defender
  soaks every allied minion indefinitely. Heroes are worn down by the player.
- **`firstSpawnFrame: 600`** — the castle commits a named defender only after the
  opening wave cycle resolves, rather than 1.5 seconds into the siege.

## What's Next / Blockers

- No implementation blocker remains for Slice 4.
- Player-facing auto-targeting of siege actors (Heroes included) is still
  deferred: like Slice-2 structures, Heroes are deliberately not tagged `Enemy`.
- Hero HP/damage/radii and the spawn cadence are an AI Engineer baseline under
  `HUMAN_GATE-3`/`HUMAN_GATE-4`. Any rebalance is the Game Designer's call, and
  should be driven by a sweep rather than by a single seed.
- The `FR7` courtyard handoff is untouched and unblocked.
- Slice 5/6 concerns (Ram escort mechanics, Crown Auditor, Regent Emeritus)
  remain out of scope.

## Retrospective

### Lessons Learned

Reproducing on seed 505 _before_ writing code paid for itself three times over.
Every one of the three regressions below was caught by re-running the same seed
through the real pipeline, and each one was a genuine design error in my change
rather than a stale assertion — the existing tests were right every time.

### Mistakes Made

The first draft made the Hero a top-priority target for allied minions, which
stalled the lane war; the second let Heroes attack structures, which destroyed an
allied structure inside the Slice-2 window; the third spawned the Hero at frame 90,
which killed an allied minion inside that same window. All three were fixed in
the decision kernel. No existing assertion was weakened.

### Opportunities for Future Improvement

Role behavior is currently anchor + radii + ability. If later slices want
genuinely distinct strategic silhouettes, the anchor rule is the right seam to
grow — it is already the single role-scoped decision point.
