# Implementation Plan Summary: Postprocess Overrides & Storage Lifecycle

## Overview

This branch introduces persisted overrides for the sprite postprocessing pipeline (tweaks and manual anchors), alongside a new DevTools UI and Sidecar APIs to manage Azure storage lifecycles (archiving and deleting runs).

## Files Touched

- **Core overriding logic**: `scripts/sprites/postprocess-overrides.ts` (new) manages file IO for `postprocess.overrides.json`, `postprocess.pipeline.effective.{json,yaml}`, and `manual-anchor.json`.
- **Pipeline modifications**: `scripts/sprites/run-pipeline.ts`, `scripts/sprites/run-full.ts`, `scripts/sprites/rerun.ts`, `scripts/sprites/run-artifacts.ts` were updated to read/write overrides, trace their provenance in run summaries, and patch the scorecard to bypass anchor sensors when a manual override is active.
- **Sidecar API**: `scripts/sprites/sidecar/server.ts` exposes new REST endpoints (`/manual-anchor` and `/storage/runs/*`).
- **DevTools UI**:
  - `src/devtools-main.ts` updated to include manual anchor inputs.
  - `src/devtools-storage-main.ts` (new), `devtools-storage.html` (new), and `vite.config.ts` wired up to provide a standalone Storage Lifecycle Manager UI.
  - `src/devtools/sprite-approval-api.ts` expanded with API client functions.
- **Types/CLI**: `scripts/sprites/approve.ts`, `scripts/sprites/cli.ts`, and `src/shared/generated-assets.ts` updated to recognize the new `'manual'` anchor source and the expanded `RunSummaryShape`.
- **Tests**: Added tests in `sidecar-rerun.test.ts`, `sidecar-server.test.ts`, and `devtools-sprite-approval-api.test.ts`.

## Risk Areas

1. **Sensor Scorecard Bypassing**: `applyManualAnchorToScorecard` forces anchor-related sensors to pass when a manual anchor is provided. This is desired for overrides but carries the risk of subtly masking genuine derivation failures in aggregate telemetry if not filtered out.
2. **Data Deletion / Lifecycle**: The new `/storage/runs/delete` endpoint enables destructive operations in Azure Storage. The devtools UI mitigates accidental usage with `window.confirm`, but the risk of irreversible data loss exists.
3. **Idempotency**: Rerunning variations must properly cascade the effective parameters (replace vs. reset). `optionsMode` explicitly controls this to prevent confusing state mutations across reruns.

## Compatibility

- **Graceful degradation**: `readPostprocessProfile` and `readManualAnchor` catch syntax errors and missing files, silently ignoring corrupt or legacy profiles without crashing the pipeline.
- **Legacy Runs**: `RunSummary` shapes correctly treat the new `postprocessOverrides` property as optional, preserving backward compatibility with older artifacts.

## Test Strategy

1. **Unit tests**: `tests/unit/sprites/sidecar-server.test.ts` validates the fastify endpoints. `tests/unit/devtools-sprite-approval-api.test.ts` ensures client methods correctly marshal data.
2. **Integration tests**: `tests/integration/sprites/sidecar-rerun.test.ts` exercises the sidecar rerun flows to confirm that manual anchors are correctly persisted to the file system and successfully override the `ChosenAnchorSource` on the regenerated scorecard.
