# Floor 1 merchant review recovery

**Date:** 2026-07-13  
**Persona:** Producer  
**Apples:** Estimated 🍎🍎 · Actual 🍎🍎

## Systems touched

quests, weapons, ai-behavior-tree

## Summary

- Fixed `getShopkeeperPostQuestStock()` so the post-quest merchant excludes the
  player’s selected starter weapon instead of excluding the whole visible starter
  list and accidentally falling back into duplicate starter offers.
- Tightened the Floor 1 merchant regression to pin the reported
  `sword` / `bow` / `baseball-bat` loadout and assert the merchant offers only
  the other two canonical items.
- Replaced the prior handoff’s helper-probe note with real headless-pipeline
  before/after evidence and corrected the named off-list candidate item IDs to
  the actual emitted IDs (`fireball`, `throwing-knife`, `plasma-pistol` pool).
- Added this session’s required 2-apple review ledger artifact so
  `verify:pr-prereqs` can validate the recovery work as its own implementation
  session.

## Files touched

- `src/game/floorScenario.ts`
- `tests/game/floor1-scenario.test.ts`
- `docs/knowledge/handoffs/2026-07-11-floor1-merchant-starter-stock.md`
- `docs/knowledge/review-ledgers/2026-07-13-floor1-merchant-review-recovery.review-ledger.json`

## Verification run

- `npx vitest run tests/game/floor1-scenario.test.ts -t "offers the other 2 canonical starter-weapon options after the Floor 1 quest completes"` ✅
- `npx tsx /tmp/observe_merchant_headless.ts 22 sword` on repaired branch ✅
- `npx tsx /tmp/crawler-merchant-before/observe_merchant_headless.ts 22 sword` on commit `5908ca8` ✅
- `npm run review:ledger -- init --apples 2 --slug floor1-merchant-review-recovery --title "fix: recover floor1 merchant review blockers"` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-13-floor1-merchant-review-recovery.review-ledger.json` ✅
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅ (repo note: final PR title still needs a conventional-commit title)

## Unresolved issues

- The PR-level `commit-lint` blocker is the PR title itself (`Restrict Floor 1 merchant stock to canonical loadout weapons`), which is not a conventional-commit title. The available in-session tools can repair code, docs, threads, and commits, but not mutate the PR title directly.

## Recommended next steps

- Update the PR title to a conventional-commit form, e.g.
  `fix: restrict floor1 merchant stock to canonical loadout weapons`.
- After this repair commit lands, rerun / allow CI recovery to rerun, then post
  `✅ Addressed in <sha>: ...` replies on the three validated review threads.
