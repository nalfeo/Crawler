# Session Handoff: Tile postprocess

## Date

2026-07-03

## Persona(s) adopted

Producer, routing to Graphics Designer for sprite pipeline behavior and QA Engineer for deterministic regression coverage.

## Routing verdict

Right persona - the request touched sprite generation defaults, postprocess templates, shared resize semantics, prompt wording, and tests.

## Apples

Estimated: 2
Actual: 2
Verdict: Exact - the work stayed within a focused sprite-pipeline change plus tests after the plan review surfaced the key tile-size and letterboxing hazards.

Hello kitties: 2/5 = 0.40

## Systems touched

sprite-pipeline

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-03-tile-postprocess.review-ledger.json`
Stages: `plan_review` passed.
Validation: `npm run review:ledger -- validate docs\knowledge\review-ledgers\2026-07-03-tile-postprocess.review-ledger.json` passed.

## What Was Done

- Changed tile sprite defaults from 64x64 to 256x256, including anchor and postprocess min dimension.
- Re-enabled tile postprocess slice/resize while keeping mob-style background removal disabled so opaque tile corners are preserved.
- Added a tile-only `stretch` resize strategy so transparent buffers are trimmed away and non-square opaque tile crops fill the exact target frame without letterboxing.
- Fixed zero-margin `transparent-trim` module handling so tile templates can request a true tight crop instead of accidentally expanding the canvas.
- Updated prompt/trace wording and added regression tests for tile edge-to-edge output and tile resize strategy.

## Runtime / real-artifact observation

Observed through the real sprite postprocess pipeline (`postprocess()` with the tile template), not a lab. Before this change, the committed tile template disabled trim and resize and tile defaults were 64x64, so a buffered tile cell would ship with its transparent buffer and non-256 output. After the change, `tests/unit/postprocess-tile.test.ts` decodes the postprocessed tile as exactly 256x256 with opaque pixels on all four edges, and verifies opaque magenta tile corners survive because background removal remains disabled for tiles.

## What's Next

Reprocess any queued or recently approved tile assets so their checked-in PNGs pick up the new 256x256 edge-to-edge postprocess contract.

## Blockers

None.

## Branch State

- Branch: `nalfeo-tile-postprocess`
- All tests passing: yes
- PR created: pending

## Agent-OS Telemetry

Guard telemetry captured via: none (`files/guard-telemetry.jsonl` was not present)

## Test Results

- `bash scripts/agent/preflight.sh` passed.
- `npm run verify:fast` passed after implementation and formatting.
- `npm run review:ledger -- validate docs\knowledge\review-ledgers\2026-07-03-tile-postprocess.review-ledger.json` passed.
- `npm run verify` passed.
- `bash scripts/agent/lab-gate-check.sh` passed.

## Key Decisions Made

- Tiles use tight transparent slicing plus exact stretch resize rather than the existing fit strategy, because fit preserves aspect ratio and can letterbox non-square crops with transparent gutters.
- Tile background removal stays disabled; the useful mob cleanup path is not safe for tiles because tile art intentionally reaches opaque corners.

## Retrospective

### Lessons Learned

The earlier template-driven postprocess work intentionally disabled tile trim/resize, so this request needed both the YAML template and the shared resize strategy updated together.

### Mistakes Made

The first full verify run stopped after formatting issues; running Prettier on the touched TypeScript files fixed the immediate failure.

### Opportunities for Future Improvement

Add a small fixture-driven integration test around per-type defaults loading for tiles so future changes catch accidental regressions from 256x256 defaults back to smaller tile sizes.
