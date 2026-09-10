---
date: 2026-09-05
persona: Producer
systems: quests
apples: 1🍎
---

## Systems touched

quests

## Summary

Addressed the review regression in the Floor 1 Spell Broker quest gate. Before
the merchant errand starts, the selector now removes only the authored
tail-reference line and preserves the two valid spell-introduction lines.
Locked and spellbook-claimed dialogue priorities remain unchanged, and the
default authored dialogue is restored once the merchant quest is active.

## Validation

- `npx vitest run tests/unit/spell-broker-dialogue.test.ts tests/unit/main-game-scene-helpers.test.ts`
- `bash scripts/agent/verify-fast.sh`

## Runtime observation

The real scene dialogue path was exercised through
`resolveDialogueLines('spell-quest-giver', world, deps)`: before the merchant
quest it returns the two spell-introduction lines without the tail reference;
after the quest is active it returns the authored dialogue.
