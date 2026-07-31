# Icon Batch Generation Pipeline

**Date:** 2026-07-31  
**Branch:** nalfeo-icon-generation-plan  
**Apple estimate:** 3🍎 (tooling-only, capped)

## Summary

Adds a cost-effective icon generation pipeline for ~161 UI icons (139 achievement + ~22 ability icons). Icons are batched 16-per-sheet on a 4×4 grid (~15× API call savings vs single-icon requests). Output is 128×128 transparent-bg pixel-art symbols. Frames are NOT baked in — they are separate deterministic UI composites layered at render time.

## Systems touched

sprites-pipeline, canvas-extensions, ci-workflows

## Architecture

- **`iconBatch` field on `briefSchema`**: each entry carries `{id, concept, description}`. Length must equal `rows × cols − emptyCells.length`. Max 16.
- **`buildIconBatchSheetPrompt()`**: builds the sheet prompt from `iconBatch` entries; instructs the LLM to place one distinct symbol per cell with NO baked-in frame/border.
- **`approveIconBatch()`**: maps cell index N → `iconBatch[N].id` as manifest key. Count guard rejects runs where more cells than expected were produced (prevents silent index misalignment). Partial batches (cells missing) are non-fatal.
- **`icon.json`** type defaults: 128×128, 4×4 grid, `minVariations: 0` (no variant expansion), `opaqueRatio` sensor only.

## Trigger channels

1. **CLI**: `npm run sprites:icon-batch -- run --brief <path>` — generate + approve + queue-commit
2. **GH Actions**: `.github/workflows/icon-batch.yml` — `workflow_dispatch` (4 actions) + `issues.labeled` trigger
3. **Issue→Action**: `.github/ISSUE_TEMPLATE/icon-batch-request.yml` — dropdown selects action, auto-labels `icon-batch`. Issue body is parsed by a dedicated `parse_issue` step via env var (no shell injection).
4. **Canvas UX**: `icon-batch-review` canvas extension — batch grid, dispatch buttons, progress; follows `canvas-harness` pattern.

## Files added

- `src/shared/sprite-types.ts` — added `'icon'` at index 8
- `data/sprite-types/icon.json` — per-type defaults
- `scripts/sprites/brief-schema.ts` — `iconBatch` optional field + superRefine
- `scripts/sprites/build-prompt.ts` — `buildIconBatchSheetPrompt()`
- `scripts/sprites/generate-one.ts` — prompt routing
- `scripts/sprites/approve.ts` — `approveIconBatch()` + `icon-batch-count-mismatch` error code
- `scripts/sprites/approve-cli.ts` — `--icon-batch` flag
- `scripts/sprites/brief-paths.ts` — `icon: 'icons'`
- `scripts/sprites/icon-batch-cli.ts` — combined run+approve+queue-commit CLI
- `scripts/sprites/gen-achievement-icon-briefs.ts` — generates achievement icon briefs (16/batch)
- `scripts/sprites/gen-ability-icon-briefs.ts` — generates ability icon briefs
- `.github/workflows/icon-batch.yml` — 4-action workflow
- `.github/ISSUE_TEMPLATE/icon-batch-request.yml` — issue form template
- `.github/extensions/icon-batch-review/` — canvas extension (harness pattern)
- `tests/unit/sprites/icon-batch.test.ts` — 7 unit tests

## npm scripts added

- `sprites:gen-achievement-icon-briefs`
- `sprites:gen-ability-icon-briefs`
- `sprites:icon-batch`

## Known gaps (follow-on work)

- **Quality gates in `approveIconBatch`**: per-cell sensor/judge checks are not wired. The count guard is in place. Vision judge runs per-cell via the standard pipeline, but hard-block signals from the judge are not yet checked in `approveIconBatch`. Follow-on: check `summary.candidates[N].judgeHardBlock` before approving each cell.
- **Runtime lookup model**: the `AbilityPresentation.iconBriefId` field currently points to a brief (not an icon ID). For batch-generated ability icons, the manifest key is the icon ID (e.g. `ability-icon-battle-focus`). A separate wiring PR should add an `iconId` field (or rename `iconBriefId` → `iconId`) and wire consumers to look up by manifest key.
- **Brief generation for partial final batches**: `gen-achievement-icon-briefs.ts` and `gen-ability-icon-briefs.ts` now correctly emit `generation.sheet.emptyCells` for partial batches. Verify after initial run that the last batch parses correctly.

## Verification

- `npm run verify:fast` — green (234 tests, typecheck, lint)
- `tests/unit/sprites/icon-batch.test.ts` — 7/7 pass (briefSchema validation + buildIconBatchSheetPrompt)
- Review ledger: `docs/knowledge/review-ledgers/2026-07-31-icon-batch-pipeline.review-ledger.json` (3🍎, plan_review + code_review)

## Recommended next steps

1. Run `npm run sprites:gen-achievement-icon-briefs` and `npm run sprites:gen-ability-icon-briefs` to generate the brief YAML files.
2. Trigger a test batch via `workflow_dispatch` with `action=run` and one batch ID to verify the end-to-end pipeline.
3. Address the quality-gate gap in `approveIconBatch` (check judge hard-block per cell).
4. Wire `AbilityPresentation` and achievement display to look up icons by manifest key.
5. Design and implement the frame compositing layer (per-difficulty tier frames for achievements, per-kind frames for abilities).
