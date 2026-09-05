---
# Session Handoff: Spell Broker tail-reference quest gate

date: 2026-09-04
persona: Producer
systems: quests
apples: 1🍎
---

## Systems touched

quests

## Summary

Fixed the Floor 1 Spell Broker dialogue so it suppresses only the tail-reference line until the merchant errand quest is active. The selector now retains the two safe authored intro lines while locked and spellbook-claimed states still take priority. `resolveDialogueLines()` checks `world.questLog` for `floor1-shopkeeper-errand` before allowing the tail line to surface.

## Validation

- `npx vitest run tests/unit/spell-broker-dialogue.test.ts tests/unit/main-game-scene-helpers.test.ts`
- `npx vitest run tests/e2e/floor1-merchant-modal.test.ts` — deterministic Chromium observation through the real `MainGameScene`: before the fix the empty pre-merchant dialogue prevented interaction and boss-quest acceptance; after the fix, the two safe lines render (without “tail”) and `floor1-boss-battle` enters the live quest log.
- `bash scripts/agent/verify-fast.sh`

## Notes

This keeps the Broker's line from appearing before the player has received the merchant's errand, and restores it once the quest is active as part of the default dialogue path.
