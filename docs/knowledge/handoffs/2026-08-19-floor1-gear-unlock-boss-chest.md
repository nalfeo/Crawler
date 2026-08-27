# Session Handoff: Floor 1 gear unlock boss-chest regression

## Date

2026-08-19

## Persona

Game Designer

## Systems touched

quests

## Apples

2🍎 estimated, 2🍎 actual (exact).

## Problem

On Floor 1, looting boss chest gear could unlock the Gear panel before merchant-charm progression, because `questSystem` latched `featureUnlocks.equipment` from any equippable item.

## What Was Done

- Added a Floor-1-specific gate in `latchFeatureUnlocks(...)` so equipment unlock remains blocked during the active shopkeeper errand unless the player has acquired/equipped the merchant charm.
- Kept non-Floor-1 behavior unchanged (generic equippable items still satisfy the unlock condition).
- Added targeted regression tests covering:
  - non-merchant equippable loot does **not** unlock Floor 1 Gear early;
  - merchant charm acquisition still unlocks Gear.

## Verification

- `npm test -- tests/ecs/quest-system.test.ts`
- `npm test -- tests/ecs/quest-system-coverage.test.ts`
- `bash scripts/agent/verify-fast.sh`
- `npm run verify:pr-prereqs` (initially failed due missing handoff; this file resolves that prerequisite)

## Unresolved Issues / Blockers

- Could not post the requested issue plan comment via `gh issue comment` due API permission limits (`HTTP 403` with available session token).
