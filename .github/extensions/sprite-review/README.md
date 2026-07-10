# sprite-review (canvas extension)

Read-only canvas viewer for approved / generated **sprite runs**: their source
sheets (with slice-map cell overlays) and per-variant **pipeline traces** (judge
scorecard + sensor results). This is the canvas-extension port of the
`sprite-review` DevTool page (`DEVTOOLS_PAGE_SPRITE_REVIEW` in
`src/devtools-main.ts`) — functional parity, not pixel parity. The monolith is left
untouched; this ships alongside it.

It is **Slice A** of the DevTool-canvas epic and doubles as the reference build for the
shared scaffold documented in [`scripts/canvas-harness/README.md`](../../../scripts/canvas-harness/README.md).

## What it shows

- A **run picker** (`briefId / runId (N variants)`), newest first — matches the
  monolith's auto-select of the latest run.
- The run's **source sheet(s)** rendered pixelated, with a **slice-map overlay** of cell
  boxes. When the sidecar reports a degraded map (`emptyCellsApplied === false`), cell
  boxes are labelled `seq N` and tinted yellow because the indices are sequential, **not**
  trustworthy variant indices.
- Per-**variant cards**: processed thumbnail, judge scorecard (style-match / brief-match /
  readability, each `×/5` + ✓/✗ + rationale, plus verdict + provenance), and sensor rows
  (✓/✗ + reason + pixel count).

All read-only. No approve/reject/regenerate — this is the viewer half of the pipeline.

A **Refresh** button in the toolbar re-pulls the run list + selected run from the
sidecar on demand, and a **busy indicator** (spinner + label) shows whenever the canvas
is calling/waiting on the sidecar or Azure — cold `/api/runs` (an Azure blob listing) and
the first fetch of a multi-MB sheet are the slow paths it surfaces.

## Data source

The only hard dependency is the **sprite sidecar**. The extension's loopback server
**proxies** it: the iframe only ever talks to `127.0.0.1:<port>`, and the server fetches
the sidecar server-side. Base URL resolution (`lib/sidecar-client.mjs` →
`resolveSidecarBaseUrl`) mirrors `src/shared/session-server-env.ts`:

1. `VITE_SPRITES_SIDECAR_BASE_URL` env override, else
2. the per-worktree deterministic port from `scripts/shared/session-server-ports.js`
   (what `npm run sprites:gallery` binds), else
3. the legacy `http://127.0.0.1:3010` fallback.

**Graceful degrade:** if the sidecar is down, the canvas renders a clear
"sidecar not running — start it with `npm run sprites:gallery`" panel. If the sidecar is
serving a _different_ checkout, it shows a wrong-repo panel with the expected repo root.
It never crashes and never blanks out.

**Outside-worktree image cache:** proxied images (sheets, processed thumbnails, raw
candidates) are cached on disk **outside the git worktree** — under
`$COPILOT_HOME/extensions/sprite-review/cache/` (`~/.copilot/…` by default) — so repeated
views and other worktrees don't re-download multi-MB sheets from Azure. The cache is
keyed by `[kind, briefId, runId, file]`, served with an `X-Cache: HIT|MISS` response
header, and is provided by the shared, never-throws `lib/image-cache.mjs`
(see the harness README). It fails safe: any cache error degrades to a direct pass-through
fetch, never an error.

Start the sidecar first:

```sh
npm run sprites:gallery   # auto-bootstraps Azure env, prints the sidecar URL
```

## Files

| File                     | Role                                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension.mjs`          | `createCanvas({ id: 'sprite-review' })`; per-instance server; image-proxy + JSON routes; never-throws `buildState`.                                                               |
| `renderer.mjs`           | `renderHtml(instanceId)` — the self-contained iframe document + SSE-driven client script.                                                                                         |
| `lib/sidecar-client.mjs` | Domain adapter: URL builders, normalizers, repo-aware health probe, `createSidecarClient` (injectable `fetchImpl`). Port of the monolith's `src/devtools/sprite-approval-api.ts`. |
| `lib/yaml-reader.mjs`    | fs reader for `plans/**/*.art.yaml` + `briefs/**/*.yaml` (reusable utility).                                                                                                      |
| `lib/canvas-harness.mjs` | **Vendored** generic server — do not hand-edit; see the harness README.                                                                                                           |
| `lib/image-cache.mjs`    | **Vendored** outside-worktree on-disk image cache (never-throws, path-traversal-safe, atomic writes) — do not hand-edit; see the harness README.                                  |
| `tests/*.test.mjs`       | Unit tests for the sidecar client, YAML reader, the vendored-harness drift guard, and the harness server contract.                                                                |

## Actions (agent/host facing, all read-only)

`list_runs`, `get_run`, `select_run`, `reload`. User-facing controls (run/sheet pickers)
live in the iframe and POST to the loopback server; `actions` exist for the agent/host.

## Develop / verify

```sh
node --test ".github/extensions/sprite-review/tests/*.test.mjs"   # unit tests
node scripts/canvas-harness/sync.mjs --check                       # harness drift guard
```

To view it live: start the sidecar (above), then `extensions_reload`, then open the
`sprite-review` canvas. If it fails to load, `extensions_manage({ operation: 'inspect',
name: 'sprite-review' })` prints the log tail (stdout is reserved for JSON-RPC, so all
logging goes through `session.log`).

The on-disk image cache lives at `~/.copilot/extensions/sprite-review/cache/` (honoring
`$COPILOT_HOME`); delete that directory to force a cold re-pull from Azure. It is **not**
inside the worktree, so it survives `git clean` and is shared across worktrees.
