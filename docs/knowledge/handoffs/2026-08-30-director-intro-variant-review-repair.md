# Session Handoff: Director intro variant review repair

## Date

2026-08-30

## Persona

Game Designer

## Systems touched

quests, hud-ux

## Apples

2🍎 estimated, 2🍎 actual (exact; corrected authored scenario copy and
deterministic unit coverage).

## Summary

Repaired PR #3933 review findings for deterministic Director intro variants.
All Floor 1 variants now explain that completing the quest and boss chain
unlocks the stairs. The other playable floor pools also name their exit route.
Floor 5 accurately states that its foundation has no escape route yet and
directs the player to keep the Command Post alive, rather than referring to
unimplemented capture mechanics.

The selection test now holds a Director pool and seed constant while varying
only `floorId`, so removing the floor salt is detected.

## Files touched

- `src/game/scenarioDefinitions.ts`
- `tests/unit/scenario-definitions.test.ts`
- `docs/knowledge/adr/2026-08-30-director-intro-variant-selection.md`

## Verification

- `bash scripts/agent/preflight.sh` — passed (including typecheck).
- `npm test -- tests/unit/scenario-definitions.test.ts tests/unit/intro-scene-wiring.test.ts` — passed, 2 files / 50 tests.
- `npm run verify:fast` — failed before the final `{playerName}` template repair; the final targeted regression suite passed.

## Unresolved issues

None.

## Recommended next steps

When later Floor 5 siege slices add an actual exit route, replace the
foundation-status intro wording with guidance for that implemented route.
