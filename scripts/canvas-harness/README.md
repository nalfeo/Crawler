# canvas-harness — the shared canvas-extension scaffold

This directory is the **single source of truth** for the boilerplate every Crawler
DevTool canvas extension is built on. The DevTools (sprite-generation-workflow,
postprocess, achievements, storage) are being rewritten from the
`src/devtools-main.ts` monolith into self-contained canvas extensions under
`.github/extensions/<tool>/`. Rather than let each one re-invent (and drift) its own
`http.createServer` + SSE + proxy plumbing — which is exactly what the pre-existing
extensions did — they all sit on top of this one harness.

`workflow` (the Sprite Generation Workflow canvas) is the reference implementation —
it absorbed the original `sprite-review` canvas's read-only run/variant-inspection
surface (Slice A) once its parity + live behavior were verified, so it is now the most
complete example to copy from. Slices C–E copy the model below.

## The three layers

A DevTool canvas extension is split into three cleanly-separated layers. Only the
first is truly shared verbatim; the other two are patterns.

| Layer                     | File                                    | Shared how                                                                                                             | Domain knowledge                               |
| ------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| **1. Generic harness**    | `canvas-harness.mjs`, `image-cache.mjs` | **Vendored byte-copy** into `<ext>/lib/` via `sync.mjs`; a drift test keeps copies identical                           | **None.** No sidecar, YAML, or tool specifics. |
| **2. Domain adapter**     | e.g. `workflow/lib/sidecar-client.mjs`  | **Copied + adapted** per tool (sprite tools can copy `sidecar-client.mjs` verbatim; non-sidecar tools write their own) | All of it — the tool's data source.            |
| **3. Reusable utilities** | e.g. `workflow/lib/yaml-reader.mjs`     | **Copied as-needed** (fs reader for `plans/` + `briefs/`)                                                              | A little (repo layout).                        |

Layer 1 is **two** canonical files today (`CANONICAL_FILES` in `sync.mjs`): the generic
server (`canvas-harness.mjs`) and the on-disk image cache (`image-cache.mjs`). Both are
vendored into every harness extension's `lib/`.

Why vendor layer 1 instead of a live `import '../../scripts/...'`? Canvas extensions
are meant to be self-contained directories (the `share_extension` / `install_extension`
gist flow operates per folder), so each keeps its own copy. `sync.mjs` + a drift test
give us single-source-of-truth semantics **without** a live cross-directory import that
would break portability.

## Layer 1: `canvas-harness.mjs` (generic server)

Zero domain knowledge. One loopback `http.Server` per open instance, bound to
`127.0.0.1:0`. It serves:

- `GET /` → `renderHtml(instanceId)` as `text/html`
- `GET /events` → Server-Sent Events; `pushState(state?)` broadcasts to every client
- `GET /api/state` → JSON of `buildState()`
- allowlisted **JSON routes** (`{ json, status?, headers? }`)
- allowlisted **binary routes** that relay an upstream `fetch` `Response` by
  **streaming** its body and preserving the upstream status + `Content-Type`
- never crashes: a throwing/timing-out handler is caught and turned into a controlled
  5xx, logged via the injected `log`

```js
import { startCanvasServer } from './lib/canvas-harness.mjs';

const { url, port, server, pushState, close } = await startCanvasServer({
  instanceId, // required
  renderHtml, // required: (instanceId) => htmlString
  buildState, // optional: () => (Promise of) view model, default {}
  jsonRoutes, // optional: HarnessRoute[] returning { json, status?, headers? }
  binaryRoutes, // optional: HarnessRoute[] returning a web Response (or { status, headers?, body })
  log, // optional: (message, level) => void  — MUST NOT write stdout
});
```

A `HarnessRoute` is `{ method?: 'GET', path: string | RegExp, handler: ({ req, res, url, instanceId }) => result }`.
`url` is a WHATWG `URL`, so read query params with `url.searchParams`.

There is **no generic `/proxy/*`**. Every upstream path a tool exposes is an explicit,
named, allowlisted route — that is the security boundary.

## Layer 1: `image-cache.mjs` (outside-worktree image cache)

Sidecar runs are timestamped and **immutable** — a `(kind, briefId, runId, file)` tuple
never changes its bytes — so proxied sheets/variants can be cached forever with no
invalidation. `image-cache.mjs` caches them on disk **outside any worktree**, under
`$COPILOT_HOME/extensions/<ext>/cache` (default `~/.copilot/...`), so every worktree on
the machine **shares** one cache and cold Azure pulls happen once per asset, ever.

```js
import { createImageCache, resolveExtCacheDir } from './lib/image-cache.mjs';

const imageCache = createImageCache({ dir: resolveExtCacheDir('<ext>'), log });

// In a binary route handler, replace `return fetch(target)` with:
const result = await imageCache.fetchThrough([kind, briefId, runId, file], () =>
  fetch(target, { cache: 'no-store' }),
);
if (result.response !== undefined) return result.response; // non-OK/bodyless: pass through
return { status: 200, headers: { 'Content-Type': result.contentType }, body: result.bytes };
```

Guarantees (all reused verbatim by B–E): **never throws** on the hot path (any invalid
key / fs error degrades to a cache miss → transparent pass-through); **path-traversal
safe** (strict segment charset **and** a resolved-under-root check); **atomic** writes
(temp + rename, `.ctype` sidecar renamed before the bytes so a reader never sees bytes
without a Content-Type); a **disabled** cache (no dir / unwritable) becomes a no-op
pass-through. Key = a `string[]` of safe path segments — put the immutable identifiers
(`kind`, `briefId`, `runId`, `file`) in it and nothing user-free-text.

