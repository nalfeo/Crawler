## Summary

- Implemented persistent postprocess override durability per run (`postprocess.overrides.json`) with effective pipeline snapshots (`postprocess.pipeline.effective.json|yaml`).
- Added manual-anchor persistence and precedence (`manual > derived > brief`) through rerun summaries, processed artifacts, and approval metadata.
- Added storage lifecycle APIs (`/api/storage/runs`, `/api/storage/runs/archive`, `/api/storage/runs/delete`) and a dedicated DevTool UI (`devtools-storage.html`, `src/devtools-storage-main.ts`).
- Wired DevTools postprocess actions to persisted/reset/replace behavior and manual-anchor set/clear flows.
- Added/updated tests for sidecar rerun persistence, storage endpoints, and devtools API client wrappers.

## Systems touched

azure-infra, sprite-pipeline

## Files touched

- scripts/sprites/postprocess-overrides.ts
- scripts/sprites/run-artifacts.ts
- scripts/sprites/run-pipeline.ts
- scripts/sprites/rerun.ts
- scripts/sprites/run-full.ts
- scripts/sprites/approve.ts
- scripts/sprites/sidecar/server.ts
- scripts/sprites/cli.ts
- src/shared/generated-assets.ts
- src/devtools/sprite-approval-api.ts
- src/devtools-main.ts
- src/devtools-storage-main.ts
- devtools-storage.html
- devtools.html
- vite.config.ts
- tests/unit/devtools-sprite-approval-api.test.ts
- tests/unit/sprites/sidecar-server.test.ts
- tests/integration/sprites/sidecar-rerun.test.ts
- docs/knowledge/review-ledgers/2026-07-04-sprite-postprocess-storage-lifecycle.review-ledger.json

## Verification run

- `npm test -- tests/unit/devtools-sprite-approval-api.test.ts tests/unit/sprites/sidecar-server.test.ts tests/integration/sprites/sidecar-rerun.test.ts` ✅
- `npm run verify:fast` ✅
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-04-sprite-postprocess-storage-lifecycle.review-ledger.json` ✅
- `npm run verify` ⚠️ previously failed only on missing handoff/ledger; resolved in this session and ready to re-run.

## Unresolved issues

- None currently known from targeted and fast verification.

## Recommended next steps

- Re-run `npm run verify` now that handoff + review ledger are committed.
- Run `npm run verify:pr-prereqs` once more before PR creation to confirm preflight guards are clean.
