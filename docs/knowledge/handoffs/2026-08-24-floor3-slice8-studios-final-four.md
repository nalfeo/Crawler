# Floor 3 slice 8 — Studios + Final Four objective progression

## Systems touched

enemies, ai-behavior-tree, mapgen, quests

## Summary

- Implemented Floor 3 Slice 8 runtime content: deterministic seeded Studio (6-of-10) and Final Four (4-of-7) roster selection and authored data in `src/shared/data/floor3/studios.ts`.
- Extended `initializeFloor3Scenario`/`floor3ObjectiveTick` with Studio defeat tracking, Final Four unlock/spawn, victory latching, stairs pop/unlock/discovery flow, and Floor 3 stair-descend confirmation wiring.
- Added companion roster spawn support (`spawnRosterCompanion`) and encounter wipe predicate support (`_isEncounterTeamsWiped`) used by the Floor 3 objective flow.
- Tightened companion AI targeting behavior by limiting rival-target selection to local engagement radius and ensuring only player-team companions follow the player.
- Prevented post-victory ambient wild spawning by short-circuiting `floor3WildDirectorSystem` once Floor 3 victory is latched.

## Validation

- Targeted suites:
  - `npx vitest run tests/game/enemy-ai.test.ts tests/unit/floor3-victory-system.test.ts tests/unit/floor3-overworld.test.ts`
  - `npx vitest run tests/unit/scenario-definitions.test.ts`
- Global gates:
  - `npm run typecheck`
  - `npm run lint -- --quiet`
  - `npm run verify:fast`
- Security hygiene:
  - `runtime-tools-secret_scanning` over all changed files: no secrets detected.
  - `codeql_checker`: 0 alerts (analysis skipped for javascript database size in this environment).
