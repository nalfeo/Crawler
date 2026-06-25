# Session Handoff: Azure-backed sprite workflow-state persistence

## Date

2026-06-24

## Persona(s) adopted

**Producer** — the change spans the sidecar HTTP layer, the RunStore/Azure
storage abstraction, the DevTools client, unit tests, an ADR, and a full
real-Azure E2E. A single specialist lens (e.g. Tooling or Frontend) would have
missed one of those layers, so Producer coordinated end-to-end.

## Routing verdict

✅ right persona — multi-layer infra change with cross-cutting validation is
exactly the Producer's remit; no re-split was needed.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — scope landed as planned (Phase 1 + Phase 2 shipped, Phase 3
deferred as the designed-optional follow-up). The extra E2E effort
(dedicated-queue isolation, overlay force-click) was validation-only and
absorbed within the estimate.

Hello kitties: 4/5 = 0.80 🎀

## What Was Done

Moved the sprite-generation **workflow state** source of truth from the
browser (localStorage + local fs, both wiped by worktree checkpoints) to Azure,
via the sidecar and the existing `RunStore` blob abstraction. localStorage is
now a cache only. Reused the `generated-runs` container under a
`workflow-state/` key prefix — **no new infra**.

**Phase 1 — durable queue state** (commit `87b02a3`)

- New pure module `scripts/sprites/sidecar/workflow-state.ts`: `WORKFLOW_STATE_KEY`
  (`workflow-state/queue.json`), `computeStateEtag` (store-agnostic sha256
  content hash), `serializeWorkflowState`/`parseWorkflowState`,
  `etagPreconditionFails`.
- Sidecar `GET /api/workflow/state` → `{ state, etag }` and
  `PUT /api/workflow/state` (optional `If-Match`; `409 { error:'etag-conflict', etag }`
  on a stale precondition), both backed by the injected `store`.
- Client (`src/devtools-main.ts`): `hydrateQueueFromSidecar()` on load (sidecar is
  the source of truth; localStorage cache only when unreachable), debounced
  write-through in `writeQueueState()` with `If-Match` + single 409 re-GET/retry,
  and `resumeGeneratingPolls()` to restart run-polling for items left mid-flight.

**Phase 2 — durable draft briefs** (commit `dbdead5`)

- `WORKFLOW_BRIEFS_PREFIX` + `workflowBriefKey()` in the pure module.
- `mirrorBriefToStore()` / `materializeBriefFromStore()` in `server.ts` (both
  best-effort, never throw, guard `..` traversal).
- Wired into synthesize (mirror candidate YAML), promote-brief (re-materialize a
  wiped source, mirror the dest), and generate (re-materialize a wiped brief
  before 404) so a mid-flight generate survives a checkpoint wipe.

**Docs/tests**

- ADR `docs/knowledge/adr/0017-azure-workflow-state-persistence.md` (+ a
  Validation note summarising the E2E proof).
- 12 pure tests (`sidecar-workflow-state.test.ts`) + Phase-1/Phase-2 sidecar
  endpoint tests (`sidecar-server.test.ts`, via `app.inject()` against a
  `LocalRunStore` tmp dir + an azure-queue stub).

## E2E validation (real Azure, 10 sprites)

Driven headless with Playwright against **fully real Azure** — the `generated-runs`
blob store + the `asset-requests-e2e` queue + live `gpt-image-1` generation across
all 10 sprites. Every durability claim below was observed directly against the
blob, not mocked. Final state: **10/10 items durable at `variants`** in Azure.

- **Page-refresh resume (12×)**: every reload re-hydrated all 10 items + stages
  from `workflow-state/queue.json` — byte-identical each time.
- **Sidecar process-restart resume**: captured the state etag, killed the sidecar
  process, started a fresh one (empty memory) → GET returned the **identical**
  state with the **identical content-hash etag** — proving the source of truth is
  the blob, not process memory.
- **Auto-resume from `generating`**: items left mid-flight (stage `generating`
  with a `generationRequestedAt`) were re-hydrated by a fresh page whose
  run-polling found the matching Azure runs and rebuilt each `item.run` to
  `variants`.
- **Half-done switching**: with items deliberately regressed to mixed stages
  (`candidates` / `promoted` / `variants`), switching the selection across them
  resumed **each at its own distinct stage** and persisted the selection to Azure.
