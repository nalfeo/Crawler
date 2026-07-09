# Session Handoff: sprite-generation-workflow canvas extension — READ slice (Slice B1)

## Date

2026-07-09

## Persona

Producer → Tools/DevEx Engineer (canvas-extension port)

## Systems touched

devtools, sprite-workflow

## Apples

3🍎 estimated (📉 **re-scored from 5🍎** at plan time — the full write-parity
workflow tool split into B1 read + B2 write; see below), 3🍎 actual. The shipped
read slice is genuine 3-apple machinery: an esbuild source-transform registry
loader, a path-traversal allowlist for YAML serving, and an async per-instance
image cache — not a trivial view.

## What Was Done

Slice B1 of the DevTool-canvas epic: the **read/browsing** half of the largest
DevTool, the `sprite-generation-workflow` page. Adds, **alongside** the untouched
monolith (`src/devtools-main.ts`, `devtools.html`, `src/devtools/*`), a
self-contained canvas extension that ports the three genuinely self-contained
read surfaces of `DEVTOOLS_PAGE_SPRITE_WORKFLOW`, reusing the Slice A canvas
harness (per-instance loopback HTTP server + SSE + outside-worktree image cache).

- **`.github/extensions/workflow/`** — canvas ext (`extension.mjs` +
  `renderer.mjs` + `lib/` + `tests/`). `createCanvas({ id: 'workflow' })`; one
  loopback `http.createServer` per instance; the iframe talks only to
  `127.0.0.1:<port>`; the server proxies the sprite sidecar and reads repo files.
  **9 read actions:** `get_backlog`, `list_plans`, `get_plan`, `list_briefs`,
  `get_brief`, `list_runs`, `get_run`, `select_run`, `reload`.
- **Surface 1 — asset backlog dashboard.** `lib/workflow-model.mjs` is a 1:1
  `.mjs` port of `art-plan-model.ts` + `art-plan-status.ts` (byte-verified
  faithful): reads `plans/**/*.art.yaml` + `briefs/**/*.yaml` (fs), the generated
  manifest (`public/assets/generated/manifest.json`), on-disk asset existence,
  and rolls up per-asset status + an **integration column**.
- **Surface 1 integration column is CONFIRMED REAL** (orchestrator condition 2).
  `lib/registry-ids.mjs` esbuild **transform-only** loads
  `src/engine/sprites/registry.ts` (`SPRITES`) + `src/shared/items.ts`
  (`ITEM_CATALOG`) — safe standalone because registry.ts's only import is
  `import type { SpriteAnchor }` (esbuild-erased) and items.ts is zero-import.
  Live: **24 sprite IDs + 123 item IDs, error=null**. The honest "unverified"
  degrade path is fallback-only and **never fires on the real repo**.
- **Surface 2 — plan/brief YAML browsing** via `lib/yaml-reader.mjs` (fs reader).
  Content is served through a **path-traversal allowlist**: the client only ever
  passes a `relPath` that must be present in the reader's enumerated set; we never
  join a client-controlled path to the repo root.
- **Surface 3 — run list + generation-output inspection.** `lib/sidecar-client.mjs`
  lists runs (incl. promoted), fetches normalized per-run summaries (variants:
  judge scorecard + sensor rows), sheets, and slice-map overlay; images stream
  through the shared **on-disk image cache** (`X-Cache: HIT|MISS`).
- **Graceful degrade** when the sidecar is down: `/api/state` returns
  `runs: []` with backlog + file browsing still fully rendered (both are fs-only)
  — never crashes, never blanks.
- **Tests (28, all pass):** `harness-drift` (vendored-file drift guard),
  `renderer` (3-surface assertions + `doesNotMatch` on removed Queue/Requests),
  `workflow-model`, `registry-ids`, `sidecar-client`. Glob appended to
  `test:guards` in `package.json`.

### Observed in the real canvas iframe (not a lab) — before/after

