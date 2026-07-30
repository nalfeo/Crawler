# Session Handoff: Tutorial Goon dialogue polish (PR Group C, Item 12)

## Date

2026-06-24

## Persona(s) adopted

Content Designer — the work is authored quest-flow content: Tutorial Goon
contextual dialogue + a quest-summary nudge in the Floor 1 quest pack. No
mechanics/ECS changes.

## Systems touched

enemies, hud-ux

## Apple estimate / actual

Estimated: 🍎
Actual: 🍎🍎
Verdict: 📉 Under

Grew from a single-file dialogue add to 4 files because I extracted the
goon's dialogue-selection logic into a pure, unit-testable selector (plus a
test suite) instead of inlining an untestable branch in the Phaser scene.

Hello kitties: 2/5 = 0.40 🎀

## What Was Done

Follow-up to PR #265, which added the `floor1-leave-floor` ("Leave the Floor")
finale that gates the Floor 1 boss door. That quest was auto-accepted **silently**
— the Tutorial Goon said nothing — and nothing in the goon's chain pointed the
player at the merchant / spell broker. Both gaps are now closed. **Dialogue /
flow only — no spell or quest-completion mechanics touched** (Group B owns the
spell/ability system).

### 1. Tutorial Goon now reacts to the "Leave the Floor" finale

The goon's contextual dialogue now progresses through four states (priority high
→ low):

| State                                        | Dialogue                                      |
| -------------------------------------------- | --------------------------------------------- |
| staircase boss defeated                      | `TUTORIAL_GOON_POST_BOSS_DIALOGUE` (existing) |
| "Leave the Floor" quest accepted             | `TUTORIAL_GOON_LEAVE_FLOOR_DIALOGUE` (new)    |
| grind done, merchant/spell **not** both done | `TUTORIAL_GOON_NUDGE_DIALOGUE` (new)          |
| otherwise                                    | default authored dialogue                     |

### 2. Quest chain nudges toward the other two gate-givers

- New `TUTORIAL_GOON_NUDGE_DIALOGUE`: after the goon's kill-grind is complete but
  the boss door is still sealed, he explicitly sends the player to the Sweaty
  Merchant and the Spell Broker (so they aren't left wondering why the door won't
  open).
- `floor1-boss-unlock` quest **summary** extended to say the door stays sealed
  until the merchant + spell broker are also squared away — the quest chain itself
  now points there, not just organic discovery.

### 3. Extracted a pure, testable selector

Moved `TUTORIAL_GOON_POST_BOSS_DIALOGUE` out of `MainGameScene.ts` into
`src/shared/npc-types.ts` (alongside the existing `SHOPKEEPER_*_DIALOGUE`
constants) and added `selectTutorialGoonDialogue(state)` — a pure function taking
five booleans derived from `world.questLog` / `world.goalFlags` and returning the
right line set (or `null` to fall back to default dialogue). The Phaser scene just
computes the booleans and delegates, so the branching is unit-tested without a
Phaser/world harness.

### Files changed

- `src/shared/npc-types.ts` — new dialogue constants + `selectTutorialGoonDialogue` + `TutorialGoonDialogueState`
- `src/engine/scenes/MainGameScene.ts` — `resolveDialogueLines` delegates to the selector; local POST_BOSS const removed; imports `FLOOR1_LEAVE_FLOOR_QUEST_ID`
- `src/shared/data/quests.floor1.json` — `floor1-boss-unlock` summary nudge
- `tests/unit/tutorial-goon-dialogue.test.ts` — new selector coverage (7 cases, all priority transitions)

## Validation

- `npm run verify:fast` — pass (525 unit tests)
- `npm run verify` (full suite) — pass: typecheck, lint, format, unit+coverage, integration, **headless Floor 1 completion gate (4/4)**, build
- New selector is 100% covered; the door-gate / 3-quest flow is unchanged, so the
  seed-15 headless gate still passes.

## What's Next

- Group B (spell/ability system) may also touch `quests.floor1.json`; expect a
  possible trivial rebase on the `floor1-boss-unlock` summary line.
- Optional future polish: a Spell Broker / Merchant acknowledgement line when the
  player returns mid-chain (out of scope here).

## Blockers

None.

## Branch / PR

- Branch: `nalfeo-goon-dialogue-polish`
- PR: (opened this session — see PR link reported to creator)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no telemetry section.
