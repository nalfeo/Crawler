# Session Handoff: DevTool → canvas extension — Slice E (Azure storage lifecycle)

## Date

2026-07-09

## Persona

Producer → Tools Engineer (overnight epic child: DevTool→canvas parity, Slice E)

## Systems touched

devtools, sprite-workflow, azure-infra

## Apples

3🍎 estimated, 3🍎 actual (exact — plan MAJOR-fork + a full destructive-ops guard
module offset the harness-reuse savings; stayed inside the 3🍎 envelope).

## What Was Done

Ported the DevTools monolith storage page (`?page=storage`,
`renderStorageLifecyclePage` in `src/devtools-main.ts`) into a self-contained
canvas extension at `.github/extensions/storage/`, reusing the merged Slice-A
canvas harness (PR #975) via the 5-step recipe. Functional parity: list / search
/ archive / delete sprite-run blobs in Azure across `active` + `archive` scopes.
The monolith is left **untouched** — the extension lives alongside it until all 5
slices prove parity and the maintainer signs off.

Architecture (post-plan-review pivot): **client-authoritative + stateless proxy
routes**. The iframe owns scope/search/selection/sort exactly like the monolith;
the extension's http server is a set of stateless proxy routes to the sprite
sidecar's `/api/storage/*` endpoints (the same routes the monolith calls). A pure
DI module `lib/mutation-guard.mjs` (`decideMutation`) gates every destructive
request: token → body-read → key-validate → **re-probe sidecar health (409 if not
up)** → execute, each gate short-circuiting so a rejected request never probes
health or executes.

**Observed live against REAL Azure** (sidecar `http://127.0.0.1:7310`, store
`azure-blob`, queue `azure-queue`, repoRoot matched this worktree via the 3-hop
`import.meta.url` derivation). Read-only canvas actions demoed:

- **LIST** `active` — before: raw sidecar `/api/storage/runs?scope=active` = 75
  runs newest-first; after: ext `list_runs({scope:'active'})` returned the SAME 75
  runs, identical `briefId/runId/timestamp/summaryKey` (first 5 byte-match).
- **SEARCH** `beetlefolk` — 75 → 3 matching runs, newest-first (parity).
- **scope-switch** `archive` — 0 runs (matches raw sidecar count=0).
- **enrich** (two-phase) — returned exact monolith enrichment shape
  (`variantCount`, `sheetFile`, `approvedCount`, `firstApproved`, `briefStored`).

**Destructive ops verified WITHOUT deleting real blobs** (rule #12): the two
`window.confirm` strings byte-match the monolith —
`Archive N run(s)?` (renderer L453 == devtools-main L1435) and
`Permanently delete N run(s)? This cannot be undone.` (renderer L464 ==
devtools-main L1452) — archive stays ACTIVE-only, and there is **no** destructive
canvas action (archive/delete reachable only via the iframe confirm, never more
1-click than the monolith). Request shape + guard ordering proven by 53
deterministic tests, not by destroying data.

## Key Decisions Made

- **Client-authoritative over server-authoritative (plan MAJOR fork).** The gpt-5.4
  plan reviewer rejected the original server-state+SSE design (concerns B3/B4 —
  scope/search race). Reversed to mirror the monolith's client-owned state with
  stateless proxy routes; two-phase list→enrich became native. Recorded
  `plan_divergence = major_fork`.
- **Extract a pure `mutation-guard.mjs`.** Code-review R2 found the server
  destructive guards were untestable (extension.mjs has top-level `await
joinSession`, so it can't be test-imported). Extracted `decideMutation` + 4 gate
  helpers into an importable DI module → 19 spy-based tests prove the token →
  validate → health → execute ordering and every refusal path.
- **Server-enforced mutation intent token (strictly stricter, never easier).**
  Per-instance token minted into the iframe HTML, required as a header on
  `/api/archive` + `/api/delete`. The sidecar's own routes are unguarded, so this
  is strictly stronger than the monolith — honoring rule #12.

## What's Next / Blockers

- No blockers. `npm run verify` is green except the handoff gate (this file
  resolves it); review ledger validates (exit 0, 3-apple: plan_review +
  code_review). PR next, then arm `gh pr merge --auto --squash`.
- Follow-on: this is 1 of 5 DevTool→canvas slices. Parity sign-off + monolith
  retirement happens once all 5 land.

## Retrospective

### Lessons Learned

- The Slice-A harness reuse recipe works cleanly — `sync.mjs --to storage` +
  copying `sidecar-client.mjs` verbatim + the identical `../../../../` import path
  meant zero server/SSE/cache reinvention. The REPO_ROOT 3-hop
  (`path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..','..','..')`) is
  the load-bearing trap — it made `check_health` match the sidecar's per-worktree
  port on the first try.
- `.github/extensions/**` is neither eslint-linted nor tsc-typechecked, so
  **code-review is the only safety net** — the two R2 bugs (a `setBusy` leak on
  stale responses, and untested destructive guards) would have shipped green
  otherwise. For destructive-ops ports, loop code-review until genuinely clean.
- Cold-start Azure blob enumeration is slow (needed `curl --max-time 60`); archive
  scope is instant (empty). The sidecar startup banner's route list is ABBREVIATED
  (`/api/runs*` only) — `/api/storage/runs` returns 200 regardless; don't trust the
  banner for route discovery.

### Mistakes Made

- Shipped R1-clean code that R2 (a distinct model, claude-sonnet-4.6) caught two
  real Medium bugs in — a reminder that a single clean review round is not
  sufficient for a `.mjs` extension with no lint/type safety net. Early signal:
  any `reload()`-style stale-guard should place teardown (`setBusy(false)`) BEFORE
  the `if (seq !== requestSeq) return;` bail, or the busy counter leaks.
- Initially inlined the server destructive guards in `extension.mjs`, which made
  them untestable (top-level `await` blocks import). Extract safety-critical logic
  into a pure DI module from the start when the host file can't be imported.

### Opportunities for Future Improvement

- The four vendored harness files (`canvas-harness.mjs`, `image-cache.mjs`,
  `sidecar-client.mjs`, `harness-drift.test.mjs`) are byte-copied per extension;
  once 3+ slices exist, consider a shared symlink/package to cut drift risk beyond
  the `harness-drift.test.mjs` guard.
- A shared `mutation-guard`-style module could be lifted to the harness for any
  future destructive-ops slice, rather than re-derived per extension.