## Loading + refresh UI (renderer pattern)

Two small renderer conventions the tools share:

- **Persistent toolbar.** If `render()` does `app.replaceChildren(...)`, it wipes
  everything under `#app` each render. Put durable controls (a **↻ Refresh** button, a
  **busy/loading** indicator) in the HTML shell **outside `#app`** so they survive
  re-render. See `workflow/renderer.mjs` `renderHtml()`.
- **Busy counter.** Track in-flight loads with an `inflight` counter and a `setBusy(on,
label)` that toggles the indicator + disables Refresh while `inflight > 0`. Wrap every
  `/api/state` load (`loadState()`) and selection fetch. This surfaces "waiting on Azure"
  during the cold sidecar/blob calls. Because images are immutably cached, Refresh need
  not bust the image cache.
- **Cache-first paint, background revalidate.** A tool that proxies a warmed remote
  resource (Workflow's sidecar-backed run view) should not force a blocking spinner just
  to re-confirm data it already rendered once. See `workflow/lib/run-view-cache.mjs`:
  replay the last-known-good view synchronously (`stale: true`) for any target already
  rendered once — module-wide, not per canvas instance, so a DIFFERENT open of the same
  target still paints instantly — and refresh it in the background, guarded by a
  selection/version check so a slow/late completion can never clobber a newer selection.
  Only a true cold miss (a target never rendered before) may block.

## Layer 2 + 3: domain adapter and utilities

`workflow/lib/sidecar-client.mjs` is the reference layer-2 adapter: URL builders,
response normalizers, a repo-aware health probe, and a `createSidecarClient({ baseUrl,
fetchImpl?, workspaceRoot? })` factory. **All I/O funnels through an injectable
`fetchImpl`** so it is fully unit-testable with a fake fetch and no live sidecar.

`workflow/lib/yaml-reader.mjs` is the reference layer-3 utility: an fs-based reader
for `plans/**/*.art.yaml` + `briefs/**/*.yaml`, replacing the monolith's build-time
`import.meta.glob` (which only works inside a Vite build).

## How to bootstrap a new tool

1. Scaffold the extension: `extensions_manage({ operation: "scaffold", kind: "canvas", name: "<tool>", location: "project" })`.
2. Vendor the harness into it:

   ```sh
   node scripts/canvas-harness/sync.mjs --to <tool>
   ```

   This creates `.github/extensions/<tool>/lib/canvas-harness.mjs` **and**
   `.github/extensions/<tool>/lib/image-cache.mjs` (every file in `CANONICAL_FILES`).

3. Copy the layer-2/3 files you need from `workflow/lib/` (sprite tools can copy
   `sidecar-client.mjs` as-is; everyone can copy `yaml-reader.mjs`). The relative import
   path to repo modules (`../../../../scripts/shared/...`) is **identical** for every
   extension, since all live at `.github/extensions/<name>/lib/`, so copies work unchanged.
4. Write `renderer.mjs` (`renderHtml(instanceId)`) and wire `extension.mjs` exactly like
   `workflow/extension.mjs`: resolve your data source, start one server per
   instance with your `buildState` + route table, keep a per-instance `Map`, make `open`
   idempotent, and clean up in `onClose`. **Log via `session.log`, never `console.log`
   (stdout is JSON-RPC).**
5. Add a drift test that calls `checkHarness()` (copy `workflow/tests/harness-drift.test.mjs`).
   Any `*.test.mjs` under `.github/extensions/` is discovered automatically by
   `npm run test:guards` — **do not** add it to `package.json`, which used to be the
   repo's worst merge-conflict hot spot when every new canvas edited the same line.

> **REPO_ROOT trap (bites every slice).** In the CLI worktree runtime,
> `session.workspacePath` resolves to the **session-state dir, not the git worktree** —
> using it derives the wrong per-worktree sidecar port and fails the repo-match health
> check. Derive the repo root from the file location instead: the ext lives at
> `<root>/.github/extensions/<name>/extension.mjs`, so
> `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..','..','..')` (three `..`
> hops) is the checkout the sidecar was launched from. See `workflow/extension.mjs`.

## `sync.mjs`

```sh
node scripts/canvas-harness/sync.mjs            # refresh every existing vendored copy
node scripts/canvas-harness/sync.mjs --to NAME  # create/refresh .github/extensions/NAME/lib copies
node scripts/canvas-harness/sync.mjs --check    # exit 1 if any copy drifted (used by the drift test)
```

`--to` takes an extension **NAME**, not a path (passing a path creates a bogus nested
`.github/extensions/.github/...` tree). It syncs **every** file in `CANONICAL_FILES`
(`canvas-harness.mjs`, `image-cache.mjs`) into each target's `lib/`. An extension is a
sync target iff it already vendors the anchor file (`canvas-harness.mjs`).

Exports (for tests / tooling): `REPO_ROOT`, `CANONICAL_FILES`, `CANONICAL_PATH` (the
anchor, back-compat), `listVendoredExtensions()`, `checkHarness()` →
`{ ok, checked: string[], drifted: { ext, file, reason }[] }`, `syncHarness({ to? })`.

**Never hand-edit a vendored `lib/` harness file.** Edit the canonical file here, then
re-run `sync.mjs`. The drift test (in each extension's `tests/`) fails CI otherwise.
