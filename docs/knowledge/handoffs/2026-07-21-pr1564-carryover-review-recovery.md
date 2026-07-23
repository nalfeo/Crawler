# Session Handoff: PR #1564 carryover review recovery

## Date

2026-07-21

## Persona

Producer

## Systems touched

inventory, weapons, ci-policy

## Apples

2 apples estimated, 2 apples actual.

## Summary

Recovered the remaining PR #1564 review blockers around generated-equipment carryover state and the branch-level ADR prerequisite.

- updated `src/game/playerCarryover.ts` so carryover snapshots preserve generated active grant-source authority while still stripping static equipment sources;
- added a unit regression proving a known-inactive generated active ability stays inactive across capture/restore even when replay order changes;
- added `docs/knowledge/adr/2026-07-21-generated-equipment-carryover-authority.md` so the existing cross-layer branch diff satisfies `pr-preflight`, and rewrote the older handoff note into past tense historical context.

## Validation

- `npm test -- tests/unit/player-carryover.test.ts`
- `npm run test:integration -- tests/integration/floor-transition-carryover.test.ts`
- `npm run verify:fast`
- `npm run verify:pr-prereqs`

## Notes

- Separate `gpt-5.4` review agents validated both open review threads before any changes.
