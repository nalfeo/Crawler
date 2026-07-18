# 2026-07-18 — E1 scoped + run-global achievements

## Systems touched

quests, floor2, inventory, hud-ux

## Summary

- Generalized achievement contracts with explicit `scope` (`floor`/`current_run`) and floor-aware catalog lookup.
- Added deterministic run-global achievement fact state on world runtime state and threaded it through floor carryover snapshot/restore.
- Extended fact/evaluation seams for Floor 2 without introducing new Floor 2 achievement content.
- Preserved Floor 1 unlock behavior and deterministic evaluation ordering.

## Files touched

- `src/shared/achievements.ts`
- `src/core/world.ts`
- `src/game/systems/achievementSystem.ts`
- `src/game/playerCarryover.ts`
- `src/game/floorScenario.ts`
- `src/game/floor2Scenario.ts`
- `.github/extensions/achievements/lib/achievements-data.mjs`
- `tests/unit/achievements.test.ts`
- `tests/game/achievement-system.test.ts`
- `tests/unit/player-carryover.test.ts`
- `tests/unit/floor2-victory-system.test.ts`
- `tests/unit/devtools/achievements-canvas-adapter-parity.test.ts` (validated by suite run; no source edit)
- `docs/knowledge/adr/2026-07-18-scoped-run-global-achievement-facts.md`
- `docs/knowledge/review-ledgers/2026-07-18-e1-scoped-run-global-achievements.review-ledger.json`

## Verification

- `npm test -- tests/unit/achievements.test.ts tests/game/achievement-system.test.ts tests/unit/player-carryover.test.ts tests/unit/floor2-victory-system.test.ts tests/unit/devtools/achievements-canvas-adapter-parity.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-18-e1-scoped-run-global-achievements.review-ledger.json` ✅
- `npm run verify:pr-prereqs` (post-artifact) ✅ pending final rerun

## Unresolved issues

- Could not post the required issue plan comment from this environment: `gh issue comment` and GitHub REST issue-comment calls both returned `403 Forbidden` with available credentials. The exact plan text is preserved in session logs and should be posted manually if repository policy requires a visible issue-thread artifact.

## Recommended next steps

- Re-run `npm run verify:pr-prereqs` after final artifact commit.
- Post the same high-level summary in the PR description when opening the PR (per issue requirement).
