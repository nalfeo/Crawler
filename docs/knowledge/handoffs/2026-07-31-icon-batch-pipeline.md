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
- **`approveIconBatch()`**: maps cell index N → `iconBatch[N].id` as manifest key. Count guard requires exact match (both too few and too many cells are rejected) to prevent silent index misalignment. Hard-block gate mirrors `approveVariant` — throws `hard-blocked` for any `judgeScorecard.hardBlocked === true` cell unless `allowHardBlocked: true`. Partial batches (individual PNG missing after guard passes) are non-fatal.
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

- **Runtime lookup model**: the `AbilityPresentation.iconBriefId` field currently points to a brief (not an icon ID). For batch-generated ability icons, the manifest key is the icon ID (e.g. `ability-icon-battle-focus`). A separate wiring PR should add an `iconId` field (or rename `iconBriefId` → `iconId`) and wire consumers to look up by manifest key.
- **Brief generation for partial final batches**: `gen-achievement-icon-briefs.ts` and `gen-ability-icon-briefs.ts` now correctly emit `generation.sheet.emptyCells` for partial batches. Verify after initial run that the last batch parses correctly.
- **Per-cell judge quality checks**: The hard-block gate is wired (`approveIconBatch` throws `hard-blocked` for any `judgeScorecard.hardBlocked === true` cell). Per-cell sensor threshold checks (opaqueRatio minimum) are not yet enforced; follow-on PR should add sensor-score checks matching `approveVariant`.

## Verification

- `npm run verify:fast` — green (242 tests, typecheck, lint)
- `tests/unit/sprites/icon-batch.test.ts` — 7/7 pass (briefSchema validation + buildIconBatchSheetPrompt)
- `tests/unit/sprites/approve.test.ts` — 8 new `approveIconBatch` tests added: exact count mismatch (too few and too many), missing individual PNG skip, reapproval skip, allowReapprove override, hard-block throw, allowHardBlocked override
- Review ledger: `docs/knowledge/review-ledgers/2026-07-31-icon-batch-pipeline.review-ledger.json` (3🍎, plan_review + code_review round 2)
- Canvas observation: canvas extension follows the established `canvas-harness` pattern (renderer.mjs + extension.mjs). Icon URL double-slash bug fixed (leading `/` removed from path). Binary response format aligned to `{ status, headers, body }` as required by `relayPlainBinary`. Canvas launch verified via harness pattern; visual before/after not captured (canvas is tooling-only, no shipped game surface).

## E2E validation (real Azure run, 2026-07-31)

Bugs discovered and fixed during real e2e testing across all 4 channels:

1. **Missing npm scripts** (regression from ea1622ec9 merge conflict): restored `sprites:gen-achievement-icon-briefs`, `sprites:gen-ability-icon-briefs`, `sprites:icon-batch` in `package.json`
2. **Missing `loadEnvLocal` call** in `icon-batch-cli.ts`: Azure credentials not loaded from `.env.local` without it (fix: add `loadEnvLocal(REPO_ROOT)` at CLI entry)
3. **Missing `icon.yml` template**: `template-pipeline.ts` looks up `${spriteType}.yml` → `icon.yml` was absent, causing ENOENT on every run. Created `scripts/sprites/templates/icon.yml` extending `base.yml`, disables `palette-quantize`
4. **Canvas SDK API mismatch**: `extension.mjs` used old `.onOpen/.onAction/.onClose` method style; fixed to `createCanvas({ open, onClose, actions })` + `joinSession({ canvases: [canvas] })`

Channel-by-channel results:

- **CLI**: ✅ Validated — 4 real icons generated + approved via Azure (achv-floor2-run-\*)
- **Canvas UX**: ✅ Validated — extension loads, `get_state` returns 12 batches/168 icons/4 approved
- **workflow_dispatch**: ⏳ Blocked until PR merges (GitHub requires workflow on default branch)
- **Issue→Action**: ⏳ Blocked until PR merges (same constraint)

Channels 2 and 3 should be the FIRST thing tested after this PR merges.

## Recommended next steps

1. **Post-merge**: trigger `workflow_dispatch` with `action=status` to verify the workflow runs
2. **Post-merge**: file a test issue via `.github/ISSUE_TEMPLATE/icon-batch-request.yml` with `action=run` and `batch_ids=achv-icons-batch-01` to validate Issue→Action channel
3. Run remaining batches: `npm run sprites:icon-batch -- run-all` will process all 12 briefs (168 icons), skipping the 4 already approved
4. Address the quality-gate gap in `approveIconBatch` (check judge hard-block per cell)
5. Wire `AbilityPresentation` and achievement display to look up icons by manifest key
6. Design and implement the frame compositing layer (per-difficulty tier frames for achievements, per-kind frames for abilities)
