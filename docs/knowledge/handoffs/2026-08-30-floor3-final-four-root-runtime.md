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
- After: the migrated unit suite passed 23/23 and asserts four ordered wipes,
  shared team identity, no premature victory, explicit real selection, and
  stale, wrong-team, and knocked-out selection rejection.
- Real shared runtime contract: the focused objective test drives the production
  `initializeFloor3Scenario` / `floor3ObjectiveTick` / stair-confirmation path.
- Headless artifact: `tests/headless/floor3-poach-loadout.test.ts` passed 2/2
  through `runHeadless`; seed 3539 observed the exact four selected handler ids
  in order, ended at round index 4, selected a kept Companion, descended, and
  reported victory.
- Focused runtime regression set: 25/25 passed across Floor 3 victory and
  headless completion.
- `npm run verify:fast`: 147 files and 2,397 tests passed; all integrity checks
  were non-blocking/green.

## UX seam

Runtime exposes `finalFourRounds` plus `finalFourRoundIndex` for bracket/versus
presentation, and the existing `selectKeptCompanion` scenario hook is now a
mandatory pre-exit choice. No engine, UI, or lab files changed.

## Review-recovery round (PR #3937)

Seven Copilot review threads, two CI failures, and the review ledger were
recovered in a single consolidated round.

- Keep-companion picker now reopens whenever the stored `keptCompanionEid` is
  absent from the current valid choices, not only when it is unset — a pick that
  went stale between victory and the stairs previously stranded the run.
- `confirmFloor3StairDescend` and `getFloor3StairMarkerState` now share
  `floor3KeptCompanionDescendGateSatisfied()`, so the marker can never advertise
  an exit the confirmation refuses, and a post-victory party wipe (which is
  deliberately not a loss) can still descend.
- The headless runner attempts the Floor 3 descend unconditionally under the
  `autoSelectKeptCompanion` capability seam; gating it on that call's return
  value stalled wiped-party wins. Its lack of a stair-proximity gate is a
  documented headless-only deviation (the BT AI has no Floor 3 exit navigation
  and `getFloor3RunOutcome` only clears after descend); a proximity-gated
  `autoFloor3ProgressionSystem` is the follow-up.
- Floor 3 minimap markers are drawn outside the quest-waypoint loop and the
  docked radar refreshes its own projection, so markers no longer require an
  active waypoint or a prior full-map open.
- The league panel moved to `Y = 58` so it clears Floor 3's floor timer
  (12–54), and Studio affinity is resolved through `STUDIO_AFFINITY_BY_ID`
  rather than the independently shuffled array index.

### Evidence

- Observe-before-done: new `tests/e2e/floor3-league-hud.deterministic.test.ts`
  boots the real `main-scene-probe-lab?floor=floor3` scene, resolves intro and
  starter, and asserts the mounted league panel does not overlap the timer panel
  and that the docked radar (`mapOverlayOpen === false`) projects `studio` and
  `final-four-gate` markers. It failed against the pre-fix layout/marker paths.
- `tests/e2e/main-game-scene-floor3-party-ux.test.ts` (the failing E2E Visual
  job) passes again now that it acknowledges the studio versus card.
- New unit regressions: `tests/unit/floor3-league-view.test.ts` (affinity by id
  across three seeds), wiped-party descend plus marker/confirmation agreement in
  `tests/unit/floor3-victory-system.test.ts`, and headless descend sequencing in
  `tests/unit/floor3-ux-wiring.test.ts`.
- `npm run verify:fast` green; `npm run format:check` clean (the Lightweight
  Checks failure); ledger validates as a 5-apple ledger.
