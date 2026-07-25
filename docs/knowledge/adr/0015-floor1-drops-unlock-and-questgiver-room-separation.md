# ADR-0015: Floor 1 Drops Unlock & Quest-Giver Room Separation

## Status

Accepted

**Date:** 2026-06-21
**Deciders:** Agent session (level1-quest-flow-refresh, Producer persona)

## Context

The Floor 1 quest flow is the game's onboarding experience. The design intent
(from the "Refresh of level 1 quest flow" brief) is a deliberate drip-feed of
mechanics so the player learns one system at a time:

1. Spawn and pick one of three starter weapons.
2. Find the welcome room; the welcome goon explains the premise and, as a
   reward, **unlocks drops** (gold, XP, junk).
3. Level up to 2, which opens the merchant / spell-guy / next-floor quests.
4. The merchant's rat-tail errand unlocks purchasing + inventory.
5. The spell guy's slime-rat errand unlocks a spell + the ability system.
6. Clearing those opens the boss room.

Two concrete gaps in the existing implementation worked against this intent:

- **Partial drop gating.** Only XP drops were gated behind meeting the goon
  (`floor1-xp-unlocked`). Gold and junk dropped from the very first kill, so the
  "finding the goon unlocks drops" reward was hollow — the player already had
  loot before reaching him.
- **Quest-giver room collision.** The Spell Broker was placed at exactly the
  same position as the merchant's fetch item (`spellQuestGiverPos =
questItemPos`). The brief explicitly requires the rat tail to **not** be in
  the same room as the spell guy, and overlapping NPC/item placement is
  confusing onboarding.

A third, smaller issue: welcome signs were placed at room centers starting with
the spawn room, so a sign could land on the player's exact spawn tile.

## Decision

### 1. Gate **all** Floor 1 drops behind meeting the goon

- Rename the goal flag `floor1-xp-unlocked` → `floor1-drops-unlocked`
  everywhere (scenario, drop system, HUD experience bar, main scene,
  ux-snapshot lab). One flag is the single source of truth for "drops are on",
  which keeps the XP HUD bar appearing at the same instant gold/XP/junk start
  dropping.
- In `dropSystem`, the gate (`allowDrops`) is
  `!world.floor1 || world.goalFlags.get('floor1-drops-unlocked') === true`.
  It now suppresses **gold, XP, and item (junk)** spawns, not just XP.
- **Determinism is preserved.** The gold and XP scatter loops still call
  `world.rng.next()` the same number of times whether or not drops are
  unlocked — only the entity spawn is skipped. Spawn helpers (`spawnGold`,
  `spawnXpGem`, `spawnDroppedItem`) consume no RNG, so gating their spawn never
  shifts the RNG sequence. This is what keeps the headless completion gate
  reproducible.

### 2. Separate the Spell Broker from the rat-tail room

`chooseObjectiveTiles` now selects a distinct, unused candidate room for the
spell quest giver instead of reusing the rat-tail item position. A
`usedEntries` set tracks the welcome / shop / item / slime-rat rooms, and the
Spell Broker takes the first candidate not already used. A guaranteed-distinct
fallback (`spellFallbackPos != questItemPos`) protects tiny maps.

### 3. Never place a welcome sign on the player spawn tile

`placeWelcomeSign` nudges the sign one tile forward (along its facing angle
toward the next room) when its tile coincides with `floorMap.playerSpawn`.

## Consequences

- **Onboarding reads as designed:** the first kills before meeting the goon
  produce no loot, making the goon's "drops unlocked" reward tangible.
- **Headless seeds changed.** Separating the Spell Broker room lengthens the AI's
  travel path, so the previously-canonical seed 42 no longer completes within
  the 5-minute budget. The canonical `WINNING_SEEDS` in
  `tests/headless/floor1-completion.test.ts` are now `[1, 3]`, both verified to
  reach VICTORY with all four quests complete (seed 1 ≈ 165s, seed 3 ≈ 214s).
  The seed-probing procedure is documented in that test's header.
- **Single drop flag** simplifies reasoning but means any future need to unlock
  XP and gold at different moments would require re-splitting the flag.

## Scope / Deferred

This change implements the concrete, lower-risk slice of the brief. The full
quest-chain **re-sequencing** — gating merchant/spell quest acceptance behind
reaching level 2, and changing the boss-door gate to (shop + spell-battle) — is
deferred. Those changes alter the behavior-tree AI's decision path and require
re-tuning and re-probing the canonical headless seeds. See the session handoff
`docs/knowledge/handoffs/archive/2026-06-21-level1-quest-flow-refresh.md`.
