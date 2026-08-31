# HUD refresh (2026-08-28)

## Systems touched

hud, engine-rendering

## Summary

Refreshed Crawler's in-game HUD visual language (health/loot bar, boss bar,
minimap, skill tracker, ability bar, direction arrows, announcement banner,
navigation layout, shared theme/scale helpers) as the UX Designer persona, and
added two tracked A|B lab scenarios (`hud-safe-room`, `hud-dungeon`) with real
deterministic geometric sensors backing their LLM visual review.

Key fixes landed this session:

- Folded the standalone loot counter into `HudHealthBar.ts` as a second
  stacked row (deleted `HudLootCounter.ts`), removing wasted vertical space
  and grouping currency next to the resource it's most related to (health/XP
  UX), per explicit user feedback.
- Removed the redundant "BOSS" label from `HudBossBar.ts`.
- Fixed a vertical text-overflow bug: `LOOT_ROW_H` (14px) was shorter than the
  actual rendered loot value text height (~20.6px for 14px bold + 3px stroke)
  at max-value stress states (e.g. `9.9M`), causing gold/junk text to spill
  outside its reserved value column. Bumped `LOOT_ROW_H` 14→22 and
  `VITALS_ROW_HEIGHTS.health` 52→60 to match.
- Discovered and fixed that both HUD A|B scenario setup scripts
  (`scripts/agent/review/setup/hud-scenarios.js` and
  `hud-scenarios-dungeon.js`) declared every region as flat `kind: 'panel'`
  with no `parentId`, which silently excluded them from ALL deterministic
  geometric sensors (`OVERLAP_EXCLUDED_KINDS` in `visual-review-lib.mjs`
  excludes `panel`/`tooltip`/`icon` from sibling-overlap checks, and
  containment only runs via `parentId`). Rewrote both scenarios to classify
  regions into real `panel`/`text` kinds with correct `parentId` containment
  relationships, activating real overlap/containment sensors for the first
  time.
- Added a deterministic e2e regression test
  (`tests/e2e/hud-overlap-visual.test.ts`, describe block "tracked hud A|B
  scenarios stay non-overlapping (safe-room + dungeon)") that loads both
  `__hudProbe.setScenario('safe-room-unlocked' | 'dungeon')` states and
  asserts every declared `getVisualReviewRegions()` region stays inside the
  viewport, no top-level HUD panels overlap, and loot text stays contained —
  this closes the independent-grade `fail` finding recorded in the review
  ledger (missing deterministic regression coverage for the new scenarios).

## Verification run

- `npm run typecheck` — pass.
- `npm run review:visual:deterministic` — 34/34 tests pass.
- `npx vitest run --project e2e tests/e2e/hud-overlap-visual.test.ts` — 6/6 tests pass (includes 2 new scenario regression tests).
- A|B LLM scenario reviews (lineage v18, both hard gates met):
  - `hud-safe-room`: **80.0/100**, 0 blockers, PASS.
  - `hud-dungeon`: **80.0/100**, 0 blockers, PASS.
- Review ledger: `docs/knowledge/review-ledgers/2026-08-27-hud-refresh.review-ledger.json` — validated via `npm run review:ledger -- validate <path>` as a valid 3-apple ledger (plan_review, code_review, independent_grade all complete; independent-grade `fail` finding remediated by the new e2e coverage above).
- `npm run verify:pr-prereqs` — passes except for handoff presence, resolved by this file.

## Evidence paths

- Lineage captures: `files/visual-review/{before,after}/v18/hud-safe-room.png`, `.../hud-dungeon.png` (+ `.review.json` beside each).
- Tracked release baseline: `docs/knowledge/ux-baselines/releases/nalfeo-hud-refresh-57c/{hud-safe-room,hud-dungeon}/`.
- Review ledger: `docs/knowledge/review-ledgers/2026-08-27-hud-refresh.review-ledger.json`.

## Unresolved issues

None outstanding for this scope. Both hard gates (0 blockers, ≥80/100 both
scenarios) are met and hold after activating real deterministic geometric
sensors.

## Recommended next steps

- Per explicit user instruction, this session does **not** publish a PR. The
  user will handle PR publication after reviewing results from this and the
  other wave-1 sessions (`nalfeo-ux-refresh-hud-inventory-shop` base branch).
- Record the apple entry (`npm run apples:record -- --session hud-refresh --estimated 3 --actual 3`).
