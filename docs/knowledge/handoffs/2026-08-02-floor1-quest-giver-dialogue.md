# Session Handoff: Floor 1 quest-giver dialogue rewrite

## Date

2026-08-02

## Persona

Content Designer

## Systems touched

quests

## Apples

2🍎 exact (copy-only edits in one data/def file, one small pure selector mirroring
an existing one, plus its unit tests — no apples JSON required below 3🍎)

## What Was Done

Rewrote every Floor 1 quest-giver line so the three NPCs read as a crew with a
shared history instead of three unrelated joke tooltips.

**Canon now encoded in the copy:**

- The **Tutorial Goon** is the only _real_ one — an actual human contestant who
  got deep enough that the Director offered him this posting as a retirement
  package. He knows "retirement" and "never leaving Floor 1" are the same
  sentence and has made peace with it.
- The **Sweaty Merchant** and **Spell Broker** are Director-authored set dressing,
  spun up so the welcome floor didn't read as empty. Inside the dungeon the
  distinction is meaningless: they think, want, get bored, hold grudges.
- The three have shared one room for more seasons than the Goon can count, and he
  _used_ to count. They have rotated through friends/enemies/lovers in different
  combinations; **currently** the Goon and the Merchant are together and the
  Broker is not, and is extremely not over it.
- The Merchant's fetch-item tail is for a sex toy. Never stated — the Merchant's
  "it's for the room" and the Broker's "take the long way back, knock first" carry
  it entirely by implication. Innuendo only, no anatomy, nothing named.

**Pacing** follows the floor's eight beats: the relationship is background through
the Goon's opening three lines, visible at the Merchant/Broker beats, comically
explicit at the post-grind nudge, then dropped for the leave-floor and post-boss
beats so the floor exits on the player, not the sitcom.

**Files:**

- `src/shared/npc-types.ts` — 3 `NpcDef.dialogue` arrays + 7 contextual arrays
  rewritten; new `SPELL_BROKER_POST_CLAIM_DIALOGUE`, `SpellBrokerDialogueState`,
  and `selectSpellBrokerDialogue()` (mirrors `selectTutorialGoonDialogue()`).
- `src/engine/scenes/main-game-scene-helpers.ts` — the `spell-quest-giver` branch
  of `resolveDialogueLines` now calls the selector (priority: locked >
  post-spellbook-claim > authored default) instead of only checking `isLocked`.
- `src/engine/scenes/MainGameScene.ts` — the Learn-a-Spell modal body absorbed the
  `[B]` keybind and ten-slot capacity instruction that left the Broker's lines, so
  no tutorial information was lost.
- `src/shared/data/quests.floor1.json` — quest `summary` strings repitched into the
  same voice as the NPCs.
- `tests/unit/spell-broker-dialogue.test.ts` (new) + 3 new `resolveDialogueLines`
  cases in `tests/unit/main-game-scene-helpers.test.ts`.

**Runtime/real-artifact observation: NOT DONE — see Blockers.** This session could
not install dependencies (see Lessons Learned), so the eight dialogue beats were
never observed in `npm run dev`. Rule #9 is unsatisfied for this change.

## Key Decisions Made

- **The Broker got a contextual slot, the Merchant did not.** The Merchant already
  had a five-stage machine (locked / fetch / return / equip-hint / done) with room
  for the arc; the Broker had exactly two states and no beat after the spellbook
  was claimed, which is where his jealousy needed to land. One new selector, keyed
  off the existing `floor1-boss-spellbook-claimed` goal flag — no new flags.
- **Locked outranks post-claim in the Broker selector.** Both can be true in a
  contrived world state; the locked line is the one that routes the player, so it
  wins. Pinned by a test rather than left to branch order.
- **The species is "rat".** The fetch item is `glistening-rat-tail` across the
  drop table, `quest-types.ts`, and `floor1-scenario.test.ts`, and it stays a rat —
  no rename is planned. The new copy says "a tail" without a species, so the
  dialogue reads correctly regardless.
- **The Goon's opening no longer previews the three-gate structure.** That was a
  full-structure dump delivered before the player had killed anything; the existing
  `TUTORIAL_GOON_NUDGE_DIALOGUE` already explains it at the moment it becomes
  actionable. Beat 1 now carries one mechanic (XP is on) and one character fact.
