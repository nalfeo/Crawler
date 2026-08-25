# Session Handoff: Floor 1 boss-stall watchdog recovery

## Date

2026-08-25

## Persona

Game AI Engineer

## Systems touched

ai-behavior-tree, floor1-progression

## Apples

3🍎 estimated, 3🍎 actual (🎯 exact) — seeded headless regression, production AI
watchdog change, regression coverage, and review ledger required.

## Issue

Closes nalfeo/Crawler#3523 ("bug: Floor 1 release sweep loss at
2469f4294aad").

## What Was Done

- Reproduced the reported Floor 1 release-sweep signature in the real headless
  runner: `floor=floor1|forceWeapon=true|damage=1|seed=31|weapon=baseball-bat`
  timed out at 39,600 frames while repeatedly trying to return to the Spell
  Broker after the Slime Rat fight.
- Root cause: the quest-progress watchdog exempted any active boss quest as long
  as a nearby enemy existed. In this seed, an unreachable/local add near the
  Slime Rat room kept that exemption alive even though quest progress and nearby
  enemy HP were both stalled, so relocation never fired.
- Changed the boss-quest exemption to reset the quest-progress stall timer only
  when nearby enemy HP is actually decreasing. A live boss fight can still
  continue while damage is being dealt, but a parked no-damage add now trips the
  existing relocation path.
- Added `baseball-bat` seed `31` to the deterministic Floor 1 release loss
  regression suite.

## Verification

- Before: `npx tsx src/game/ai/headless-runner-cli.ts --floor floor1 --seed 31
--weapon baseball-bat --enemy-damage-multiplier 1 --max-frames 39600
--event-log /tmp/floor1-bat31-before.jsonl --event-summary
/tmp/floor1-bat31-before-summary.json --progress 6000` → timeout at 39,600
  frames; `floor1-boss-battle` and `floor1-leave-floor` incomplete.
- After: same real headless command → victory at 33,615 frames / 560.3s raw
  game time; all Floor 1 required quests complete.
- `npx vitest run --project headless
tests/headless/floor1-release-sweep-loss-regressions.test.ts --testNamePattern
"baseball-bat seed 31"` — passed.
- `npx vitest run --project headless
tests/headless/floor1-release-sweep-loss-regressions.test.ts` — passed, 6/6
  release-loss regression seeds.
- `npm run ai:winrate-sweep -- --floor floor1 --seeds 31 --weapons baseball-bat
--workers 1 --out /tmp/floor1-bat31-after-sweep.json` — 1/1 win, 100%.
- `npm run ai:winrate-sweep -- --floor floor1 --seeds 31 --weapons baseball-bat
--chain --workers 1 --out /tmp/floor1-bat31-chain-after.json` — 1/1 win,
  100%. Local one-run smoke only; no GitHub sweep run id was created.
- Original broad release sweep viewer reference:
  `project:sweep-results-viewer runId=32787161346`.

## Notes

- The original GitHub Actions run completed successfully; the loss was captured
  as release-sweep data, not as a failed Actions job.
- The broad 300-run release sweep should stay on GitHub infrastructure per repo
  policy.
