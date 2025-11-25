# Session Handoff: Generic Boss Registry Refactor

## Date

2026-06-24

## Persona(s) adopted

Producer — multi-layer change spanning shared types, game scenario, engine rendering, AI provider, and labs.

## Routing verdict

✅ right persona — cross-cutting refactor touching game logic, engine rendering, ECS types, and tests.

## Apples

Estimated: 🍎🍎🍎  
Actual: 🍎🍎🍎  
Verdict: 🎯 Exact

Hello kitties: 3/5 = 0.60 🎀

## Systems touched

enemies

## What Was Done

Removed all hardcoded per-boss state fields from the Floor 1 data model and replaced them with a generic boss registry.

### Problem

`Floor1ObjectiveState` had 6 hardcoded boss fields:

- `slimeRatBossEid`, `slimeRatBattleStarted`, `slimeRatBossDefeated`
- `staircaseBossEid`, `bossBattleStarted`, `staircaseBossDefeated`

`Floor1ScenarioState` had 2 hardcoded door arrays:

- `bossDoorEids: number[]`
- `slimeRatDoorEids: number[]`

Functions like `playBossSpawnIntro()` and `updateBossHealthBar()` in `MainGameScene.ts` had two separate hardcoded boss checks with hardcoded display names ("Slime Rat", "Rat Slime").

### Solution

**`src/shared/floor1.ts`**

- Added `Floor1BossEncounterState` interface: `{ started, bossEid, defeated, displayName }`
- Replaced 6 hardcoded boss fields with `bossBattles: Map<string, Floor1BossEncounterState>`
- Replaced 2 door arrays with `bossRoomDoorEids: Map<string, number[]>`

**`src/game/floor1Scenario.ts`**

- Initializes `bossBattles` with `'slime-rat'` and `'staircase'` keys (JS Map insertion order = health-bar priority)
- All boss logic now reads/writes via `bossBattles.get('slime-rat')!` and `.get('staircase')!`
- `bossRoomDoorEids` map replaces the two separate door arrays

**`src/engine/scenes/MainGameScene.ts`**

- `previousBossEid` + `previousSlimeRatBossEid` → `previousBossEids: Map<string, number | null>`
- `playBossSpawnIntro()` iterates `bossBattles` generically
- `updateBossHealthBar()` finds first active boss from the map; display name comes from `battle.displayName`
- Commentary milestones access `bossBattles.get('staircase')` for staircase-specific events
- `resolveDialogueLines()` uses `bossBattles.get('staircase')?.defeated`

**`src/engine/PhaserBridge.ts`**

- `enemy_boss` visual type: checks all bossBattles values instead of hardcoding `staircaseBossEid`

**`src/game/ai/bt-ai-provider.ts`**

- AI navigation now reads from `bossBattles.get('slime-rat')!.started/.defeated`

**`src/labs/hud-lab/index.ts`, `src/labs/ux-snapshot-lab/index.ts`**

- Mock state updated to the new interface

**`tests/game/floor1-scenario.test.ts`**

- All assertions updated to use `objective.bossBattles.get('slime-rat')` and `bossRoomDoorEids.get(...)`

## What's Next

- Adding a third boss to a future floor now only requires adding a new entry to `bossBattles` and `bossRoomDoorEids` — no code changes needed in `MainGameScene.ts`.
- The `displayName` in `Floor1BossEncounterState` could eventually be driven by a boss definition config rather than inlined in the Map initializer.

## Blockers

None.

## Branch State

- Branch: current task branch
- All tests passing: yes (unit 109, fast verify ✅)
- PR created: yes

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist — no telemetry section.
