# DevTools review persistence

## Systems touched

devtools

## What changed

- Added a `sprite-review` DevTools page alias and updated the floor-art home entry to link there.
- Persisted floor-art workflow state in `localStorage` so reloads keep the selected asset, queue, candidate, run, and debugger target.
- Changed reviewed status labels from `Approved` to `Reviewed` in the tracker UI.
- Added review links for approved assets that have a generated sheet, and carried `sourceRun` / `variantIndex` through the report models.
- Updated the legacy sprite-gallery lab banner to steer users to DevTools.

## Validation

- `npx tsc --noEmit`
- `npx eslint src/ tests/ scripts/ --max-warnings 0`
- `CI=1 npx vitest run --project unit --reporter=dot`

## Notes

- `npm run verify:fast` hangs in this environment through the npm/bash wrapper, but the underlying typecheck, lint, and CI-mode unit suite all pass.
