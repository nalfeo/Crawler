# Session Handoff: postprocess debugger canvas extension (Slice C)

## Date

2026-07-09

## Persona

Producer → Tools/DevEx Engineer (canvas-extension port)

## Systems touched

devtools, sprite-workflow

## Apples

4🍎 estimated, 4🍎 actual (🎯 on estimate). Re-scored honestly after the
orchestrator confirmed read-only scope: read-only removes only mutation
_persistence_, but the 4🍎 core machinery (live browser-crop → POST relay,
sheet-slice canvas overlay ported from the monolith, per-instance loopback
server + graceful degrade) is fully present — so the tier held. Full harness
run: adversarial plan review + code-review loop + multi-model review with
adjudication + valid ledger.

## What Was Done

Slice C of the DevTool-canvas epic: a self-contained canvas extension that ports
the read-only `?page=postprocess` monolith DevTool (`renderPostprocessDebugger`,
`src/devtools-main.ts` ~4913), **alongside** the untouched monolith. Reuses the
Slice-A harness verbatim (`sync.mjs` vendored `canvas-harness.mjs` +
`image-cache.mjs`; copied `sidecar-client.mjs`).

- **`.github/extensions/postprocess/`** — `extension.mjs` + `renderer.mjs` +
  `lib/` + `tests/`. `createCanvas({ id: 'postprocess' })`; one loopback
  `http.createServer` per instance; the iframe talks only to
  `127.0.0.1:<port>` and the server **proxies the sprite sidecar**
  (run list / summary / sheets / slice-map / images) plus **relays a live
  postprocess POST** server-side. Functional parity with the monolith
  postprocess page: run/variant picker (latest auto-selected), source
  sheet(s), sheet-slice canvas overlay (dim + per-cell empty/selected/other
  rects + status line), live pipeline trace (before/after step cards) driven by
  adjustable background-tolerance knobs, pre-baked manifest fallback, read-only
  facing/anchor display.
- **`lib/slice-overlay.mjs`** (NEW, pure) — the sheet-slice overlay math
  (`computeOverlayScale`, `projectCell`, `resolveSelectedCell`, `isDegraded`,
  `buildSliceStatusText`, `hitTestCell`, …) ported verbatim from the monolith's
  overlay draw + `makeSelectedRawCellDataUrl`. Import/closure-free so it is
  `toString()`-serialized into the iframe client **and** unit-tested on the
  Node side — one source of truth for the trickiest parity piece.
- **`lib/postprocess-client.mjs`** (NEW, orchestration-only) — composes the
  injected `sidecarClient`. `relayLivePostprocess()` (never throws → returns
  `{ok:false,reason,message}` on any failure), `fetchPipelineManifest()`, pure
  helpers (`padVariant`, `clampTolerance`, `normalizePipelineManifest`), bg
  tolerance defaults (4000 / 12000) + max (255²·3).
- **Live-postprocess data path (revised by the adversarial plan review, the
  core subsystem fork):** the browser crops the active sheet at the selected
  cell bbox (from the slice-map) to a base64 PNG — matching the monolith's
  `makeSelectedRawCellDataUrl` pixel source — and POSTs it to
  `/api/live-postprocess`; the extension looks up the cached `briefPath` and
  relays to the sidecar `POST /api/postprocess {briefPath, rawPng,
options.background{colorToleranceSq,fringeToleranceSq}}` → `{finalPng,
steps[]}`. A monotonic `seq` token drops stale responses. Raw
  `/img/raw/<padded>.png` is the fallback when there is no sheet/cell or the
  slice-map is degraded.
- **Graceful degrade** for sidecar-down and wrong-repo (clear panels, never
  crashes/blanks), inherited from the harness.

### Observed on the REAL artifact (instance server, NOT a lab)

Instance loopback server `http://127.0.0.1:56193/` against the live sidecar
(worktree port 10030). Deterministic probes:

- **before** — monolith `npm run devtools` → `?page=postprocess` boots cleanly
  (Vite ready, serves the page) → confirms non-destructiveness (monolith
  untouched). Visual side-by-side was blocked by shared-box browser-MCP
  contention (both chrome-devtools + playwright locked by sibling overnight
  instances) — the prompt explicitly prefers deterministic checks, which are in
  force (see below).
