# ADR-0016: Floor 1 Quest-Chain Re-Sequencing

## Status

Accepted

**Date:** 2026-06-21
**Deciders:** Agent session (level1-quest-resequencing, Producer persona)

## Context

ADR-0015 shipped the lower-risk slice of the "Refresh of level 1 quest flow"
brief (all-drops gating, quest-giver room separation, spawn-tile sign nudge) and
**deferred** the quest-chain re-sequencing because every gameplay-flow change
re-tunes the behavior-tree AI and risks breaking the canonical headless seeds.

This ADR completes that deferred work. The brief's intended onboarding drip is:

1. Spawn, pick a starter weapon.
2. **Find the Welcome Office** — the Tutorial Goon's exposition beat, which as a
   reward unlocks drops.
3. **Level to 2** — the gating quest that opens the rest of the floor.
4. Merchant rat-tail errand (unlocks purchasing + inventory).
5. Spell Broker Slime-Rat errand (unlocks a spell + the ability system).
6. Boss room opens once the merchant + spell quests are done.

Four gaps remained after ADR-0015:

1. Merchant / Spell-Broker / next-floor quest _acceptance_ was not gated behind
   character level 2 — a contestant could pick them up too early.
2. "Find the welcome room" was not its own quest; the single `floor1-tutorial`
   ("Trial by XP") conflated meeting the Goon with the level-2 grind.
3. The boss door gated on `goon-quest-complete + shop-quest-complete +
boss-battle-complete` instead of the brief's `shop + spell-battle`.
4. The Slime-Rat win → concrete-spell + ability-system unlock needed to be
   confirmed as wired (parallel to how the merchant auto-unlocks inventory).

## Decision

### 1. Explicit two-step onboarding quest (brief item 2)

- New quest `floor1-find-welcome` ("Orientation") is the **only** quest accepted
  at floor init. Its single `talk` objective (tutorial-goon) represents finding
  the Welcome Office and hearing the Goon out; it completes the
  `floor1-welcome-room-found` goal flag.
- `floor1-tutorial` ("Trial by XP") is now strictly the **level-2 grind** quest.
  It is accepted by `meetTutorialGoon`, which also unlocks drops (unchanged) and
  no longer doubles as the "meet the goon" beat.
- The AI's "seek the Goon first" routing is unchanged: it keys on
  `!questLog.has(FLOOR1_TUTORIAL_QUEST_ID)`, which is still true until the Goon
  is met, so the headless trajectory is identical.

### 2. Level-2 gate on NPC quest acceptance (brief item 1)

- `meetShopkeeper` and `meetSpellQuestGiver` no-op below
  `FLOOR1_QUEST_UNLOCK_LEVEL` (2). The next-floor (`floor1-boss-unlock`) quest
  was already gated via `floor1-leveling-quest-complete`.
- The behavior-tree AI's NPC interaction _intent_ (`getNpcInteractionReason`) is
  gated identically so the AI never wastes an interact attempt on a merchant /
  broker it cannot yet recruit. Because the AI only routes to those NPCs after
  the boss-unlock kill grind (already post-level-2), this is determinism-neutral.

### 3. Boss-door gate = merchant + spell battle (brief item 3)

The pre-boss-room door lock now requires only `floor1-shop-quest-complete` +
`floor1-boss-battle-complete`. The `floor1-goon-quest-complete` (kill-grind)
condition was dropped from the door — the kill grind remains a quest, it just no
longer gates the physical door. By the time the AI reaches the boss room (after
the spell battle), both remaining conditions are satisfied, so the path is
unchanged.

### 4. Slime-Rat win → spell + ability unlock (brief item 4)

Confirmed already wired end-to-end and added explicit regression coverage:
defeating the Slime Rat and claiming the spellbook at the Broker completes
`floor1-boss-battle`, which gates `shouldShowSpellSelector`; selecting a spell
(`selectSpellFromBossBattle`) memorizes a concrete spell and latches
`featureUnlocks.spells`, enabling the ability system — the direct parallel to the
merchant auto-unlocking `featureUnlocks.inventory` on key-item pickup.

## Consequences

- **Onboarding reads as designed:** an explicit first "find the welcome room"
  quest, a distinct level-2 gate, and merchant/spell quests that only appear once
  the contestant is level 2.
- **No headless re-probing required.** Every change was deliberately shaped to
  preserve the AI's trajectory. The canonical `WINNING_SEEDS = [1, 3]` still
  reach VICTORY with all required quests under the 5-minute budget — verified
  green after the change with no seed churn (a first for a Floor 1 flow edit).
- **Contract changes** to `meetShopkeeper` / `meetSpellQuestGiver` (now level-2
  gated) are reflected in the unit tests; callers in dev labs that meet NPCs
  manually must reach level 2 first.
