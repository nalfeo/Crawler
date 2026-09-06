---
date: 2026-09-06
persona: Content Designer
systems: quests
apples: 2🍎
---

## Systems touched

quests

## Summary

Rewrote the Sweaty Merchant's initial rat-tail request so the room reference
reads as clear but coy sexual innuendo: "It's not for the shop—it's for the
room, and the room has been lonely." The Floor 1 quest summary uses the same
wording, with quest IDs, objectives, and progression unchanged.

## Validation

- `npm run test:unit -- tests/unit/main-game-scene-helpers.test.ts --run`
- `npm run test:e2e -- tests/e2e/floor1-merchant-modal.test.ts --run`
- `npm run typecheck:src`
- `npm run verify:fast`

## Runtime observation

The real MainGameScene merchant interaction was exercised through the
main-scene-probe lab. The initial dialogue displays three lines, includes the
revised coy line, and excludes the former "It's for the shop. It's for the
room." wording.
