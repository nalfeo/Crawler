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

Fixed the Floor 1 Spell Broker dialogue so it suppresses the tail-reference line until the merchant errand quest is active. The selector now treats `merchantQuestStarted` as the gating condition, while locked and spellbook-claimed states still take priority. `resolveDialogueLines()` now checks `world.questLog` for `floor1-shopkeeper-errand` before allowing the default dialogue to surface.

## Validation

- `npx vitest run tests/unit/spell-broker-dialogue.test.ts tests/unit/main-game-scene-helpers.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Notes

This keeps the Broker's line from appearing before the player has received the merchant's errand, and restores it once the quest is active as part of the default dialogue path.
