# Handoff — 2026-06-21 — level1-quest-resequencing

**Persona:** Producer (multi-layer: story/quests, ECS gating, behavior-tree AI, tests)

## Summary

Completed the quest-chain re-sequencing that ADR-0015 explicitly deferred. The
prior session shipped the low-risk slice and punted the AI-coupled flow changes
citing seed-probing cost. This session shipped all four deferred items **without
any headless seed re-probing** — the changes were shaped to be
determinism-neutral, and the canonical gate (`WINNING_SEEDS = [1, 3]`) stayed
green throughout.

## What Was Done

### Item 2 — Explicit "find the welcome room" first quest

- New `floor1-find-welcome` ("Orientation") quest in
  `src/shared/data/quests.floor1.json`; constant `FLOOR1_FIND_WELCOME_QUEST_ID`
  in `src/shared/quest-types.ts`. Single `talk` objective (tutorial-goon),
  `onCompleteGoalFlag: floor1-welcome-room-found`.
- `initializeFloor1Scenario` auto-accepts + tracks it (the only quest at init).
- `meetTutorialGoon` now: completes find-welcome (talk), accepts the level-2
  grind quest (`floor1-tutorial`), unlocks drops. `floor1-tutorial` summary
  reworded to "grind the swarm and hit level 2".

### Item 1 — Level-2 gate on NPC quest acceptance

- `meetShopkeeper` / `meetSpellQuestGiver` no-op below level 2
  (`FLOOR1_QUEST_UNLOCK_LEVEL`).
- Mirror gate in `bt-ai-provider.ts` `getNpcInteractionReason` so the AI doesn't
  attempt early interactions.

### Item 3 — Boss-door gate

- `src/game/floor1Scenario.ts` init door config now gates on
  `floor1-shop-quest-complete` + `floor1-boss-battle-complete` only (dropped
  `floor1-goon-quest-complete`).

### Item 4 — Slime-Rat win → spell + ability unlock

- Confirmed already wired (modal + auto-progression + `selectSpellFromBossBattle`
  → `featureUnlocks.spells`). Added explicit end-to-end regression test tying the
  Slime-Rat defeat + spellbook claim to `shouldShowSpellSelector` →
  ability-system unlock.

### Tests / Docs

- `tests/game/floor1-scenario.test.ts` — updated meet-NPC tests to set level 2;
  rewrote the boss-door test to the new gate; rewrote the opening-quest test to
  assert find-welcome at init + level-2 gating; new item-4 win→unlock test.
- `tests/game/floor1-main-scene-options.test.ts` — set level 2 before Broker meet.
- `docs/knowledge/adr/0016-floor1-quest-chain-resequencing.md`.

## Validation

- `npx tsc --noEmit` — ✅
- `eslint src/ tests/ --max-warnings 0` — ✅
- Unit project — ✅ 1360 → 1363 tests (added 3 net; `floor1-scenario` 16 pass).
- Headless gate (`tests/headless/floor1-completion.test.ts`) — ✅ 8 tests, seeds
  [1, 3] VICTORY, **no re-probe needed**.

> Pre-existing: the `integration` project's sprite-pipeline tests (generate-one,
> batch-cli, judge-\*) fail in this sandbox (slicer/provider env), unrelated to
> this change. `verify.sh` tolerates integration failures.

## Apples

- Estimated: 🍎🍎🍎🍎 (Large)
- Actual: 🍎🍎🍎 (Medium-Large) — the determinism-neutral framing avoided the
  expensive seed-probing loop that dominated ADR-0015's budget.
- Delta: -1 → 🙂 Under
- Notes: The big win was recognizing each change could be made path-preserving:
  the AI seeks the Goon on `!has(FLOOR1_TUTORIAL_QUEST_ID)` (still accepted only
  on meet), reaches shop/spell only post-level-2, and reaches the boss door only
  after both remaining gates — so gating/relaxing those never moved the seed.

## Systems touched

quests

## Deferred

None from the original brief — all four re-sequencing items are now shipped.
