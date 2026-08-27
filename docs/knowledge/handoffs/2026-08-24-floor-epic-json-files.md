# Handoff: Floor 3/4 epic JSON files

## Systems touched

ci-policy

## Summary

Added new workflow input files for the generic `epic-create` workflow:

- `docs/knowledge/epics/floor-3-companion-league/floor-3-companion-league.epic.json`
- `docs/knowledge/epics/floor-4-arena/floor-4-arena.epic.json`

Both files follow `docs/guides/epic-creation-workflow.md` and use the remaining/planned slice decomposition from the living specs:

- `.specify/specs/floor3-companion-league.md`
- `.specify/specs/floor4-arena.md`

The files intentionally omit already-landed work so the workflow does not create duplicate implementation issues for completed slices. External prerequisites that are already landed or separately under review are called out in node bodies rather than represented as invalid `depends_on` edges.

## Validation

- `bash scripts/agent/preflight.sh` — passed.
- `node --test .github/scripts/epics/epic-create.test.mjs` — passed (31 tests).
- `npm run verify:fast` — passed (144 test files / 2368 tests; fast integrity checks passed).

## Tests added

Extended `.github/scripts/epics/epic-create.test.mjs` with a committed-file validation test that discovers `docs/knowledge/epics/**/*.epic.json`, validates every file with `validateEpicFile`, and asserts unique `epic_id` values with `assertUniqueEpicIds`.

## Apple score

Estimated: 1🍎. Actual: 1🍎.
