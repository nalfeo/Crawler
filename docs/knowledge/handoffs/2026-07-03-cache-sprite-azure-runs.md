# Handoff — Cache Azure runs in the sprite devtools so a reload paints instantly (2026-07-03)

## Systems touched

azure-infra

## Why

In the devtools sprite-generation UI, both run pickers — the Azure **"reload a
run"** dropdown and the **postprocess debugger** dropdown — start empty on every
page load/navigation and only populate after `GET /api/runs`
(`listRunsFromStore`, `scripts/sprites/sidecar/server.ts:~1895`) returns. That
endpoint does a `store.list('')` then a **sequential Azure blob GET per run
summary**, so with N runs it is N round-trips — a multi-second blank dropdown on
every reload before the operator can pick anything. The user asked for the runs
to be **cached** so a reload/navigation lets them pick immediately instead of
waiting for a whole refresh.

## What shipped

Applied the repo's existing "localStorage is an instant-first-paint cache; the
sidecar stays source of truth" pattern (already used for the workflow queue,
`writeQueueState`) to the run list. On load both dropdowns hydrate synchronously
from `localStorage`, then revalidate against the sidecar in the background. This
is **client-side** by design: runs are created out-of-band by the in-process
worker (no HTTP write hook), so a server-side write-through cache would go stale;
client caching also matches the "page reload" phrasing.

### Files

- **`src/devtools/sprite-run-cache.ts`** — NEW pure, DOM-free module (no Phaser,
  no `window`). Exports:
  - `RUN_CACHE_STORAGE_KEY` (`'crawler.devtools.sprite-run-cache.v1'`),
    `PromotedFilter`, `isPromotedFilter`, `normalizePromotedFilter` (invalid →
    `'all'`), `sanitizeRunEntry`.
  - `readRunCache(raw, filter)` → `SidecarRunListEntry[] | null` — **`null` means
    "never cached" (distinct from a cached empty list `[]`)** so a cold filter can
    show a loading placeholder instead of a wrong-filter list.
  - `writeRunCache(raw, filter, runs)` → merged serialized `{version:1,
byFilter:{…}}` envelope (per-filter, version- and shape-tolerant).
  - `resolveRunPickerSelection(previousKey, availableKeys, fallbackKey='')` —
    selection-restore priority: operator's in-progress pick → fallback
    (debugTarget) → none.
- **`src/devtools-main.ts`** — wired the cache into the `render()` IIFE:
  - Shared `readCachedRuns` / `writeCachedRuns` try/catch localStorage wrappers +
    an extracted `renderAzureRunOptions(runs, previousKey)` used by both the
    hydrate and network paths.
  - `refreshAzureRuns` now keys the fetch/cache by a captured
    `normalizePromotedFilter(reloadStateFilter.value)`, writes the cache **only on
    success** (never clobbers a good cache on failure), and preserves the
    operator's selection via `resolveRunPickerSelection`. Added
    `hydrateAzureRunsFromCache()` (paints the cached slot, status "Showing cached
    runs — refreshing…").
  - `loadSelectedAzureRun` bumps `++azureRefreshToken` so an in-flight refresh
    can't rebuild the dropdown mid-load, and on a `404` fires a silent
    `refreshAzureRuns` to reconcile a deleted/stale run.
  - The `reloadStateFilter` `change` handler paints the new filter's cached slot
    (incl. `[]`) or a "Loading runs…" placeholder before revalidating.
  - Debugger picker: `refreshDebuggerRuns({ background })` — a background
    revalidate with a usable cached list stays **quiet** (buttons live, options
    kept, selection preserved), writes the `'all'` cache on success. Added
    `hydrateDebuggerRunsFromCache()` (paints options, restores debugTarget, warms
    the variant cache via one blob GET). The Load handler is now async: if the
    variant cache is cold for the picked run it `await`s
    `loadDebuggerVariantOptions()` before pinning, so it can't load variant 0 by
    mistake.
  - Boot calls `hydrateDebuggerRunsFromCache()` + `refreshDebuggerRuns({
background:true })`, and `hydrateAzureRunsFromCache()` as the first line of the
    `if (showSpriteWorkflow)` block (paints during the short queue-sync gate).
- **`tests/unit/devtools-sprite-run-cache.test.ts`** — NEW, 37 tests: round-trip,
  per-filter merge, version/shape/malformed tolerance, `null`-vs-`[]`,
  `resolveRunPickerSelection` priority.
- **`tests/unit/devtools-main-run-cache-guards.test.ts`** — NEW, 10 source-level
  guards (the `render()` IIFE is not extractable and there is no jsdom/DOM
  harness — matches the existing precedent in
  `devtools-main-queued-generation-guards.test.ts`): import present, try/catch
  localStorage wrappers, both hydrate helpers called at boot, cache written only
  on success, and each of the 5 plan-review concern resolutions.

## Observe before done

Deterministic runtime observation in the **real devtools page** (`npm run
devtools` → Playwright, sidecar intentionally absent so only the cache path is
exercised):

- **Before** (cache cleared, reload `?page=sprite-generation-workflow`): both run
  pickers empty — Azure select `No runs available`, debugger select `[]`. Nothing
  pickable until the slow refresh.
- **After** (seed `localStorage` with 2 runs for filter `all`, reload): the Azure
  picker immediately shows `core-bestiary · run-aaaa1111 · judged · promoted · …`
  and `floor1-props · run-bbbb2222 · needs promotion · …`; the debugger picker
  shows `… (4 variants)` / `… (6 variants)` (variant counts from cached
  `candidateCount`) and auto-selects the first run — all **before any successful
  network call**. Console showed only `ERR_CONNECTION_REFUSED` to the absent
  sidecar (incl. the expected `GET /api/runs/core-bestiary/run-aaaa1111` variant
  warm-up), no JS errors. A failed background refresh kept the cached options
  (proving "failed fetch never clobbers a good cache").

`npm run verify:fast` green. Full `npm run verify` green (typecheck, lint,
format, guards, unit + integration, build; headless Floor-1 gate deferred to CI —
no `src/core`/`src/game/ai`/balance touched). `verify:pr-prereqs` shows the
ledger valid; the only prereq gate was this handoff.

## Review harness

2🍎 → `plan_review` only. Ledger:
`docs/knowledge/review-ledgers/2026-07-03-cache-sprite-azure-runs.review-ledger.json`
(validates clean). Plan review by **gpt-5.4** (rubber-duck, distinct from
implementer Opus 4.8): `approved_with_changes`, 6 concerns (2 blocking), **all 6
adopted**: (1) background refresh must not stomp the operator's in-progress
selection → capture+restore `previousKey`; (2) Load must resolve real variant
indices before pinning → async on-demand `loadDebuggerVariantOptions`; (3)
refresh-vs-load race → `++azureRefreshToken` on load; (4) per-filter cold slot →
render cached slot or "Loading runs…" on filter change; (5) stale/deleted cached
run → boot "refreshing…" status + silent 404 reconcile; (6) test the races →
pure `resolveRunPickerSelection` unit test + source guards.

## Follow-ups

- **Server-side caching of `/api/runs` is still open** — the real fix for the
  underlying N-sequential-blob-GET latency. Out of scope here (needs a
  cache-invalidation hook wired to the out-of-band run worker); this change makes
  the _reload_ instant but the first cold fetch is still slow.
- If a real DOM harness is ever added for `devtools-main.ts`, promote the
  source-string guards into controller-level handler tests.
