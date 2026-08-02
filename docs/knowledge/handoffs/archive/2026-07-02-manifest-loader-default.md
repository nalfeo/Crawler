# Session Handoff: Manifest loader default + Azure runs auto-load

## Date

2026-07-02

## Persona(s) adopted

UX Designer — the change is purely operator-facing interaction design on the
DevTools "Sprite Generation Workflow" page (`src/devtools-main.ts`): default
selection state, empty-state affordances, auto-loading + polling, and
load-on-select. No gameplay `src/core`/`src/game` logic.

## Routing verdict

✅ right persona — single-surface DevTools UX change, no cross-layer or gameplay
concerns.

## Apples

Estimated: 🍎 x 2 <!-- declared before work began -->
Actual: 🍎 x 2
Verdict: 🎯 Exact — a focused two-behavior change in one file; the plan review's
7 concerns (race guard, refresh token, hydration gating, silent polling) added
rigor but stayed within the 2🍎 envelope.

Hello kitties: 2/5 = 0.40 🎀

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-manifest-loader-default.review-ledger.json`
Tier: 2🍎 → stage `plan_review`.

- **plan_review** (gpt-5.4, rubber-duck): `approved_with_changes`, 7 concerns, all
  7 adopted — (1) auto-load race/stale-overwrite → `azureLoadInFlight` guard +
  disable controls during a load; (2) hydration overwrites a freshly loaded run →
  `await hydrateQueueFromSidecar()` first, keep controls disabled ("Syncing
  queue…") until it resolves; (3) out-of-order refreshes → monotonic
  `azureRefreshToken`; (4) status churn → `silent` background mode; (5)
  empty-manifest branch must still surface load errors; (6) stable option value =
  `briefId::runId`; (7) `visibilitychange` → one immediate silent refresh.

`npm run review:ledger -- validate <path>` → pass (`valid 2-apple ledger`).

## What Was Done

All changes in `src/devtools-main.ts` (the DevTools sprite-workflow page).

### 1. Manifest loader defaults to "Select a manifest…" (empty table)

- `planSelect` build loop: prepend a placeholder `<option value="">Select a
manifest…</option>` so a fresh page defaults to `''`.
- `renderActivePlan()`: early-return branch when `planSelect.value === ''` — clear
  the summary + assets `tbody`, hide the empty-state row, and set the manifest
  status line to either the `manifestError` message (`#fca5a5`) when a load failed,
  or the friendly "Select a manifest to view its assets." hint (`#93c5fd`). The
  `?? reports[0]` fallback is kept only for the non-empty stale-selection path.
- Persistence is unchanged: `writeWorkflowState` still stores `planSelect.value ||
null` and restore only re-applies a previously chosen manifest, so a saved
  selection survives refresh while fresh sessions start empty.

### 2. Azure runs auto-load + periodic refresh + load-on-select

- `azureRunKey(run) = \`${briefId}::${runId}\``— stable option identity (renamed
from`runKey`to avoid colliding with the postprocess-debugger`runKey()`in the
same`render()` scope).
- `refreshAzureRuns({ silent })` rebuilt: captures the current selection, prepends a
  `''`/"Select a run…" placeholder, lists real runs keyed by `azureRunKey`, restores
  the prior selection by key (programmatic `.value` does not fire `change`, so a
  refresh never auto-loads), drops stale responses via `azureRefreshToken`, and in
  `silent` mode skips the "Loading…"/"N run(s)." writes so a background poll never
  stomps a "Loaded X." message (errors still surface).
- `loadSelectedAzureRun()`: extracted from the old Load-sheet click body; guarded by
  `azureLoadInFlight` (one load at a time) and disables all Azure controls for the
  duration (`setAzureControlsEnabled(false)`), re-enabling in `finally`.
- `startAzureAutoRefresh()`: `setInterval` (15s, skips while a load is in flight or
  the tab is hidden) + a `visibilitychange` listener that does one immediate silent
  refresh on return to the tab.
