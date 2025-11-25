# Handoff: Quest Packs + Event Contract + Templates (Phase 1-3) — 2026-06-14

## Systems touched

quests

## Session Summary

Implemented the requested first three quest-system phases only:

1. Config-driven quest content (external quest pack file)
2. Event-driven quest progression contract
3. Template-driven quest definitions (kill/fetch/goal templates)

Also added a dedicated quest content lab for runtime pack/template/event validation.

## Apple Estimate

- Declared: 🍎🍎🍎🍎
- Actual: 🍎🍎🍎🍎
- Verdict: **on-estimate**

## What Changed

### 1) Config-driven quest content

- Added `src/shared/data/quests.floor1.json` as the source of Floor 1 quest definitions.
- Replaced hardcoded in-module quest definitions in `src/shared/quest-types.ts` with:
  - data-pack schema validation (`questPackSchema`)
  - runtime registry build from validated pack data
  - pack install/reset APIs (`installQuestPacks`, `installDefaultQuestPacks`, `getQuestPacks`)

### 2) Event-driven quest progression

- Added `src/shared/quest-events.ts` with the quest event contract:
  - `quest.counter.set`
  - `quest.counter.add`
  - `quest.npc.talked`
- Extended world state in `src/core/world.ts` with `world.questEvents`.
- Updated `src/core/systems/questSystem.ts` to:
  - queue events via `emitQuestEvent`
  - convert `notifyQuestTalk` and `setQuestCounter` to event emitters
  - add `addQuestCounter`
  - consume/drain `world.questEvents` each tick before quest evaluation

### 3) Template-driven quests

- Added template schemas + compiler in `src/shared/quest-types.ts`:
  - `goalFlag`
  - `killTargets`
  - `fetchAndEquip`
- Converted Floor 1 quests in JSON pack to template usage (no hardcoded objective arrays in TS).

### Labs

- Added `src/labs/quest-content-lab/index.ts`.
- Registered lab in `src/lab-main.ts` as `quest-content-lab`.
- Lab supports:
  - inspecting loaded packs and compiled quests
  - injecting a runtime pack
  - accepting and progressing template-generated quests via events

### Exports / API surface

- Updated `src/shared/index.ts` quest exports.
- Updated `src/game/index.ts` to export `addQuestCounter` and `emitQuestEvent`.

## Tests

- Added `tests/unit/quest-types.test.ts` for:
  - default pack loading
  - runtime template-pack compilation
  - objective target defaults
- Updated `tests/ecs/quest-system.test.ts` with event-queue consume/clear coverage.

## Validation

- `npm run verify:fast` ✅
- `bash scripts/agent/lab-gate-check.sh` ✅
- `npm run verify` ⚠️ fails on pre-existing flaky integration timeout:
  - `tests/integration/batch-cli.test.ts > runBatch ... completes three briefs ...`
  - timeout at 60000ms (same known failure pattern observed in baseline run before edits)

## Scope Notes

- Per request, implemented only phases 1-3.
- No save/migration work was added (no save system yet).
- Hardcoded quest definitions were removed from `quest-types.ts` and replaced by pack-driven/template-compiled content.