**Rule #10 real-artifact evidence**, live sidecar on worktree port 13070 (76 runs,
Azure blob store), canvas served at `127.0.0.1:52419`:

- **Backlog:** `get_backlog` → 12 plan reports, `integrationResolved: true`, states
  `integrated`(8) / `missing`(129) / `not-applicable`(9), **`approved-unverified: 0`**
  → integration column REAL, degrade never fired.
- **Plans/briefs:** `list_plans` → 12 real plans; `get_plan weapons.art.yaml` →
  full real YAML (allowlist works); `list_briefs` → 24 real briefs.
- **Run inspection:** `list_runs` → 76 runs; `get_run cactusfolk-elite-desert-capo-v1`
  → 16 candidates (each judge + **7 sensors**, normalized), 1 sheet (`sheet-00.png`),
  slice-map present; latest run auto-selected on reload.
- **Image cache end-to-end:** `GET /img/sheet?…file=sheet-00.png` → fetch 1
  `X-Cache: MISS` (1,710,075-byte PNG pulled Azure→disk), fetch 2 `X-Cache: HIT`
  (identical bytes from on-disk cache).
- **Graceful degrade:** sidecar-down `/api/state` → `runs: []`, `error` empty, no
  crash, backlog + files still render.
- **Trim confirmed at runtime:** `/api/state` top-level fields are
  `health, baseUrl, backlog, files, runs, selected` (+ `sheets, candidates,
sliceMap, autoSelectedLatest` once a run is selected) — **no `queue` / no
  `assetRequests`** field, confirming the B2 scope trim.
- **REPO_ROOT trap avoided:** live sidecar health showed `repoRoot === expectedRepoRoot`.

Side-by-side parity source: `npm run devtools` → `?page=sprite-generation-workflow`
(monolith) shows the same backlog / plan / brief / run / integration data.

## Scope split — B1 (this PR) vs B2 (mandatory follow-up)

Full write-parity (a 13-stage pipeline, 30+ mutating actions, a ~930-line queue
state machine, real Azure generation side effects) is not one reviewable/verifiable
PR. Orchestrator **approved** splitting READ (B1) from WRITE (B2) and **refined**
B1 to exactly the 3 self-contained read surfaces above — pulling the queue
(workflow-state) read and the asset-requests read into B2 so each status read
ships **paired with its start/stop/mutate controls** (a read-only orchestration
panel with no controls is a confusing half-feature).

**B2 is REQUIRED for the epic's "full parity" done-state — not dropped.** The
orchestrator is tracking it as a mandatory follow-up with its own session + apple
estimate + full review harness. B2 must deliver (confirmed against the live
sidecar route list — `POST` approve/synthesize/promote-brief/generate/metadata,
`GET`/`PUT` `/api/workflow/state`, worker/issues `start|stop|status`):

- **Queue state machine** (the ~930-line queue model) + **workflow-state read**
  (`GET /api/workflow/state`) and **write** (`PUT /api/workflow/state`).
- **Brief authoring:** `synthesize`, `promote-brief`, brief `save`.
- **Generation:** `generate` (trigger — confirm-guarded, expensive/Azure),
  `postprocess`, `judge`, `manual-anchor`.
- **Approval → checkin:** `approve`, `checkin`, `metadata` (write), `tag`.
- **Run lifecycle:** generation **polling + cancel**, **delete-run**.
- **Orchestration machinery + its paired status reads:** worker `start`/`stop` +
  worker status read; issues `start`/`stop` + issues status read;
  **asset-requests read**.
- **Session store:** `store` / `clear`.
- Confirms on every destructive/expensive action (esp. `generate`).

## Key Decisions Made

- **Split READ (B1) from WRITE (B2) at the read/write seam**, then trimmed B1 to
  3 self-contained read surfaces — pairing each orchestration status read with its
  controls in B2 rather than shipping a controls-less status panel. Re-scored
  5🍎 → 3🍎 honestly (score the machinery, not the file count).
