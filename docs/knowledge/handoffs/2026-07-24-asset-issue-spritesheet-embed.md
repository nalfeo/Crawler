# Handoff: Embed spritesheet and chosen variant in asset-request issue completion comment

**Date:** 2026-07-24  
**Session slug:** asset-issue-spritesheet-embed  
**Issue:** nalfeo/Crawler#1881 (closes)  
**PR:** opens from this session  
**Apple estimate:** 2🍎  

## Systems touched

sprite-pipeline

## What Was Done

Modified the asset-request issue pipeline to embed the completed spritesheet and the
top-ranked (chosen) variant as inline Markdown images in the terminal success comment
posted to the GitHub issue. Previously the comment only contained text metadata (brief ID,
run ID, and a summary path link to Azure Blob Storage), requiring the reviewer to navigate
to Azure to inspect the generated art.

### Key file changed

**`scripts/sprites/issue-pipeline.ts`**

- Added `RunFullResult` to the import from `run-full.js`.
- Extracted `buildCompletionComment(result: RunFullResult, store: RunStore): string`
  (now **exported** for unit testing). The function:
  1. Computes the last attempt's sheet file name using `result.summary.attempts ?? 1`
     (defensive fallback to `1` for legacy summaries that predate the field).
  2. Resolves a public URL via `store.resolve(briefId/runId/sheet-NN.png)`.
  3. Appends `### Spritesheet\n\n![Spritesheet](url)` to the body.
  4. When `result.summary.chosen` is non-null, finds the candidate entry by index in
     `result.summary.candidates`, then appends `### Chosen variant (N/total)\n\n![...](url)`.
  5. Includes a ✅ / ⚠️ pass label based on `chosen.combinedPassed`.
- Replaced the inline `await comment(...)` call with `buildCompletionComment`.

**`tests/unit/sprites/issue-pipeline.test.ts`**

- Added `buildCompletionComment` to the import.
- Added a new `describe('buildCompletionComment')` block with 6 unit tests:
  - Single-attempt sheet URL (`sheet-00.png`)
  - Multi-attempt sheet index (`sheet-02.png` for 3 attempts)
  - Chosen variant embed present with ✅ label when `combinedPassed: true`
  - ⚠️ label when `combinedPassed: false`
  - Omission of chosen variant section when `chosen: null`
  - Fallback to `sheet-00.png` when `attempts` is missing (legacy summary)

## Design decisions

- **Sheet key derivation**: Used `result.summary.attempts` (carried on `RunSummary`)
  rather than `result.attempts` on the outer result, because the summary JSON is the
  canonical persistent record — durable, serialisable, and already used everywhere else.
- **No upload step**: Images are served from the pre-existing Azure Blob Store via
  `store.resolve()`. For the Azure backend these are public blob URLs that GitHub's Camo
  proxy can serve as embedded images. No new Azure or GitHub API calls are needed.
- **Graceful degradation**: For the local store backend (dev / test), `store.resolve()`
  returns a file path. The image embed won't render in GitHub but the URL is still visible
  and useful locally.
- **Existing integration tests unaffected**: All previous mocks return a partial `RunSummary`
  without `chosen`/`candidates`; the function short-circuits on `undefined` for `chosen`,
  so no existing test behaviour changed.
