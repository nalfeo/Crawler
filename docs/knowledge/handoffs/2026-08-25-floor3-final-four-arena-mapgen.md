# Session Handoff: Floor 3 Final Four arena mapgen

## Date

2026-08-25

## Persona

Producer coordinating Systems/Game/QA recovery

## Systems touched

mapgen, quests, ci-policy

## Apples

3🍎 estimated → 3🍎 actual (exact). Full JSON:
`docs/knowledge/metrics/apples/2026-08-25-floor3-final-four-arena-mapgen.json`.

## Problem

PR #3594 generated Floor 3 Studio/Final Four progression but left the terminal
Final Four encounter dependent on territory leftovers or center-tile fallback
placement. Review recovery also found two merge blockers: no branch-local ADR for
the `src/core` + `src/game` contract, and an incomplete 3🍎 review ledger.

## What Was Done

- Added generator-owned Floor 3 Final Four arena geometry: a deterministic 10×10
  `BOSS_STAIR` chamber labeled `floor3_final_four_arena`, with a single door and
  exterior bypass ring to preserve cavern connectivity.
- Updated Floor 3 scenario selection to resolve the Final Four against that
  labeled arena room, keeping territory fallback only for explicit test/map
  overrides that omit generated arena geometry.
- Added/retained unit coverage for arena dimensions, single-door shell,
  deterministic placement, spawn reachability, topology seeds `364`/`412`, and
  scenario state binding to the generated arena.
- Added ADR
  `docs/knowledge/adr/2026-08-25-floor3-arena-generator-owned-chamber.md` for
  the cross-layer mapgen/scenario contract.
- Completed the 3🍎 review ledger with a two-round code-review loop and an
  independent passing grade.
- Applied the player-tile relocation to arena-backed (pre-resolved) Final Four
  pending spawns, so a Companion can no longer materialise on the player when
  the last Studio is defeated while the player stands on an arena spawn point.

## Validation

- `bash scripts/agent/preflight.sh`: passed.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-08-25-floor3-final-four-arena-mapgen.review-ledger.json`:
  passed.
- Independent grade: `gemini-3.1-pro-preview`, pass, 5/5 on all five criteria,
  no findings.
- Set-piece composition gate (issue #3534 lab validation, deterministic):
  `npm run setpiece:score -- --id floor3-final-four-arena` →
  `✅ PASS floor3-final-four-arena (10x10 tiles) 12/12 checks`, including
  `Shell integrity: complete 36-tile wall ring with 1 door(s)` and
  `Circulation: a 1-tile-wide walkable area exists`.
- Real Floor 3 before/after (Rule 9), observed headlessly on the real scenario
  path (`initializeFloor3Scenario` on a generated Floor 3 map, seeds
  `303`/`364`/`412`, run via `npx tsx` against `tests/helpers/world-factory.ts`):
  - **Before** (base `4af7590`): `labeledArenaRooms: 0`; the Final Four bound to
    an unlabeled `territory` room (ids `5`/`1`/`3` per seed).
  - **After** (this branch): `labeledArenaRooms: 1`; the Final Four binds to
    room id `7` with `role: boss_stair`, `label: floor3_final_four_arena` on all
    three seeds.
- Player-overlap before/after (same real scenario path, seed `404`): with the
  player parked on pre-resolved arena tile `106,106`, the pre-fix build spawned
  a Final Four Companion on that exact tile; after the fix every Final Four
  spawn tile is passable, distinct, and off the player's tile. Locked in by
  `tests/unit/floor3-victory-system.test.ts` →
  `relocates a Final Four spawn off the tile the player is standing on at
unlock` (verified failing before the fix, passing after).

## Blockers

None known.
