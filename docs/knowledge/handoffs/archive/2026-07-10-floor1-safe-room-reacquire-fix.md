# Handoff — Floor 1 safe-room objective reacquisition fix

**Date:** 2026-07-10  
**Branch:** `nalfeo-fix-floor1-safe-room-ai-stagnation`  
**Session slug:** floor1-safe-room-reacquire-fix

## Systems touched

ai-behavior-tree, quests

## Apple estimate

- Declared: **4 apples**
- Actual: **4 apples**
- Verdict: **on-target**
- Metric file: `docs/knowledge/metrics/apples/2026-07-10-floor1-safe-room-reacquire-fix.json`

## Summary

Fixed a deterministic Floor 1 stall class where seed `1` with non-baseline starters (`pistol`, `throwing-knife`, `fireball`) accepted `floor1-tutorial` then stayed in EXPLORE with no progression (XP/gold stuck at 0) and timed out.

Root cause was a safe-room escape/reacquisition gap during tutorial pre-level-2 flow: `LeaveSafeRoom` and `Hunt` depended on the normal 50ft scan radius, so distant-but-reachable threats could fail reacquisition and drop the AI back to wander.

Implemented a narrow behavior-tree fix in `src/game/ai/bt-ai-provider.ts`:

1. `buildLeaveSafeRoomBehavior`: when tutorial is accepted and player level is still `<2`, enemy acquisition uses unbounded scan radius to guarantee an egress target while inside safe room.
2. `buildHuntBehavior`: same tutorial pre-level-2 phase now uses matching unbounded scan radius so post-egress pursuit does not fall back to EXPLORE until threats re-enter 50ft.

Added deterministic regression coverage:

1. `tests/game/behavior-tree-ai.test.ts`: new seam test proving safe-room egress remains locked to the far threat across the first post-exit frame (no immediate EXPLORE drop).
2. `tests/headless/floor1-safe-room-reacquire.test.ts`: new headless canary for seed `1` on `pistol`, `throwing-knife`, and `fireball`, asserting no `floor1-tutorial` stall and real progression (tutorial completion + XP/level gain).

During required full verification, this AI behavior change deterministically drifted `tests/headless/collision-pair-parity.test.ts` golden fingerprints for seeds 13/42. Per project policy (fix all failures), I re-baselined those pinned values with an explicit handoff comment block documenting the intentional cause and before/after values.

## Files touched

- `src/game/ai/bt-ai-provider.ts`
- `tests/game/behavior-tree-ai.test.ts`
- `tests/headless/floor1-safe-room-reacquire.test.ts`
- `tests/headless/collision-pair-parity.test.ts`
- `docs/knowledge/review-ledgers/2026-07-10-floor1-safe-room-reacquire-fix.review-ledger.json`
- `docs/knowledge/metrics/apples/2026-07-10-floor1-safe-room-reacquire-fix.json`

## Review harness / ledger

- Ledger: `docs/knowledge/review-ledgers/2026-07-10-floor1-safe-room-reacquire-fix.review-ledger.json`
- Tier: 4 apples (required stages: adversarial plan review, code-review loop, multi-model review + adjudication)
- Validation: `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-10-floor1-safe-room-reacquire-fix.review-ledger.json` ✅

## Verification run

- Repro before fix:
  - `npm run ai:headless -- --seed 1 --weapon pistol --floor floor1 --json` → stalled on `floor1-tutorial`
  - Cross-check: same stall signature on `throwing-knife` and `fireball`
- Targeted regressions:
  - `npx vitest run tests/game/behavior-tree-ai.test.ts -t "keeps hunting after forced safe-room egress until far threats re-enter normal scan"` ✅
  - `npx vitest run tests/headless/floor1-safe-room-reacquire.test.ts` ✅
- Post-fix behavior confirmation:
  - `npm run ai:headless -- --seed 1 --weapon pistol --floor floor1 --json` → victory, tutorial completes, XP > 0
  - `npm run ai:headless -- --seed 1 --weapon throwing-knife --floor floor1 --json` → victory
  - `npm run ai:headless -- --seed 1 --weapon fireball --floor floor1 --json` → victory
- Project gates:
  - `npm run verify:fast` ✅
  - `npx vitest run tests/headless/collision-pair-parity.test.ts` ✅ (after deterministic golden re-baseline)
  - `npm run verify` ✅ (after adding this handoff and formatting)

## Unresolved issues

- The secondary headless `totalKills`/combat-time accounting concern from investigation was not changed here; this fix stayed scoped to safe-room/progression reacquisition.
- Post-merge triage update (investigation follow-up) indicates a **distinct pre-chain lock class** still reproduces on seeds 21/69 (`sword`, `baseball-bat`; bow often dies before progression), where `floor1-find-welcome` never completes and `suppressedProgressNav` dominates. On this branch, this remains reproducible and is **not** the same tutorial-accepted safe-room class fixed here.
- Follow-up triage showed `seed=10,sword` now reproduces as **victory** on this branch (leave-floor completes), so the previously reported late-run exit timeout did not reproduce under current headless settings.

## Recommended next steps

1. If desired, run a GH-backed broader seed sweep focused on non-baseline starters to confirm no additional stall pockets beyond the fixed seed-1 class.
2. Open a dedicated implementation session for the seed21 pre-chain progression lock (`floor1-find-welcome` incomplete + heavy `suppressedProgressNav`) so it can be fixed and regressed separately from this landed class-A safe-room/tutorial fix.
3. Optionally open a follow-up for headless telemetry kill/combat accounting cleanup if that metric precision is needed for analytics consumers.
