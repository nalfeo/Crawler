# Handoff: Floor 2 shops open via NPC interaction; entrance safe room

## Date

2026-07-30

## Persona

UX Designer implementation with policy-required review ledger.

## Systems touched

hud-ux, inventory, mapgen

## Apples

2 apples estimated, 2 apples actual.

## Summary

- Removed the closed-state Floor 2 Shop button opening path in `MainGameScene`.
- Added settlement shop NPC detection so interacting (`Talk`) with:
  - the Quartermaster NPC, and
  - non-Quartermaster settlement shop NPCs
  opens the same purchase panel.
- Kept quartermaster panel toggle only as an open-state dismiss affordance.
- Updated safe-space classification so Floor 2 spawn-room tiles count as safe context.
- Preserved settlement anchor behavior (`resolveFloor2SettlementAnchor`) by keeping it keyed to persisted settlement room id.
- Added/updated targeted tests for:
  - NPC-interaction-based shop opening,
  - non-Quartermaster shop interaction opening,
  - hidden closed-state shop button expectation,
  - Floor 2 entrance safe-room classification plus settlement-anchor stability.

## Files touched

- `src/engine/scenes/MainGameScene.ts`
- `src/core/safe-space.ts`
- `tests/e2e/main-game-scene-quartermaster.test.ts`
- `tests/unit/floor2-scenario-initialization.test.ts`
- `docs/knowledge/adr/2026-07-30-floor2-shop-interaction-and-entrance-safe-room.md`
- `docs/knowledge/review-ledgers/2026-07-30-floor2-shop-npc-open-entrance-safe.review-ledger.json`

## Validation

- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-30-floor2-shop-npc-open-entrance-safe.review-ledger.json` ✅
- `parallel_validation` ✅ (no review comments; CodeQL run returned 0 alerts, but scan noted database-size skip)
- `npm run verify:fast` ❌ blocked locally: dependency install/network resolution failure (`ENOTFOUND ms-feed-12.pkgs.visualstudio.com`), so TypeScript/ESLint/Vitest commands cannot run in this sandbox session.
- `npm run verify:pr-prereqs` ❌ currently still expected to be rerun after this handoff/ADR addition in the next step.

## Runtime / observe-before-done

- Intended runtime/e2e coverage is encoded in updated Floor 2 main-scene e2e tests, but direct local execution is blocked in this environment by missing dependencies caused by the network failure above.

## Unresolved issues / follow-up

1. Re-run `npm run verify:fast` and targeted e2e/unit tests in an environment where `npm ci` succeeds.
2. Re-run `npm run verify:pr-prereqs` after all branch files are committed.
3. Issue plan-comment requirement could not be posted from this sandbox because repository remotes resolve to localhost and `gh issue comment` cannot authenticate a known GitHub host.