- **Genuine-effort-before-degrade on the integration column** (orchestrator
  condition 2): esbuild transform-only of `registry.ts` + `items.ts` resolves to
  real IDs; the honest "unverified" fallback stays in as a path that never fires on
  the live repo (don't remove a correct degrade just because it's currently unused).
- **Path-traversal allowlist for YAML serving** — the client passes an enumerated
  `relPath` only; the server never joins a client string to the repo root.
- **Reused the Slice A harness verbatim** (`sync.mjs --to workflow` vendored
  `canvas-harness.mjs` + `image-cache.mjs`; copied `sidecar-client.mjs` +
  `yaml-reader.mjs`) with a drift test — no re-invented server/SSE/cache code.
- **REPO_ROOT from `import.meta.url`** (3 `..` hops), never `session.workspacePath`.

## What's Next / Blockers

- **B2 is the mandatory follow-up** — see the full enumeration above. The
  orchestrator spins it a dedicated session on B1 merge.
- **No blockers.** `npm run verify` passes all real gates (typecheck, lint,
  format, guards, unit + integration + sprite-pipeline, review-ledger valid).
  Headless Floor-1 (step 8) is CI-deferred by resource discipline and cannot be
  affected (gameplay-neutral tooling; `src/` untouched).
- **Non-destructive:** the monolith stays until all 5 slices prove parity + the
  maintainer signs off.

## Retrospective

### Lessons Learned

- `yaml-reader.mjs` (only lightly exercised by Slice A) held up under heavy use —
  12 plans + 24 briefs enumerated + served, allowlist-gated, no path bugs.
- The integration column is the one place the ext must reach into `src/**` TS; an
  esbuild **transform** (not bundle) is the right tool when the target file's only
  imports are type-only/none — no bundling risk, real data.
- `list_runs` (direct-query action) throws on sidecar-down by design; the iframe's
  `/api/state` (`buildState`) is the path that degrades gracefully. Both correct.
- A long-running background server piped through `| Select-Object -First N` can
  close its stdout pipe and detach/terminate the npm wrapper — the node child kept
  listening but the shell reported "completed". Launch servers plain-async or
  `detach:true`; never `Select-Object -First N` a live server.

### Mistakes Made

- Initially wrote `getStatic` as sync while `loadRegistryIds()` is async — caught
  in implementation; awaited all 7 call sites.

### Opportunities for Future Improvement

- A shared `graceful-degrade` panel renderer in the harness would stop B–E each
  re-implementing sidecar-down/wrong-repo states (carried over from Slice A).
- When B2 lands the queue/asset-requests reads, the `workflow-model` port could
  grow to cover the queue projection too, keeping one `.mjs` source of truth.

### Review round 3 (PR #990 — Copilot reviewer follow-up, 2026-07-09)

The `copilot-pull-request-reviewer` bot raised **15 threads** on the open PR. Each
was evaluated against the canonical source before acting (rule #12 — never
blind-resolve); all 15 were genuine and fixed:

- **[4][5]** `get_plan`/`get_brief` actions `readFileSync` had NO try/catch while
  the GET `fileContentRoute` did → wrapped both to throw a controlled
  `CanvasError('read_failed')` (parity with the route's graceful degrade).
- **[6][10]** `registry-ids` imported `esbuild` twice
  (`(await import).default ?? (await import)`) → import once, then pick
  `.default ?? namespace`.
- **[7]** renderer client `STATUS_ORDER` placed `approved-unverified` mid-list,
  contradicting the domain model's `ALL_STATUSES` (canvas-only degrade status
  sorts LAST) → moved last.
- **[8][9]** `yaml-reader` `walkFiles` fell back to `statSync` (follows symlinks)
  → a repo-controlled symlink under `plans/`/`briefs/` could escape root + be
  served. Now skips `entry.isSymbolicLink()` and uses `lstatSync` in the fallback.
