# Session Handoff: sprite-review canvas extension + reusable canvas harness (Slice A)

## Date

2026-07-09

## Persona

Producer → Tools/DevEx Engineer (canvas-extension port)

## Systems touched

devtools, sprite-workflow, worktree-server

## Apples

3🍎 estimated, 4🍎 actual (📉 under — three mid-flight feature asks: loading status, refresh button, and an outside-worktree fs image cache, the last of which became a second canonical harness module + multi-model review).

## What Was Done

Slice A of the DevTool-canvas epic: the **pattern-proof + shared-harness slice** that unblocks slices B–E. Adds, **alongside** the untouched 7,609-line monolith (`src/devtools-main.ts`), a self-contained canvas extension that ports the read-only `sprite-review` DevTool page and extracts the reusable scaffold the other 4 slices copy.

- **`.github/extensions/sprite-review/`** — canvas ext (`extension.mjs` + `renderer.mjs` + `lib/` + `tests/`). `createCanvas({ id: 'sprite-review' })`; one loopback `http.createServer` per instance; the iframe talks only to `127.0.0.1:<port>` and the server **proxies the sprite sidecar** (run list/summary/sheets/slice-map/images). Functional parity with `DEVTOOLS_PAGE_SPRITE_REVIEW`: run picker (latest auto-selected), source sheet(s) with slice-map cell overlays (degraded `emptyCellsApplied===false` → yellow `seq N` boxes), per-variant judge scorecard + sensor rows. All read-only.
- **Reusable 2-file canonical harness** in `scripts/canvas-harness/`: `canvas-harness.mjs` (generic server/route-table/SSE `/events`/state/binary-relay/injected logger) + `image-cache.mjs` (outside-worktree on-disk image cache). `sync.mjs` vendors **both** (`CANONICAL_FILES`) into each ext's `lib/`; a per-ext drift test fails CI on divergence. Two READMEs document the 3-layer reuse model (generic harness / domain adapter / shared utility) + the REPO_ROOT trap.
- **Three mid-flight feature asks (all implemented + live-observed):** (1) **loading/busy indicator** — spinner + label whenever calling/waiting on the sidecar or Azure (cold `/api/runs` blob listing, first multi-MB sheet fetch); (2) **Refresh button** — re-pulls run list + selected run on demand; (3) **outside-worktree image cache** at `$COPILOT_HOME/extensions/sprite-review/cache/`, keyed `[kind,briefId,runId,file]`, served with `X-Cache: HIT|MISS`, never-throws, path-traversal-safe, atomic writes.
- **Graceful degrade** for sidecar-down (clear "start with `npm run sprites:gallery`" panel) and wrong-repo (distinct panel with expected repo root) — never crashes, never blanks.

**Observed in the real canvas iframe (not a lab)** against the live sidecar (worktree port 17790): before — monolith `devtools.html?page=sprite-review`; after — canvas auto-selected `panda-elite-red-envelope-v1` (sheet-00.png, 12 candidates, health UP), toolbar Refresh + busy "Loading from sidecar…" shown during load, cache populated 26 files (~2MB sheet), re-fetch returned `X-Cache: HIT`, Refresh → "Refreshing…" + disabled button. Screenshots: `files/sprite-review-canvas-live.png`, `files/sprite-review-features-live.png`, `files/sprite-review-monolith.png`.

## Key Decisions Made

- **Single source of truth + vendor-sync over copy-the-folder** (plan-review major fork). The 4 existing exts each hand-duplicate their server boilerplate — guaranteed to drift on the first bugfix. Chose one canonical dir (`scripts/canvas-harness/`) + `sync.mjs` + a drift test, rejecting both a live `../` cross-ext import (breaks per-folder portability) and manual copy (guarantees 5-way drift).
- **The image cache is a SECOND canonical harness file, not sprite-review-local.** B–E (esp. the workflow tool) also pull multi-MB images from Azure, so the cache belongs in the shared layer. Generalized `sync.mjs` to a `CANONICAL_FILES` list rather than special-casing.
- **Kept the declared tier at 3🍎 but ran multi-model code review anyway** as cheap insurance for the new fs-writing cache (path traversal / atomic writes / SSRF). The feature asks are refinements within the same read-only-canvas-proxy envelope, not a new system.
- **REPO_ROOT derived from `import.meta.url`, not `session.workspacePath`** — in the CLI worktree runtime `workspacePath` is the session-state dir, so it derives the wrong per-worktree sidecar port. This is the load-bearing gotcha for every sprite/worktree-server slice.

## What's Next / Blockers

- **Orchestrator drives B–E fan-out** once this is on main. Do NOT start the other 4 tools here.
- Slices B–E reuse: scaffold → `node scripts/canvas-harness/sync.mjs --to <name>` (vendors both canonical files) → copy `lib/sidecar-client.mjs` (sprite tools) / `lib/yaml-reader.mjs` (anyone) → wire `extension.mjs` like `sprite-review` → add the drift test + `tests/*.test.mjs` glob to `test:guards`.
- **Deferred parity gaps (none blocking):** read-only viewer only (no approve/reject/regenerate — matches the monolith's review page); no plans/briefs YAML surfaced in the UI yet (the reader helper exists and is unit-tested, needed heavily by B/workflow).

## Retrospective

### Lessons Learned

- `session.workspacePath` ≠ git worktree in the CLI runtime — derive repo root from `import.meta.url` (3 `..` hops from `.github/extensions/<name>/extension.mjs`). Wrong root → wrong deterministic sidecar port → false "sidecar down".
- `.github/extensions/**` is NOT eslint-linted, but `scripts/**/*.mjs` IS (bare recommended config): Node globals need explicit imports (`import process from 'node:process'`, `Buffer`, `randomBytes`). The canonical harness files must satisfy this even though their vendored copies don't get linted.
- The renderer wipes `#app` via `replaceChildren` each render, so persistent chrome (toolbar/busy/refresh) MUST live in the HTML shell **outside** `#app` or its listeners die on re-render.
- `node --test` needs a **glob** (`".../tests/*.test.mjs"`), not a directory path.
- `get_changes_overview` shows only tracked diffs — stage new files (`git add -A`) before trusting the overview.

### Mistakes Made

- Initially constructed the per-instance `instances` entry **before** `server.listen()` resolved, leaving a half-initialized entry a concurrent `open()` could read (major code-review finding). Early signal: any "publish state before the async resource is ready" pattern is a race — publish only after the resource is fully live (used a `pendingStartups` Promise map).
- First streamed the proxied image body with no `'error'` listener — a mid-stream sidecar/socket drop would crash the ext process (blocking finding). Early signal: any `pipe()`/stream relay needs an `'error'` handler that destroys and logs.
- Re-encoded non-2xx upstream responses as `text/plain`, dropping the upstream Content-Type (minor). Fixed to preserve upstream status + Content-Type on non-OK relays.

### Opportunities for Future Improvement

- The 2-file vendor-sync is low-friction but still N copies on disk; if the ext count grows past ~5, revisit a real shared package once the CLI supports ext-local `node_modules` resolution for first-party modules.
- A shared `graceful-degrade` panel renderer could be lifted into the harness so B–E don't each re-implement sidecar-down/wrong-repo states.
- The image cache has no eviction/TTL — fine for dev tooling, but a size cap would prevent unbounded growth for heavy sprite-workflow sessions.
