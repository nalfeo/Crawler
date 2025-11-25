# Handoff: Sweep Results Viewer Canvas Extension

**Date:** 2026-07-06
**Session:** sweep-results-viewer-extension
**Apple estimate:** 🍎 | **Actual:** 🍎 | **Verdict:** exact

## Systems touched

docs-tooling

## What was done

Added a project-scope Copilot CLI canvas extension at `.github/extensions/sweep-results-viewer/` that visualizes weapon-sweep results emitted by `scripts/agent/perf/weapon-sweep.ts` (default output `/tmp/weapon-sweep.json`).

The extension registers a canvas (`id: sweep-results-viewer`) plus three agent-callable actions:

- `load_file({ path })` — point the canvas at any sweep JSON.
- `reload()` — re-read the current file from disk.
- `get_summary()` — return per-weapon summary rows programmatically.

On `open`, each instance boots a loopback HTTP server on an ephemeral port. The page loads state over `/api/state` and subscribes to `/events` (SSE) so it live-updates when actions mutate state. A manual `↻ Reload` button hits `POST /api/reload`.

The renderer produces two panels:

1. **Per-weapon summary table** — win rate (color-coded high/mid/low), mean score, mean time, mean level, mean kills, mean min HP%.
2. **Per-seed outcome heatmap** — weapons × seeds grid, each cell colored by outcome (victory/death/timeout) with a hover-tooltip containing full run stats.

## Files touched

- `.github/extensions/sweep-results-viewer/extension.mjs` (new) — canvas registration, HTTP server, actions, SSE.
- `.github/extensions/sweep-results-viewer/renderer.mjs` (new) — HTML/CSS/JS for the panel UI.
- `docs/knowledge/review-ledgers/2026-07-06-sweep-results-viewer-extension.review-ledger.json` (new) — 1🍎 ledger.

## Verification run

- `extensions_reload` — new extension came up as `ready` (pid assigned, no error state).
- `open_canvas` + `invoke_canvas_action` end-to-end: `get_summary` on a missing file returned a clean ENOENT error; wrote a synthetic sweep JSON to `C:\tmp\weapon-sweep.json`, `reload` returned `ok: true`, `get_summary` returned the expected `{ runAt, seeds, weapons, summaries[] }` shape.
- Pre-push hook (`prettier --check`) passed after `npm install`.
- No production code touched; no ECS systems added or moved, no runtime wiring changed.

## Unresolved issues

None.

## Recommended next steps

- Consider a score-histogram or per-outcome filter if drilling into 100+ seed sweeps becomes cumbersome.
- If sweep JSON emitted alongside PR CI artifacts, agents could `load_file` those artifact paths directly rather than re-running locally.