- **No gameplay surface touched.** No quest IDs, goal flags, gate ordering, or
  state-machine branches moved, so `questSystem`, `floorScenario`, and the whole
  `bt-ai-provider` NPC interaction path are untouched and the AI runner is
  unaffected.

## What's Next / Blockers

**Blocker — the observe-before-done step is outstanding.** Someone with a working
`node_modules` needs to run `npm run dev` and walk all eight beats, confirming in
particular that the new Broker post-claim lines actually fire after the spellbook
is claimed (the only new branch) and that no line overflows `DialogueBox`. The
longest new strings — the Goon's nudge line 2 and the Merchant's equip hint — are
noticeably longer than what they replaced and are the most likely to wrap badly.

Also unrun locally: `npm run verify:fast`, typecheck, lint. CI is the first gate
that will actually execute them.

Open question left with the maintainer: whether the explicitness ceiling is right.
The bluest line in the set is the Merchant's "look at the length on it" — the whole
set is pitched at "the player works it out in the hallway" and can be dialled either
direction cheaply since it's all string edits.

## Retrospective

### Lessons Learned

- **The `npm ci` failure mode here is a DNS failure on the private feed, not a slow
  network.** `package-lock.json` pins tarball URLs to
  `ms-feed-12.pkgs.visualstudio.com`, which does not resolve in this sandbox;
  `npm ci` fails with `ENOTFOUND` after several minutes and retrying three times
  changes nothing. Diagnose it by grepping the npm error for the hostname rather
  than assuming transient flakiness — the generic "you may be behind a proxy" tail
  buries the actual host.
- **`npx prettier` still works when `npm ci` doesn't**, because it resolves from
  the public registry rather than the lockfile's pinned feed. That made it possible
  to format-check the changed files with zero installed dependencies. Worth
  remembering as the one verification tool available in a dependency-less sandbox.
- **Check the pre-existing prettier state before believing a warning.** `npx`
  pulled prettier 3.9.6, which flags `MainGameScene.ts` even on a clean tree —
  confirmed by stashing and re-running. Without that check the natural move is to
  "fix" formatting the repo's pinned version never asked for.
- **Existing dialogue tests assert array _identity_, not line text**, which is why a
  full-copy rewrite of ten arrays was safe. That's a deliberate property of
  `tutorial-goon-dialogue.test.ts` and `main-game-scene-helpers.test.ts` worth
  preserving — asserting on prose would make every content pass a test-churn event.

### Mistakes Made

- **Flattened every contraction to dodge quote escaping, then had to undo it.** To
  avoid thinking about prettier's single-vs-double quote selection I wrote "It is on
  now", "I do not get a lot of visitors", "I have got a room to get back to" — which
  is exactly the stilted register the rewrite existed to eliminate. Needed a second
  scripted pass over fifteen strings to restore natural speech. Early signal: if the
  new copy reads more formally than the copy it replaces, the tooling is writing the
  lines instead of you. Prettier picks the quote style that minimizes escapes on its
  own — write the sentence, let the formatter sort out quoting.
- **Assumed the `[B]` keybind hint would need relocating before checking.** The plan
  called it out as content that would be lost, but `MainGameScene` already flashed
  "Spell learned! Press [B] to configure your abilities bar." on confirm. Only the
  ten-slot capacity detail was genuinely unique to the Broker's line. Grepping the
  modal first would have scoped that item down from "relocate" to "add four words".

### Opportunities for Future Improvement

- **The Merchant and Broker have no reciprocal contextual lines for the _other's_
  progress.** The Goon's selector reads all three gate flags; the other two read
  only their own. Cheap follow-up with real payoff: have the Merchant acknowledge
  the player already has a spellbook, or the Broker acknowledge the new gear.
- **`DialogueBox` has no length budget and nothing checks one.** Line length is
  currently enforced by an author's eye and a manual run. A deterministic
  max-characters-per-line assertion over every exported dialogue array would turn
  the riskiest part of any copy pass into a unit test.
- **The Floor 1 crew's canon now lives only in dialogue strings and this handoff.**
  It is load-bearing for anything that touches these three NPCs and is not in
  `docs/knowledge/game-design/lore-bible.md`. A short "Floor 1 crew" section there
  would stop the next content session from re-deriving or contradicting it.
