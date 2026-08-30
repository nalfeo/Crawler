# Floor 3 Final Four ordered runtime

## Date

2026-08-30

## Persona

Game Designer

## Systems touched

enemies, ai-behavior-tree, inventory, quests

## Apples

4🍎 actual / 4🍎 estimated — exact. The slice crossed portable scenario state,
real objective progression, headless completion, carryover gating, and focused
runtime tests.

## What changed

- Replaced the flattened simultaneous Final Four spawn with four ordered handler
  rounds in the exact order returned by `selectFloor3FinalFour`.
- Kept one Final Four team id while allowing only one handler roster to exist in
  the ECS at a time.
- Advanced the active round on roster wipe and latched victory/stairs only after
  wipe four.
- Removed automatic real-play kept-companion selection. Stair descent now
  requires a currently valid selected player-party Companion.
- Added an explicit deterministic game-layer auto-selection path used by the
  real headless runner, which selects before confirming descent and carryover.
- Recorded the cross-system authority decision in ADR
  `2026-08-30-floor3-final-four-ordered-round-authority.md`.

## Pillar and target

**Dungeon Crawler Carl / spectacle frame:** the championship board is four
distinct televised eliminations rather than one undifferentiated mob.

Target: every seed completes exactly four Final Four handler rosters in seeded
order, victory remains false through wipes 1–3, wipe 4 alone unlocks victory,
and exit remains blocked until one valid Companion is kept.

## Evidence

- Baseline: `tests/unit/floor3-victory-system.test.ts` passed 21/21 while
  explicitly asserting one simultaneous Final Four roster and victory after its
  first wipe; victory also auto-selected the first party Companion.
- After: the migrated unit suite passed 22/22 and asserts four ordered wipes,
  shared team identity, no premature victory, explicit real selection, and
  stale-selection rejection.
- Real shared runtime contract: the focused objective test drives the production
  `initializeFloor3Scenario` / `floor3ObjectiveTick` / stair-confirmation path.
- Headless artifact: `tests/headless/floor3-poach-loadout.test.ts` passed 2/2
  through `runHeadless`; seed 3539 observed the exact four selected handler ids
  in order, ended at round index 4, selected a kept Companion, descended, and
  reported victory.
- Focused regression set: 111/111 passed across Floor 3 victory, scenario
  definitions, and player carryover.
- `npm run verify:fast`: 147 files and 2,397 tests passed; all integrity checks
  were non-blocking/green.

## UX seam

Runtime exposes `finalFourRounds` plus `finalFourRoundIndex` for bracket/versus
presentation, and the existing `selectKeptCompanion` scenario hook is now a
mandatory pre-exit choice. No engine, UI, or lab files changed.