- **[14]** `workflow-model` `promotedRunIds` keyed by only the last path segment
  (`split('/').pop()`); the canonical sidecar (`server.ts` `listPromotedRuns`,
  2460-2468) backslash-normalizes and keys by the last TWO segments
  (`<briefId>/<runId>`) → aligned model + the `extension.mjs` run-list consumer
  (`${run.briefId}/${run.runId}`). Added a Windows-backslash regression test.
- **[1][2][3][11][12][13][15]** cosmetic: stale `sprite-review` `@module`/hop
  comments in the vendored (NON-drift-tested) `yaml-reader.mjs`/`sidecar-client.mjs`
  → `workflow/*`; "Three hops" → "Four hops" in `registry-ids.test.mjs`.

The ext test suite caught a **real bug I introduced** mid-fix — a backtick around
`approved-unverified` in a renderer comment that sits inside a backtick template
literal, prematurely closing the client-script string (SyntaxError) — fixed to
plain text. Final: **29/29 ext tests** (was 28; +1 Windows-path test); `test:guards`
507/507. Ledger `code_review` round 3 recorded (15 concerns / 15 resolved, clean).

## Review round 4 (2026-07-09) — 2 further copilot-pull-request-reviewer threads

The reviewer re-reviewed the `ffb197ce` push and opened 2 more threads. Both
evaluated against source before acting (rule #12):

- **FIXED — renderer.mjs run filter token.** The client `runFilter` used the
  internal token `unpromoted` while the sidecar API + this ext's `list_runs`
  action enum both use `not-promoted`. Aligned all three renderer occurrences
  (init comment, `<select>` option token, client-side filter comparison) to
  `not-promoted`. Purely client-side filter (compares boolean `r.promoted`), so
  no behavior change today — removes the trap if ever plumbed into
  `/api/runs?promoted=`. No test referenced it; 29/29 ext tests still pass.
- **DISPOSITIONED (out-of-scope, drift-locked shared harness) — image-cache.mjs
  `put()` tmp-file cleanup.** On a mid-write failure the `catch` only logs, so
  orphan `.tmp-*` files can accumulate in the shared cache dir. GENUINE minor
  robustness gap, but `image-cache.mjs` is a **drift-locked CANONICAL harness
  file** (`CANONICAL_FILES=['canvas-harness.mjs','image-cache.mjs']`;
  `harness-drift.test.mjs` enforces byte-identity with
  `scripts/canvas-harness/image-cache.mjs` — verified byte-identical). It is
  Slice A's shared harness, vendored unchanged into EVERY sibling extension.
  Editing my copy breaks the drift guard; fixing canonical + re-vendoring is a
  cross-cutting shared-infra change to all sibling exts (and their in-flight
  PRs) that is explicitly outside B1's read-only scope. Resolved per convention
  (in-thread explanation) + flagged to the orchestrator as a **harness-maintenance
  follow-up** for the harness owner. Ledger `code_review` round 4 recorded
  (2 concerns / 2 resolved, clean).

## Review round 5 (2026-07-09) — get_run slice-map error-shape consistency

The reviewer re-reviewed the full PR on the `a0cf5566` push and flagged one more
consistency issue (on `extension.mjs`, which that push did not touch — it re-scans
the whole PR). Evaluated against source (rule #12):

- **FIXED — `get_run` slice-map degrade.** `get_run` returned `sliceMap = null` on
  a fetch failure (via `.catch(() => null)`), indistinguishable from the valid
  "no sheet" case (also `null`) and inconsistent with `buildState` (L278), which
  degrades the same failure to `{ ok:false, error }`. Aligned `get_run` to mirror
  `buildState` exactly, so `null` = no sheet, `{ ok:false, error }` = fetch failed,
  object = success — one representation across the MCP action and the iframe state
  builder. Proactively confirmed the other `get_run` degrade (`fetchSheets → []`)
  already matches `buildState`. No test asserts the shape; `node --check` clean;
  29/29 ext tests pass. Ledger `code_review` round 5 recorded (1 concern / 1 resolved).
