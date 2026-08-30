# Session Handoff: Fix Floor 3 companion kickoff

## Date

2026-08-30

## Persona

Game Designer

## Systems touched

enemies, quests, hud-ux, ai-behavior-tree

## Apples

3🍎 estimated, 3🍎 actual (on target — one runtime scenario fix spanning Floor 3 onboarding, spawn safety, AI-runner log evidence, and visual/headless tests).

## What Was Done

Fixed issue #3930 so Floor 3 starts with an explicit Professor Oak-like kickoff and no longer lets ambient mobs spawn inside the protected entrance/safe room:

1. Added Professor Thistle as a real Floor 3 NPC definition (`floor3-companion-professor`) and spawn the NPC near the player in `initializeFloor3Scenario` without overlapping the player.
2. Reframed Floor 3 intro/starter selection copy as Professor Thistle's companion briefing, including explicit safe-room-door guidance before the companion pick.
3. Kept the actual companion grant on the existing scenario loadout path (`selectFloor3LoadoutOption`) so both real players and the headless runner use the same available mechanics.
4. Fixed `resolveFloor3AmbientSpawnPoint` so shared ambient candidates are post-filtered through Floor 3's protected-room rules; this prevents the Floor 3 entrance spawn room (safe via manifest behavior even when its role is `SPAWN`) from being selected for ambient mobs.
5. Added structured `control` events when the AI runner auto-selects loadout options through the real scenario hook, making the initial Floor 3 companion pick visible in JSONL logs.

Review harness: 3🍎 ledger recorded at `docs/knowledge/review-ledgers/2026-08-30-floor3-companion-kickoff.review-ledger.json` with plan review, two-round code review, and independent grade.

Observed in the real artifact (rule #9):

- `tests/e2e/main-game-scene-boot.test.ts` boots the shipped `MainGameScene`, transitions Floor 2 → Floor 3, verifies Professor Thistle copy in the real modal sequence, and verifies the rendered NPC list contains `floor3-companion-professor`.
- `tests/e2e/main-game-scene-floor3-party-ux.test.ts` boots Floor 3 through the shipped scene and verifies the starter modal/party HUD flow with the updated Professor-hosted copy.
- AI-runner log evidence: `npm run ai:headless:tsx -- --floor floor3 --seed 3930 --max-frames 120 --event-log /tmp/crawler-floor3/floor3-events.jsonl --sample-interval 1` wrote a JSONL `control` event at line 1: `reason="loadout auto-selected through scenario.selectLoadoutOption"`, `note="floor3 initial loadout auto-selected option 0"`, followed by interaction state targeting `floor3-companion-professor`. The command exits nonzero only because the deliberately short run times out after writing the evidence log.

## Key Decisions Made

- Used a real NPC plus the existing blocking loadout modal instead of requiring a manual pre-selection conversation. Requiring movement/interact before the companion pick would risk worsening the safe-room-door deadlock; the NPC and modal now make the event explicit while the companion selection remains guaranteed at Floor 3 entry.
- Did not add any test-only companion grant, ability, or hook. Headless auto-selection still calls `scenario.selectLoadoutOption`, the same scenario contract the real scene uses.
- Fixed the actual safe-room spawn source rather than broadening generic spawn rules: Floor 3's manifest marks the spawn room safe even when the room role is `SPAWN`, so Floor 3 applies its own protected-room filter to the shared ambient candidate.
- Professor placement deterministically checks adjacent tiles, then nearest passable non-player tiles in the spawn room, and skips spawning only on pathological no-space maps.

## Verification

- `npx vitest run tests/unit/floor3-overworld.test.ts tests/headless/floor3-poach-loadout.test.ts --project unit --project headless` — passed.
- `npx vitest run tests/e2e/main-game-scene-boot.test.ts tests/e2e/main-game-scene-floor3-party-ux.test.ts --project e2e` — passed.
- `npm run ai:headless:tsx -- --floor floor3 --seed 3930 --max-frames 120 --event-log /tmp/crawler-floor3/floor3-events.jsonl --sample-interval 1` — wrote the expected loadout control log before expected short-run timeout.
- `npm run typecheck` — passed.
- `npm run verify:fast` — passed before the final review-fix cleanup; rerun after closeout before final handoff.
- Focused post-review cleanup check: `npx vitest run tests/unit/floor3-overworld.test.ts --project unit && npm run typecheck` — passed.

## What's Next / Blockers

No known blockers. Before final publication/merge readiness, run final `verify:fast`, `verify:pr-prereqs`, CodeQL, and ledger validation after this handoff/apple record are committed.

## Retrospective

### Lessons Learned

- Floor 3's safe entrance is protected by manifest behavior, not just by `RoomRole.SAFE`; shared spawn helpers that only reject generic safe roles can still return entrance-room candidates for Floor 3.
- The headless CLI option for scenario floor selection is `--floor <id>`, not `--floor-id`; the wrong flag silently leaves the run on Floor 1.

### Mistakes Made

- The first Professor placement fallback put the player spawn tile in the candidate loop, creating unreachable fallback code. The next version made the fallback explicit but could overlap the player on pathological maps. Final version searches for a non-overlapping passable tile and tests the normal no-overlap case.

### Opportunities for Future Improvement

- A small helper for floor-specific protected-room spawn validation could make future floor scenarios less likely to accidentally bypass their own protected-room rules when reusing shared ambient spawn logic.
