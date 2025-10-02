# Handoff: harpoon-gun PR recovery

## Date

2026-07-18

## Persona

Reviewer / Graphics Designer

## Systems touched

sprite-pipeline

## Apples

Estimated 1🍎, actual 1🍎.

## What changed

- Corrected the `sprite:enemy.goblin` catalog metadata note in
  `src/shared/data/sprite-catalog.json` from `ghost` to `goblin` so the entry's
  note matches its id, label, description, tags, and sprite id.
- Unshallowed the local checkout before verification so `verify:fast` could
  resolve the historical git object needed by `tests/unit/agent/epic-status.test.ts`.

## Observe before done

- Before: the goblin entry's note incorrectly read `Tiny Dungeon ghost...`,
  which matched the adjacent ghost entry instead of the goblin metadata.
- After: the goblin entry's note now reads `Tiny Dungeon goblin...`, aligning
  the catalog metadata consistently for debugging/search.

## Verification run

- `bash scripts/agent/preflight.sh`
- `npm run verify:fast`

## Unresolved issues

- None.