- Listeners: `reloadSelect` **change → `loadSelectedAzureRun()`** (load on select);
  Load-sheet button kept as an explicit fallback; ↻ Runs + state filter →
  non-silent refresh.
- Init block gated on `showSpriteWorkflow`: disable controls + "Syncing queue…",
  `await hydrateQueueFromSidecar()`, then enable + initial (non-silent)
  `refreshAzureRuns()` + `startAzureAutoRefresh()`. `render()` runs once, so no
  interval stacking.

## What's Next

Nothing required. Optional future polish: make the 15s poll interval configurable,
and consider a subtle "updated" pulse when a background refresh adds a new run.

## Blockers

None.

## Branch State

- Branch: `nalfeo-expert-umbrella`.
- All tests passing: yes — full `npm run verify` green through the build (only the
  expected missing-handoff PR-prereq failed before this file existed; the review
  ledger validated).
- PR diff: `src/devtools-main.ts` (+154/−51) plus the review ledger, this handoff,
  and the apple metric.
- PR: opening at end of session (only opening authorized, not merge).

## Agent-OS Telemetry

N/A — `files/guard-telemetry.jsonl` not present this session.

## Test Results

- `npm run typecheck` → clean.
- `npm run verify:fast` → pass.
- `npm run verify` → green through typecheck, lint, format, guards, unit (252 files
  / 2962 tests), integration (50 pass / 1 skip), and the production build; the
  deferred headless Floor-1 gate was not triggered (no `src/core`/`src/game/ai`
  changes).
- **Live verification (observe-before-done, headless + deterministic via Playwright
  against `npm run devtools` at `?page=sprite-generation-workflow`):**
  - Change 1: on load `planSelect.value === ''`, the selected option is "Select a
    manifest…", the assets table has **0 body rows**, and the hint reads "Select a
    manifest to view its assets." (before: first plan auto-selected, table
    populated — per the user's screenshot).
  - Change 2 (with `/api/runs` list + summary stubbed in-page): the Azure dropdown
    auto-populated on open with a "Select a run…" placeholder first (value `''`, not
    auto-loaded) + two runs keyed `iron-sword::run-aaa` / `goblin-grunt::run-bbb`,
    status "2 run(s)."; controls stayed disabled at "Syncing queue…" until hydration
    resolved, then enabled (concern #2); dispatching `change` on the dropdown drove
    status to **"Loaded iron-sword."** and created/selected the queue item with **no
    Load-sheet press** (load-on-select).

## Key Decisions Made

- Auto-load **lists** the runs; it does not auto-load the first run's sheet (that
  would clobber the queue unexpectedly). A sheet loads only on explicit selection.
- Keep the "Load sheet" button as an explicit fallback rather than removing it.
- Default to the placeholder only for **fresh** state; a persisted manifest
  selection is still restored (progress-survives-refresh contract).
- Gate the Azure UI on queue hydration to avoid a freshly loaded run being
  overwritten by the blind `hydrateQueueFromSidecar()` queue replace.

## Retrospective

### Lessons Learned

- Programmatic `select.value = …` does not fire a `change` event, which is exactly
  what lets a periodic refresh restore the operator's selection without
  re-triggering a load.
- The DevTools bundle has multiple `render()`-scoped helpers; a generic name like
  `runKey` already existed for the postprocess debugger, so scope-collision
  checking (typecheck caught `TS2451`) matters in a 6.6k-line single-render file.

### Mistakes Made

- First Playwright screenshot hit `/` (the game) instead of the DevTools entry —
  the devtools page is served at `/devtools.html?page=…`, not `/?page=…`.
- A Playwright `page.route` handler that referenced `URL` (undefined in the MCP
  server sandbox) left a hanging route; switching to an in-page `addInitScript`
  `window.fetch` stub was the reliable way to mock the sidecar deterministically.

### Opportunities for Future Improvement

- The 15s poll cadence is hard-coded (`AZURE_RUNS_REFRESH_MS`); a small settings
  affordance could expose it if operators want faster/slower refresh.
