# Handoff — Scope sprite devtools "Clear Azure state" button to the selected run (2026-07-03)

## Why

The devtools sprite-generation UI had a **"Clear Azure state"** button whose
tooltip/confirm claimed it cleared state "for this workspace". It actually sent
`POST /api/workflow/store/clear {scope:'all'}`, whose server handler lists
**every** key in the shared Azure blob container (`store.list('')`) and deletes
all of them — every run for every brief **plus** all `workflow-state/…`. The
`AzureBlobRunStore` uses a single shared container with **no per-workspace or
per-session key prefix**, so one click wiped shared state for everyone. The user
expected it to delete only the currently selected run.

## What shipped

Repurposed the button to delete **only the run selected in the reload
dropdown**, reusing an endpoint that already existed — no server changes.

### Files

- **`src/devtools/sprite-approval-api.ts`** — new typed `deleteSidecarRun(briefId,
runId, fetcher?)` helper (after `postApprove`). Issues `DELETE` to
  `runSummaryUrl(briefId, runId)` (which `encodeURIComponent`s both path
  segments), returns the parsed `DeleteRunResponse` (`{ deleted }`), and surfaces
  the server error message on any non-2xx. Wire contract is unit-testable with an
  injected fetcher, no DOM.
- **`src/devtools-main.ts`** — the button (`clearStoreBtn` → `deleteRunBtn`) is
  relabeled **"Delete run"** with an accurate tooltip, added to
  `setAzureControlsEnabled`, and its click handler rewritten to:
  - resolve the selected run via `azureRunChoices.find((c) => azureRunKey(c) ===
reloadSelect.value)` (key = `` `${briefId}::${runId}` ``), refusing with
    "Pick a run to delete first." when nothing is selected;
  - show a run-specific confirm, then call `deleteSidecarRun`;
  - **serialize with the load/auto-refresh path** by setting the shared
    `azureLoadInFlight` flag + `setAzureControlsEnabled(false)` for the duration
    (the 15s auto-poll and "Load sheet" both bail while it is set), so a delete
    can't race a reload of the same run into the local queue;
  - in `finally`, restore the button/flag/controls and call
    `refreshAzureRuns({ silent: true })` so the dropdown reconciles on **both**
    success and a stale-selection 404, without clobbering the status message.
  - Dropped the old queue-clobbering side effects; the destructive
    `workflow/store/clear` call is gone from the UI.
- **`tests/unit/devtools-sprite-approval-api.test.ts`** — 4 `deleteSidecarRun`
  tests: DELETE verb + exact URL, `%2F`-encoded ids, 404 error surfaced, 500
  non-JSON fallback.
- **`tests/unit/devtools-main-queued-generation-guards.test.ts`** — a second
  `it(...)` source-level regression guard (matching the file's existing
  source-assertion precedent — there is no jsdom/DOM harness or extractable seam
  for this monolithic `render()`): asserts the handler resolves the selected run,
  refuses empty selection, gates on `azureLoadInFlight`, and that the source no
  longer contains `workflow/store/clear` or `scope: 'all'`.

## Not touched (deliberately)

- `scripts/sprites/sidecar/server.ts` — the reused `DELETE
/api/runs/:briefId/:runId` (server.ts:1594) already does scoped single-run
  deletion (path-guarded via `safeJoin`, 404s on missing run, prunes the empty
  brief dir). The old destructive `POST /api/workflow/store/clear` (server.ts:1495)
  is left in place but is now **UI-orphaned**; a follow-up could remove or
  admin-gate it.

## Observe before done

This is a UI-wiring change with no runtime game pipeline. Verified via: the
`deleteSidecarRun` unit tests (exact DELETE verb/URL/encoding + error paths) and
the source-level regression guard proving the button resolves the selected run
and no longer calls the clear-all endpoint. `npm run verify:fast` green;
full `npm run verify` green (see below).

## Review harness

2🍎 → `plan_review` only. Ledger:
`docs/knowledge/review-ledgers/2026-07-03-delete-selected-run.review-ledger.json`
(validates clean). Plan review by **gpt-5.4** (rubber-duck, distinct from
implementer Opus 4.8) returned `approved_with_changes` with 3 concerns, all
adopted: (1) serialize delete with load/auto-refresh; (2) reconcile stale
selection after delete; (3) add a regression test at the rewire point.

## Follow-ups

- Consider removing or admin/CI-gating the now-orphaned `POST
/api/workflow/store/clear` endpoint.
- If a real DOM test harness is ever added for `devtools-main.ts`, promote the
  source-assertion regression guard into a controller-level handler test.