- **after (buildState)** — `/api/state` → health `up`, `baseUrl`
  `http://127.0.0.1:10030`, 69 runs, auto-selected latest, full `selected`
  bundle, `sliceMap.ok cols×rows` cells, 8 manifest steps.
- **after (live SUCCESS)** — selected the committed-brief run
  `cactusfolk-elite-desert-capo-v1 / 2026-07-09T08-29-38-f3a6d0e8` via
  `/api/select` (exercises the Fix-2 single-delivery path), cropped its first
  non-empty cell (bbox 19,6,236,245) from `sheet-00.png`, POSTed
  `/api/live-postprocess` → **`ok:true, steps:8, finalPng 11016 chars`** with
  the exact monolith step IDs: `background-removal, background-enclosed-regions,
transparent-trim, resize-nearest, background-rekey, speckle-cleanup,
palette-quantize-skipped, alpha-threshold`.
- **after (graceful degrade)** — a run whose draft brief is absent from the
  worktree relays to the sidecar and correctly degrades to
  `{ok:false, reason:'postprocess-failed'}`; the renderer falls back to the
  pre-baked manifest (8 steps + `/img/processed` PNGs, 200) — same as the
  monolith. This failure is a **DATA condition (draft brief not checked in),
  not a code bug** — the relay reaches the sidecar and handles both shapes.
- **proxies** — `/img/sheet` 200 (1.7MB), `/img/processed` 200 (real step PNG).

### Deterministic parity checks (primary evidence, per prompt preference)

54 postprocess tests pass across 5 files: `slice-overlay.test.mjs` (ported
overlay math — scale/project/select/status/hit-test), `renderer.test.mjs`
(overlay-draw JS + step cards + escaping + slice-map-error text present),
`postprocess-client.test.mjs` (live relay happy/degraded contract + manifest
normalize + clamp/pad), `sidecar-client.test.mjs` (verbatim parity),
`harness-drift.test.mjs` (vendored libs match Slice A canonical). Glob appended
to `test:guards` in `package.json`.

## Review harness (4🍎, full)

- **Plan review** — adversarial (gpt-5.4), verdict `approved_with_changes`, 9
  concerns all resolved, `alternatives_considered: 3`, `plan_divergence:
major_fork` (the review re-architected the live-postprocess data path).
- **Code review + multi-model review** — 3 distinct models (gpt-5.4,
  gemini-3.1-pro-preview, claude-opus-4.7) at high effort against the staged
  diff; adjudicated by claude-opus-4.8. **4 valid fixes applied:**
  1. **[gpt-5.4 MAJOR]** `/api/select` did `pushState` **and** returned state →
     double-delivery → duplicate `render()` → a duplicate live
     `/api/postprocess` POST for sheet-less runs. Fix: dropped the SSE echo from
     `/api/select` (the in-iframe `select()` already renders the fetch
     response); SSE `pushState` reserved for external canvas actions only.
  2. **[gpt-5.4 minor]** `onClose` ignored `pendingStartups`, leaking the
     loopback server if the instance closed mid-startup. Fix: `onClose` awaits
     `pendingStartups.get(instanceId)` (catch → return) before teardown.
  3. **[gemini minor]** slice-map `ok:false` status text rendered
     "undefined×undefined grid". Fix: `redrawOverlay` now guards `sm.ok===false`
     → shows `sm.error || 'Failed to load slice map.'` (+ regression assertion).
  4. **[opus nit]** `readJsonBody` returned non-object JSON as-is → a bare
     `502` instead of a clean `400`. Fix: coerce non-object → `{}`.
     Adjudicator verified the 5 proxy/relay contracts + SSRF/path-traversal/
     seq-guard/toString-injection safety; no significant issues from opus.
- **Ledger** `docs/knowledge/review-ledgers/2026-07-09-devtool-canvas-postprocess.review-ledger.json`
  — `plan_review` + `code_review` + `multi_model_review` complete;
  `npm run review:ledger -- validate` exits 0.

## Key Decisions Made

