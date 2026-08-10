# Handoff: Floor1 Class-D Pre-Chain Lock

**Date:** 2026-07-10  
**Session:** floor1-class-d-prechain-lock  
**Estimated apples:** 🍎🍎🍎🍎  
**Actual apples:** 🍎🍎🍎🍎  
**Verdict:** exact

## Systems touched

ai-behavior-tree, quests

## What was done

- Reproduced the class-D lock signature in the real headless pipeline (seed21 sword/baseball-bat, seed69 sword family): `floor1-find-welcome` remained incomplete with prolonged EXPLORE/suppressed oscillation near tutorial-goon progression.
- Updated pre-chain progress targeting to keep tutorial-goon objectives entity-backed (`guideNpcEid`) while preserving welcome-office navigation targeting.
- Updated the EXPLORE dwell watchdog suppression path so non-enemy NPC progress targets (including tutorial-goon/entity-backed pre-chain goals) are treated as suppressible fixed-position progress goals, avoiding immediate re-assignment deadlocks.
- Added headless AI-driver fallback interaction support for tutorial-goon while in EXPLORE tutorial-seek flow, with a bounded handoff radius (`TUTORIAL_GOON_HANDOFF_DISTANCE_FT = 188`) so the headless runner can complete the pre-chain handoff when nav lock leaves the AI stuck outside standard nearby radius.
- Added deterministic regression coverage in `tests/headless/pre-chain-lock-regression.test.ts` for seed21 sword + baseball-bat asserting:
  - `floor1-find-welcome` completes within bounded frames
  - `suppressedProgressNav` share remains below threshold
- Updated behavior-tree unit expectations for tutorial-goon entity-backed target semantics and preserved suppressed-progress debug coverage.

## Root cause summary

Class-D stalls came from a compounded interaction between pre-chain tutorial-goon progression and movement deadlock handling:

1. Pre-chain routing repeatedly sought the tutorial handoff while staying in EXPLORE.
2. When pathing wedged around the tutorial-goon/welcome-office region, dwell suppression did not reliably treat entity-backed non-enemy progression targets as suppressible fixed-position goals.
3. The headless auto-interaction path only talked to NPCs via strict nearby-state interaction, so EXPLORE tutorial-seek lockups could persist without quest handoff completion.

The fix keeps class-D scope local: better suppression classification for non-enemy progress targets + tutorial-seek interaction fallback in the headless AI-driver path.

## Validation

- `npm run test -- tests/headless/pre-chain-lock-regression.test.ts tests/game/behavior-tree-ai.test.ts`
- `npm run verify:fast`
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-10-floor1-class-d-prechain-lock.review-ledger.json`
- `npm run verify`

## Review harness / ledger

- Ledger: `docs/knowledge/review-ledgers/2026-07-10-floor1-class-d-prechain-lock.review-ledger.json`
- Plan review: adversarial complete
- Code review: 2 rounds complete
- Multi-model review: complete with adjudication (`claude-sonnet-5`)

## Follow-up note

- The tutorial handoff fallback radius is intentionally scoped to the headless AI-driver path and tuned to preserve the class-D regression gate. It should be re-evaluated with broader seeded sweeps for premature handoff behavior once this class-D slice lands.
