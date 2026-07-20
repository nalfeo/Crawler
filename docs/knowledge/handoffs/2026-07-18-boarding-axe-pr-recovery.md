# Handoff: boarding-axe PR recovery

## Date

2026-07-18

## Persona

Graphics Designer

## Systems touched

sprite-pipeline

## Apples

Estimated 🍎, actual 🍎.

## What changed

- Corrected the `generated:boarding-axe-var-0` sprite-catalog description to reflect that the checked-in asset is hand-authored pixel art derived from the `boarding-axe` brief.
- Corrected the stale `enemy.goblin` catalog note so it no longer mislabels the goblin sprite as a ghost.
- Validated the three open PR review threads with separate review agents before applying the fixes.

## Verification

- `node -e "JSON.parse(require('fs').readFileSync('src/shared/data/sprite-catalog.json','utf8')); console.log('sprite-catalog.json parses');"`
- `npx vitest run tests/unit/sprite-catalog-lab-asset-urls.test.ts tests/unit/sprites/sprite-catalog-sync.test.ts tests/unit/sprites/sprite-metadata-pipeline.test.ts`
- `npm run verify:fast` _(still hits the pre-existing shallow-clone failure in `tests/unit/agent/epic-status.test.ts` when it resolves commit `461b8a334a018ebbf6e81aa7b31f81c74e08aa6b^{tree}`; unrelated to this data-only diff)_

## Unresolved issues

- The PR still depends on the fresh post-push CI cycle for final green status; no failed jobs were present in the last completed CI run before this recovery diff.