- **Read-only inspection slice now; mutation is REQUIRED follow-up C2 (not a
  silent cut).** The monolith postprocess page's _mutating_ controls (anchor
  Apply/Reset, facing-write, apply-scope that persist to the run store) are part
  of full parity but are sequenced into C2 (mirrors Slice B's split), blocked on
  this PR. See the C2 enumeration below.
- **Judge/sensor panels omitted (faithful parity).** Those panels are the
  sprite-**workflow** gallery run-detail view (monolith ~4192–4373), not the
  `?page=postprocess` page. Slice B covers run inspection; porting them here
  would double-port. Orchestrator confirmed omit.
- **Overlay math is a pure dual-use module**, serialized to the client via
  `toString()` and unit-tested on the Node side — the parity-critical geometry
  has one source of truth.
- **Live input = browser sheet-crop, not always `/img/raw`** (plan-review
  major fork) — matches the monolith pixel source; raw is the degraded/no-cell
  fallback.
- **Compute behind POST, not GET** (`/api/live-postprocess`) with a stale-`seq`
  guard mirroring the monolith render tokens.
- **REPO_ROOT from `import.meta.url`, not `session.workspacePath`** — the
  load-bearing worktree trap; confirmed by the sidecar `repoRoot` matching the
  worktree exactly.

## C2 — Excluded mutating controls (for the orchestrator's follow-up brief)

All live on the monolith postprocess page (`renderPostprocessDebugger`,
`src/devtools-main.ts`). Persisted write =
`POST /api/runs/:briefId/:runId/postprocess` (line ~5729), body (~5733–5754):
`{ mode:'replace'|'reset', options.background.{colorToleranceSq,
fringeToleranceSq}, facing.{variantIndex,direction,applyToAllVariants?},
manualAnchor.{variantIndex,x,y,applyToAllVariants?}|null, variantIndexes? }`.
Controls mounted ~line 5698:

1. **"Apply changes"** — persists background tolerances + facing + manualAnchor
   to the run store (`mode:'replace'`).
2. **"Reset anchor"** — `mode:'reset'` clears the manual anchor.
3. **Anchor picker** — click the final image to set a manual anchor (~5649) +
   manual x/y number inputs.
4. **Facing direction select** — writes the variant's facing.
5. **Apply-scope select** — this-variant vs all-variants
   (`applyToAllVariants` / `variantIndexes`).

My read slice **previews** the background tolerances live (non-persisting, via
the live relay) but never persists; anchor + facing writes are entirely
excluded. ("Return to workflow" is navigation, not mutation.) C2 must add the
persist POST relay + these five controls to reach full postprocess parity.

## What's Next / Blockers

- **C2 (mutation slice)** — required follow-up, blocked on this PR. Add the
  persist-POST relay + the five controls above.
- **Coexistence window** — the ext lives alongside the monolith until all 5
  slices prove parity + the maintainer signs off; only then does the monolith
  retire. (The read-only/mutation coexistence footgun the plan review raised
  resolves at monolith retirement — a reason to sequence, not to drop.)
- **Live-success is data-gated, not code-gated** — any run whose brief is
  committed in the worktree traces live (observed with cactusfolk); runs with
  draft-only briefs degrade to the pre-baked path (also observed).

## Retrospective

### Lessons Learned

- The renderer wipes `#app` each render, so persistent chrome (toolbar/busy)
  must live in the HTML shell outside `#app` (Slice-A lesson, held here).
- `session.workspacePath` ≠ git worktree — derive REPO_ROOT from
  `import.meta.url` (3 `..` hops). Wrong root → wrong sidecar port → false
  "sidecar down".
- Any handler that both `pushState`s over SSE **and** returns the same state to
  an in-iframe fetch double-delivers → double render. Pick one channel per
  action; reserve SSE for _external_ mutations the iframe didn't initiate.
- `.github/extensions/**` is not eslint-linted, but `scripts/**/*.mjs` is — keep
  explicit `node:` global imports if touching scripts.

### Mistakes Made

- Ported the `/api/select` handler from a mental model where SSE was the only
  state channel, so I initially both pushed and returned — the multi-model
  review caught the resulting duplicate live POST. Early signal: any "publish
  **and** return the same payload" is a double-delivery smell.
- Left the slice-map `ok:false` status-text branch unguarded (canvas draw + crop
  were guarded) — a partial guard is a missed guard; guard every consumer of an
  optional field, not just the obvious one.

### Opportunities for Future Improvement

- A shared graceful-degrade panel renderer in the harness would stop B–E each
  re-implementing sidecar-down/wrong-repo states (carried from Slice A).
- The live sheet-crop is redone on every apply; caching the last crop keyed by
  `[sheetRunId,sheet,cell]` would cut redundant canvas work on tolerance tweaks.