- **Phase-2 mirrors**: `workflow-state/briefs/**` held both the promoted draft
  YAML and the synth-candidate YAML; deleting the local fs draft and re-running
  generate re-materialised it from the blob.

### Vision/judge scoring honesty note

The persistence guarantee is **independent of vision scoring** — queue state
persists whether or not the judge runs. The final resume-proof cycles ran the
worker **vision-off** (`E2E_VISION=off`) because they were zero-cost state
manipulations (no regeneration), so the live `gpt-4o` judge did not execute during
those cycles. Earlier generation rounds did exercise real vision scoring.

### Drive-by bug fix: azure-blob judge sidecar path (now fixed in this PR)

While validating, I hit a latent crash that only manifests when the VLM judge runs
against a **non-local** store: `generate-one.ts` passed
`processedDir: store.resolve(storeKey('processed'))` to the judge, but for
`AzureBlobRunStore` `resolve()` returns a **blob URL**. `judge.ts` `writeSidecar`
does `writeFileSync(path.join(processedDir, 'NN.judge.json'))`, and
`path.join('https://…', 'file')` mangles the URL into a bogus CWD-relative path →
`ENOENT`. Fix: only pass `processedDir` when `store.backend === 'local'`. This
loses **no** judge data — `processedDir` is optional in `judge.ts` (omitted = skip
the standalone sidecar file) and the judge scorecard is independently embedded in
the run summary. Covered by a new deterministic regression test in
`tests/integration/judge-pipeline.test.ts` (`makeAzureLikeStore` reproduces the
blob-URL `resolve()` + `backend:'azure-blob'`). Per AGENTS.md rule #8 ("always fix
infra failures you encounter") this fix ships in this PR; a richer follow-up (route
the judge sidecar through `store.put` so azure runs keep the standalone artifact
too) is noted under What's Next.

Two **test-harness-only** issues were also found and worked around (no product
impact):

1. A **shared Azure queue** — another active session's worker was draining jobs
   from the default `asset-requests` queue. Isolated the E2E onto a dedicated
   `asset-requests-e2e` queue (sidecar + worker via `AZURE_STORAGE_QUEUE_NAME`).
2. The Playwright **Generate-run click** was obscured by the postprocess-debugger
   panel after the first generation; the driver force-clicks past the overlay.

## What's Next

- **Create the PR** and merge with `gh pr merge --auto --squash` once checks pass.
- **Richer judge-sidecar follow-up (optional)**: route the judge sidecar
  (`NN.judge.json`) through `store.put` so non-local (azure-blob) runs keep the
  standalone artifact too, instead of skipping it. The scorecard is already in the
  run summary, so this is an enhancement, not a correctness gap.
- **Phase 3 (optional follow-up)**: write-through the UI-prefs blob
  (`sprite-generation-workflow-state.v1`) and tighten the 409 conflict UX.
- Consider giving the real worker (`worker-cli.ts`) a vision provider — tracked
  separately as PR #274; this work does **not** depend on it.

## Blockers

None. (The shared-queue contention above is an environment artifact of running
two review sessions against one storage account, not a code issue.)

## Branch State

- Branch: `nalfeo-azure-workflow-state-persistence`
- All tests passing: yes (`npm run verify` + `lab-gate-check.sh` green)
- PR created: not yet (next step)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` not present this session — no telemetry section.

## Test Results

- `npm run verify:fast` — green after each change (typecheck + lint + 70 unit tests).
- `npm run verify` — full suite + build green.
- `tests/integration/judge-pipeline.test.ts` — 5/5 green, including the new
  azure-blob no-crash regression test for the judge-path fix.
- `scripts/agent/lab-gate-check.sh` — passed (no changes under `src/core/systems`
  or `src/labs`; this is sidecar + devtools infra, so no lab is required).

## Key Decisions Made

- **Content-hash ETag (sha256 of stored bytes)** instead of Azure-native blob
  ETags → store-agnostic, identical Local/Azure semantics, no `RunStore`
  interface change, unit-testable as a pure function.
- **Reuse `generated-runs`** under a `workflow-state/` prefix → zero new infra.
  `listRunsFromStore` only matches 3-part `…/summary.json` keys, so
  `workflow-state/*` never pollutes `/api/runs`.
- **Single GLOBAL queue blob** (`workflow-state/queue.json`) per the request's
  scope assumption — one team backlog, no per-session partitioning.
- **Cache-first, hydrate-after** keeps `render()` synchronous (instant first
  paint) while the sidecar is the source of truth once reachable.
