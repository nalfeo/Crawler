# Handoff: Sprite Workshop — DevTools & Postprocess Debugger

**Date:** 2026-06-11  
**Branch:** `nalfeo/sprite-generation-workshop`  
**Complexity estimate:** 🍎🍎🍎🍎 (4 apples) — multiple interrelated UX rewrites across many files, merge conflict resolution, approval migration integration, full debugger redesign  
**Actual:** 🍎🍎🍎🍎 — accurate; the scope was larger than it looked (16+ subsystem touches)

---

## What was done

### 1. DevTools page-based navigation

- `src/devtools-main.ts` now routes via `?page=home|floor-art|postprocess`
- Searchable home page with clickable tool cards (filter by keyword)
- Floor-art/workflow sections shown only on `floor-art` page
- Postprocess debugger shown only on `postprocess` page

### 2. Shared Labs/DevTools/Game header

- `lab.html`, `devtools.html`, `index.html` all share `<header id="app-header">` with `<nav id="app-switcher">` (Labs / DevTools / Game)
- Active link highlighted per surface
- Local/beta-only: inline script checks `window.location.hostname` for `localhost`, `127.0.0.1`, `::1`, or `beta` substring. Adds `.hide-debug-header` class otherwise; CSS hides the header.
- Game page (`index.html`) converted to `flex-direction: column` so header coexists above Phaser canvas

### 3. Sprite approval migration

- `src/devtools/sprite-approval-api.ts` created: `listSidecarRuns`, `fetchRunSummary`, `extractVariantIndices`, `postApprove`
- Approval workflow in DevTools: run select → variant select → approve button
- `src/labs/sprite-gallery-lab/index.ts` is now inspection-only (no approve UI)
- `tests/unit/devtools-sprite-approval-api.test.ts` added; old lab approve tests removed

### 4. Run/variant picker for postprocess debugger

- Dropdowns populated from live sidecar (`listSidecarRuns`, `fetchRunSummary`)
- "Refresh runs" button, "Load selected" button
- Auto-refreshes on page load and after successful generation

### 5. Postprocess debugger full redesign (top-to-bottom pipeline trace)

- Replaced static `debuggerPipelineSection` / `debuggerSlicingSection` DOM with single `debuggerTraceHost`
- `renderPostprocessDebugger` rebuilds three sections per loaded target:
  1. **Source sprite sheet** — full-width `<canvas>` rendering of raw sheet; tab buttons for multi-sheet runs
  2. **Slicing** — same sheet on a second `<canvas>` with canvas overlay: semi-transparent dim over whole sheet, selected variant cell rendered clean + blue selection border; grid lines from `spriteW × spriteH` dimensions
  3. **Pipeline steps** — before→after card per `pipeline.json` step in order; Final output card appended at end
- Staleness guard on all async callbacks: checks `debugTarget === current` before touching DOM
- Reprocess A/B section kept as static DOM below `debuggerTraceHost`

### 6. Merge conflict resolution

- Stale git conflict markers (from a prior stash pop) were present throughout `src/devtools-main.ts`
- Resolved all conflicts by taking "Updated upstream" side (formatting-only differences)

---

## Technical notes

- **Sidecar base URL:** `http://127.0.0.1:3010`
- **Sheet files:** `/api/runs/:briefId/:runId/sheets` → `{ files: string[] }`, served at `/api/runs/:briefId/:runId/sheet/:filename`
- **Pipeline manifest:** `${padded}.pipeline.json` under processed/ path; shape `{ steps?: [{id?, label?, file?}] }`
- **Sprite dims for grid:** Loaded from final sprite `${padded}.png`. Deferred draw pattern: `pendingSheetImg` stores the sheet until `onSpriteDimsKnown()` fires.
- **Local/beta header gating:** `window.location.hostname` check in inline `<script>` in HTML files; CSS `header#app-header { display: none }` on `.hide-debug-header` body class.

---

## Files changed

| File                                              | Change                                                                                               |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `src/devtools-main.ts`                            | Major rewrite: page routing, run/variant picker, full postprocess debugger redesign, approval wiring |
| `src/devtools/sprite-approval-api.ts`             | New: sidecar API helpers                                                                             |
| `tests/unit/devtools-sprite-approval-api.test.ts` | New: contract tests                                                                                  |
| `tests/unit/sprite-gallery-lab-approve.test.ts`   | Deleted (moved)                                                                                      |
| `lab.html`                                        | Shared header + switcher                                                                             |
| `devtools.html`                                   | Shared header + switcher                                                                             |
| `index.html`                                      | Shared header (Game active), flex-column layout                                                      |
| `src/labs/sprite-gallery-lab/index.ts`            | Inspection-only, no approve UI                                                                       |

---

## Verification

`npm run verify:fast` — ✅ 1155 tests, typecheck + lint clean

---

## Potential follow-ups

- First pipeline step "before" shows `—` placeholder (no raw pre-pipeline sprite stored). If sidecar stores `${padded}-raw.png`, wire it up.
- Sheet tab buttons switch the sheet canvas but the slicing canvas auto-follows via `tryDrawGrid` — worth verifying with a real multi-sheet run.
- End-to-end test of reprocess flow → `renderPostprocessDebugger` rebuild in new layout (untested beyond unit level).
