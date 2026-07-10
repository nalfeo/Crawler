# ADR 0055 — Floor 2 Progression Gates: Feature Unlocks, Reputation, Hidden Quests

## Status

Accepted

## Date

2026-07-10

## Systems

floor2-scenario, quest-system, reputation-system, hud

---

## Context

Three Floor 2 feedback issues were identified when running Floor 2 from the AI runner:

1. **Feature unlocks not carried forward**: When starting Floor 2 directly (AI runner or fresh
   world), all `featureUnlocks` (inventory, equipment, spells) and the `floor1-drops-unlocked`
   goal flag default to `false`. Players arriving from Floor 1 should have all Floor 1 systems
   active from the start of Floor 2.

2. **Reputation system active immediately**: `initializeFactionRelations` is called during
   `initializeFloor2Scenario`, making family relations live from the first frame. The "social game"
   of Floor 2 should only begin after the player finishes the Broker intro dialogue, not before they
   have the system context.

3. **"Thin the ranks" quests cluttering the tracker**: Den-unlock kill-counter quests (the
   `thin-the-ranks` archetype) appear in the HUD quest tracker. Because they are passive kill
   counters that fire automatically as the player fights enemies, showing them as explicit quests
   confuses the intent — they look like assignments rather than emergent conditions.

---

## Decision

### 1. Feature unlocks on Floor 2 init

`initializeFloor2Scenario` explicitly sets:

- `world.featureUnlocks.inventory = true`
- `world.featureUnlocks.equipment = true`
- `world.featureUnlocks.spells = true`
- `setGoalFlag(world, 'floor1-drops-unlocked', true)`

This is the simplest correct fix. Players transitioning from Floor 1 already have these unlocked,
so Floor 2 always starts with them active.

### 2. Reputation system gated behind Broker intro dialogue

Added optional `reputationSystemActive?: boolean` to `Floor2State` in `faction-relations.ts`.

- Default: `undefined` (treated as `true` by the guard — backwards compatible for labs/tests).
- Set to `false` in `initializeFloor2Scenario`.
- `familyRelationshipSystem` discards deltas and returns early when `reputationSystemActive === false`.
- `floor2ObjectiveTick` flips it to `true` on the same tick the `FLOOR2_BROKER_INTRO_COMPLETE_GOAL_ID`
  flag is set — which happens only after the player has read all of the Broker's intro dialogue lines.
  `MainGameScene` fires `meetBroker(world)` (which sets that flag) only when the player advances past
  the Broker's final dialogue line, not when they close the dialogue box early.

**Why not `required: boolean`?** Making it optional avoids updating every lab and test that
constructs `Floor2State` literally. The default-true semantics preserve existing behavior.

**Why discard deltas?** Queued deltas would accumulate during the locked window and fire as a
burst when unlocked. Discarding them provides clean, consistent behaviour — family relations start
at the default and evolve only from the moment the Broker intro gate is completed.

### 3. Hidden den-unlock quests

Added `hidden?: boolean` to `QuestDef` and `QuestPackQuestSource` (Zod schema updated).
`buildDenUnlockQuestPack` marks all den-unlock quests `hidden: true`.

**HUD tracker**: Filters out hidden quests before display. Mechanics (counter events, goal-flag
completion) are unaffected — the quests still run in the log, they just aren't shown.

**Auto-tracking**: `questSystem` now prefers non-hidden quests when auto-assigning the tracked
quest. Falls back to any active quest (including hidden) only when no visible quest exists — this
prevents the tracker from pointing to an invisible quest while still satisfying the "at least one
tracked" invariant.

---

## Consequences

**Positive:**

- Floor 2 players have all Floor 1 systems immediately (XP bar, inventory, abilities visible).
- Reputation/family relations only engage after the player reads all of the Broker's
  intro dialogue — narrative gating aligns with gameplay progression and the moment
  the player learns about the faction system from the Broker.
- Den-unlock progress is invisible noise to the HUD; players discover den doors opening without
  an artificial "quest" prompt distracting them.

**Negative / Risks:**

- If a future scenario wants `reputationSystemActive = false` on a world that has no Floor 2
  state, the guard doesn't fire. This is intentional (guard only applies when Floor 2 state
  exists) but worth noting.
- Hidden quests are still in the quest log; code that iterates `getActiveQuests()` without
  filtering may surface them unexpectedly (e.g. achievement counters). Callers that need
  only visible quests must filter by `getQuestDef(q.questId)?.hidden`.

**Alternatives considered:**

- _Don't initialize faction relations at all until settlement found_: More structurally pure but
  would require guarding every faction-relation consumer and complicates tests.
- _Separate "passive objective" system from the quest log_: Cleaner long-term, but adds
  significant complexity for a fix that could be a `hidden` flag.
- _Require `reputationSystemActive` as a non-optional field_: Correct but requires updating
  5 labs and multiple test helpers — noise for a one-line behavioral change.
