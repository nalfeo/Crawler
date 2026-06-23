# Handoff: Fix pick loadout modal missing sword/bow/baseball-bat

**Date:** 2026-06-22
**Persona:** Engineer

## What Was Done

Fixed the pick loadout modal not showing sword, bow, and baseball-bat as starter choices.

## Root Cause

The 2026-06-21 weapons-sprites session updated `floor1LoadoutScenario.ts` and tests to use `sword/bow/baseball-bat`, but did not update `src/shared/data/floors/floor1.manifest.json`. That file still had the old `starterWeapons: ["sword","knife","bow","pistol","throwing-knife"]`.

`pickStarterChoices()` in `floor1Scenario.ts` pulls from `floor1Config.starterWeapons` (derived from the manifest), so the loadout modal was showing a random 3 from the old pool instead of the intended 3.

## Fix

- `src/shared/data/floors/floor1.manifest.json`: changed `starterWeapons` to `["sword","bow","baseball-bat"]`
- `tests/unit/floor1-config.test.ts`: updated assertions to match the new 3-item pool

## Apple Score

🍎 1 (trivial data fix)
