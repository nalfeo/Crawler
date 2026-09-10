# Session Handoff: Open All Filter-Independent Queue

## Date

2026-09-06

## Persona

Producer

## Systems touched

hud-ux

## Apples

2🍎 estimated, 2🍎 actual — exact: the review repass required a focused
filter-scope correction and deterministic integration coverage.

## What Was Done

Addressed the review finding for issue #4278. The Open All queue and readiness
count now scan every unlocked, unclaimed loot-box achievement in stable catalog
order rather than applying the currently selected awards filter. The action is
also rendered when the active filter has no visible rows, so pending boxes
cannot be hidden by the panel filter.

The real `AchievementsUI` + `RewardOpeningUI` integration test now selects an
empty floor filter while two Floor 1 boxes remain pending, then verifies both
boxes are claimed and the aggregate summary closes cleanly after one
acknowledgement.

## Evidence

Focused integration test and typecheck pass. `scripts/agent/verify-fast.sh`
passes.
