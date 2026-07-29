# Handoff — 2026-06-26 pr2c-sensor-viz-force-judge (PR2c — FINAL PR of the PR2 7-stage epic)

## Date

2026-06-26

## Persona(s) adopted

**Producer** — multi-touch UI render + force-control wiring + unit tests + a
committed Playwright visual + a small store-robustness slice. No specialist
hand-off was needed; the work is a single coherent slice on top of merged
predecessors.

## Routing verdict

✅ right persona — Producer fit a UI-rendering-of-existing-data + tests + E2E
task that crosses devtools, the pure state module, and the store, with no new
backend or ECS system.

## Apples

Estimated: 🍎 x 3 <!-- declared before work began -->
Actual: 🍎 x 3
Verdict: 🎯 Exact — UI render of data that already persists + a force control
calling an already-merged backend + pure tests + one CI-safe Playwright visual +
a ~15-line atomic-write fix. The committable-E2E harness landed light (Vite lab
server already serves `devtools.html`; seeded `localStorage` renders
deterministically with the sidecar aborted), so it never pushed toward a 4.

Hello kitties: 3/5 = 0.60 🎀

## What Was Done

PR2c renders the per-sensor failure data that has flowed through queue state
since PR2a and adds the force-judge override on top of PR2b-2's Judge button.
**No new backend** — the `force` / `variantIndexes` judge endpoint shipped in
PR2a (#323) and is already tested.

### 1. wf-sensor-failure-visibility (render)

- **`src/devtools/sprite-workflow-queue.ts`** — added pure, DOM-free helpers
  (unit-testable without a browser):
  - `failingSensors(candidate)` — the `!ok` sensors, source order preserved.
  - `formatSensorResult(sensor)` — one-line label, e.g.
    `transparency: bg-not-transparent (1234px)` (reason + optional `pixelCount`
    magnitude hint); `silhouette: passed` when ok; falls back to `failed` when a
    failed sensor has no reason.
  - `SensorSummary` + `sensorSummary(candidate)` — `{ total, failed, failingLabels }`
    or `null` when `sensors[]` is empty (older runs) so the caller omits the block.
- **`src/devtools-main.ts`** `renderRunCandidates` — each variant card now shows a
  sensor block: `✓ N sensors passed` for clean variants, or `⚠ F/T sensors failed`
  with a scrollable list of `formatSensorResult` labels (with `title` tooltips) for
  gated variants.

### 2. wf-force-judge (override control)

- Refactored the Judge click handler into a shared
  `runJudge(opts: { force?, variantIndexes? })` that POSTs the flags to the
  existing endpoint. The plain Judge button calls `runJudge()` (no flags).
- **Per-run override** — a distinct orange **"Force judge"** button next to Judge
  (tooltip: "…ignores the sensor gate"). Hidden via `renderWorkflowSelection`
  unless `runHasSensorFailures(item.run)` AND a judge step is reachable
  (`postprocessed`/`variants`), so it never reads as the default path. Gated by a
  `window.confirm`. Calls `runJudge({ force: true })`.
- **Per-variant override** — a small **"Force judge variant"** button on each
  sensor-failed card (shown only while `judgeStageActive && candidateForceEligible`),
  calling `runJudge({ force: true, variantIndexes: [candidate.index] })`.
- Eligibility helpers (pure, tested): `candidateForceEligible(candidate)` (not
  combined-passed AND has a failing sensor) and `runHasSensorFailures(run)`.

### 3. Tests (all CI-safe — no Azure/LLM/vision)

- **Unit** `tests/unit/devtools-sprite-workflow-queue.test.ts` — +57→ helper specs
  covering `failingSensors`, `formatSensorResult` (4 cases), `sensorSummary`
  (null/all-pass/some-fail), `candidateForceEligible`, `runHasSensorFailures`.
- **Unit** `tests/unit/sprites/run-store.test.ts` — atomic-put specs: no `.tmp-*`
  orphan after success, overwrite replaces atomically, concurrent puts to distinct
  keys all land.
- **Committed Playwright visual** `tests/e2e/sprite-workflow-sensors.test.ts`
  (matches the existing `tests/e2e` chromium-headless pattern; shares the lab
  server from `global-setup.ts`). Seeds `localStorage[QUEUE_STORAGE_KEY]` with a
  run whose variant #0 fails two sensors, loads
  `devtools.html?page=sprite-generation-workflow`, **reloads** (exercising
  resume-after-refresh), and with **all `/api/**` aborted\*\* asserts (4 tests):
  1. sensor-failure detail text renders per variant
     (`transparency: bg-not-transparent (1234px)`, `edge-bleed: edge-halo`,
     `2/3 sensors failed`, `3 sensors passed`);
  2. both force controls are visible;
  3. the controls **POST the right payloads** — `{ force: true }` (run-level) and
     `{ force: true, variantIndexes: [0] }` (per-variant) — with the judge
     endpoint mocked (200 + empty summary). Proves the **wiring**, not just render.
  4. **Parity guard (mirrors PR2b-1 discipline):** the normal **Judge** button
     posts an **empty body** (`{}`) — NO `force` / `variantIndexes`. The shared
     `runJudge` refactor only ADDS the force option; the default judge call is
     byte-identical to PR2b-2 (server still applies the sensor gate).

### 4. Carry-forward disposition (epic closeout — see "Key Decisions")

- **Atomic `LocalRunStore.put`** — IMPLEMENTED (`scripts/sprites/store/local-store.ts`):
  write to a unique `.tmp-<pid>-<ts>-<counter>` then `renameSync` into place;
  cleanup-on-error. Crash-safe for the tolerant `loadRunSummary` reader.
- **Tolerant `loadRunSummary`** — already satisfied (has-check + try/catch → typed
  `RerunError` in `rerun.ts`). No change. Documented.
- **Stale `processed/NN.judge.json` on judge reset** — WON'T-FIX (cosmetic).
  Documented (see Key Decisions).

## What's Next

**The PR2 / 7-stage restructure epic is COMPLETE (PR2a → PR2c).** No follow-up
work item from this stack remains. The full operator flow now works end-to-end:

```
Synthesize → Choose → Generate (raw sheet only)
  → PostProcess (slice/bg-fix/resize → scored variants, re-runnable)
  → Judge (LLM, re-runnable; sensor-gated)  ──┐
      • per-variant sensor failures are visible (name · reason · pixelCount)
      • Force judge (run) / Force judge variant override the sensor gate
  → Approve (or "Approve anyway") → Tag
```

Possible _future_ (NOT PR2-stack, do not assume scope): concurrency for re-run
triggers (would make the atomic-put fix load-bearing rather than belt-and-braces);
a sweep of stale `processed/NN.judge.json` if a judge-reset UI is ever added.

## Blockers

None blocking the PR. One environment constraint applied to the **live-Azure**
evidence at first handoff — **now RESOLVED**: the live-Azure DoD was executed and
passed; see **"Validated against live Azure (DoD closed)"** below. The original
substitute-evidence write-up is retained for context:

- **Live-Azure E2E was not runnable in this worktree.** No Azure creds are present
  (`AZURE_OPENAI_*`, `OPENAI_API_KEY`, `AZURE_STORAGE_CONNECTION_STRING`, and
  `VITE_SPRITES_SIDECAR_BASE_URL` are all unset; no `.env`), and `npm run setup:azure`
  **provisions real cloud resources** (`-ProvisionResources -IncludeStorage`),
  which is not appropriate to run unattended on this shared box.
- **Substitute evidence (strong):** the committed Playwright spec drives a **real
  headless Chromium against the real Vite lab dev server** rendering the actual
  devtools UI from seeded state, and a full-page screenshot was captured
  (`session files/pr2c-sensor-evidence.png`). It shows the 7-stage stepper, the
  per-run **Force judge** button, variant #0 `⚠ 2/3 sensors failed →
transparency: bg-not-transparent (1234px) / edge-bleed: edge-halo` with a
  **Force judge variant** button, variant #1 `✓ 3 sensors passed`, and the
  "Sidecar unreachable" banner confirming a pure-render (no live backend) path.
  Because PR2c adds **no backend**, the only thing a live-Azure run would add over
  this is the network round-trip to PR2a's already-merged-and-tested force endpoint
  — which the committed payload-assertion test exercises against a mock.
- **DoD checklist → evidence map (1:1):**
  | User DoD step | Evidence (substitute) |
  | --- | --- |
  | generate a sheet | PR2b-1 (#337, merged) stores the raw sheet; the seeded run starts at the post-`Generate` `postprocessed` stage. Covered by PR2b-1's tests. |
  | re-run PostProcess **and** Judge on the STORED sheet WITHOUT regenerating | PR2a (#337/#323, merged) durable re-run endpoints + PR2b-2's PostProcess/Judge buttons. The seeded queue holds an already-post-processed run (no regenerate); the Judge button drives `/judge` directly (e2e test 4). |
  | sensor-failure detail visibly shows | e2e test 1 asserts `transparency: bg-not-transparent (1234px)`, `edge-bleed: edge-halo`, `2/3 sensors failed`; screenshot `pr2c-sensor-evidence.png` shows it rendered. |
  | force-judge past a failing sensor | e2e tests 2–3 assert both force controls are visible and POST `{force:true}` / `{force:true,variantIndexes:[0]}` to the (mocked) judge endpoint; screenshot shows the **Force judge** + **Force judge variant** buttons on the gated variant. |
  | resume-after-refresh persists | e2e `loadSeededDevtools` **reloads** the page and re-asserts the rendered detail from `localStorage` cache — the resume-after-refresh path, run for every test. |

  The only DoD nuance NOT executed against live Azure is the actual LLM verdict
  returned by a forced judge call — a PR2a concern (already merged + tested), and
  PR2c adds no backend, so the mocked-payload assertion is the correct seam here.

## Validated against live Azure (DoD closed)

**The live-Azure end-to-end DoD pass — originally deferred — was executed and
PASSED.** After the user authenticated Azure (`nalfeo@hotmail.com`, tenant
`81f46c6b…`, subscription `308f5463…`, "Visual Studio Enterprise"), this worktree
ran the minimal, cost-conscious live flow against **real Azure OpenAI**
(`gpt-image-1` generate + `gpt-4o` judge) with the run store on `azure-blob` and
the durable workflow-state round-tripping through Azure blob. All six DoD lines
were ticked with real artifacts, committed under
[`assets/2026-06-26-pr2c-live-azure/`](./assets/2026-06-26-pr2c-live-azure/).

- **Run under test:** `skull-mace / 2026-06-26T22-20-57-74f0559a` — 16 variants,
  5 with a real `anchor-derivable` sensor failure (variants 0, 1, 4, 8, 12).
- **Cost discipline:** exactly **1** `gpt-image-1` sheet (all 16 variants in one
  call) + **2** `gpt-4o` judge calls (one normal, one forced) ≈ well under $0.20.
  One generation only; PostProcess re-runs are local/free.

**DoD checklist → live-Azure evidence (1:1):**

| #   | User DoD step                                                        | Live-Azure evidence (committed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| --- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | generate a sheet                                                     | `POST /api/workflow/generate {briefPath:'briefs/weapons/skull-mace.yaml'}` → `200` in 56.5s; real `gpt-image-1` sheet stored to Azure blob. → `dod1-generate.json`                                                                                                                                                                                                                                                                                                                                                                           |
| 2   | re-run **PostProcess** on the STORED sheet WITHOUT regenerating      | `POST /api/runs/skull-mace/<runId>/postprocess {}` — no image call → 16 variants, 5 sensor failures detected. → `dod2-postprocess-sensor-summary.json`                                                                                                                                                                                                                                                                                                                                                                                       |
| 3   | re-run **Judge** on the STORED sheet WITHOUT regenerating            | `POST …/judge {variantIndexes:[2]}` (sensor-passing variant) → real `gpt-4o` scorecard (`modelDeployment:"gpt-4o"`). → `dod3-judge-passing.json`                                                                                                                                                                                                                                                                                                                                                                                             |
| 4   | sensor-failure detail visibly renders per variant                    | Real devtools UI (hydrated from durable Azure state) renders `⚠ 1/7 sensors failed → anchor-derivable: grip midpoint x=26 is outside ±3 of center 32` on each of the 5 failing cards (5 occurrences + 5 `⚠` asserted). → `dod4-5-sensor-detail-and-force-controls.png`, `dod4-5-6-playwright-ui-result.json`                                                                                                                                                                                                                                 |
| 5   | force-judge past a FAILING sensor                                    | **Gate held:** `POST …/judge {variantIndexes:[0]}` (variant 0 fails `anchor-derivable`) → `judgeSkipReason:'sensor-failed'`, no verdict (`dod5-judge-failing-gated.json`). **Override:** `POST …/judge {force:true,variantIndexes:[0]}` → real `gpt-4o` scorecard (style 2/brief 4/readability 3, `rejectedBy:["style_match"]`) despite `passed(sensors)=false` (`dod5-judge-failing-forced.json`). **UI:** run-level **Force judge** + per-variant **Force judge variant** buttons visible (`dod4-5-sensor-detail-and-force-controls.png`). |
| 6   | resume-after-refresh persists (durable Azure, not just localStorage) | With `localStorage` **empty**, the UI hydrated the run from `GET /api/workflow/state` (Azure blob). After `localStorage.clear()` + reload (verified still empty), the full run + sensor detail + judge chips re-rendered — sourced purely from durable Azure. → `dod6-resume-after-refresh.png`, `dod4-5-6-playwright-ui-result.json`                                                                                                                                                                                                        |

How it was driven (one-time, local, cost-conscious — never CI): a live sidecar on
this worktree's ports (`store=azure-blob`, `queue=noop` for inline generate) drove
DoD 1–3 and 5 via the sidecar HTTP API; a headless-Chromium Playwright pass
against the real `vite --mode devtools` server (which reads durable Azure state
through the loopback-CORS sidecar) captured DoD 4/6 and the UI side of DoD 5. The
committed CI-safe spec (`tests/e2e/sprite-workflow-sensors.test.ts`, 4/4) is
**unchanged** and remains the CI artifact — per Constitution §3 the live
vision/LLM run stays out of CI.

## Known follow-ups

- **Other non-PR2 future ideas** (do not assume scope): concurrency for re-run
  triggers (would make the atomic-`put` fix load-bearing rather than
  belt-and-braces); a sweep of stale `processed/NN.judge.json` if a judge-reset
  UI is ever added.

## Branch State

- Branch: `nalfeo-pr2c-sensor-viz-force-judge`
- All tests passing: yes — `verify:fast` green (174); full `verify` green except a
  CPU-contention wall-clock flake in the headless gate that passes 68/68 in
  isolation (see Test Results); lab-gate green
- PR created: see PR link in the session / coordinator update
- Commits (squash-merged):
  1. `feat(devtools): render sensor failures + force-judge override`
  2. `fix(sprites): make LocalRunStore.put atomic (temp-file + rename)`
  3. `test(e2e): assert force-judge override posts force/variantIndexes`
  4. `test(e2e): assert normal Judge posts no force flag (parity guard)`
  5. `docs(handoff): PR2c sensor-viz + force-judge; close PR2 7-stage epic`
- Live-Azure follow-up (separate branch off `main`,
  `nalfeo-pr2c-live-azure-evidence`): `docs(handoff): validate PR2c against live
Azure (DoD closed)` — upgrades the deferred live-Azure section above to
  **Validated against live Azure** and commits the real evidence bundle under
  `assets/2026-06-26-pr2c-live-azure/`. No code change; the CI-safe spec is
  untouched.

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — nothing to paste.

## Test Results

- `npm run verify:fast` — ✅ 174 unit tests pass (typecheck + lint + tests).
- `tests/e2e/sprite-workflow-sensors.test.ts` — ✅ 4/4 (chromium headless).
- `npm run verify` (full, 8 steps) — steps 1-6 (typecheck, lint, format,
  dead-code, unit+coverage 174✅, integration 49✅/1 skipped) and step 8 (vite
  build ✅) all pass. **Step 7 (headless Floor 1 gate) reported 2 failures under
  full-verify load** — `seed 3 · bow` (44.2s) and `seed 7 · baseball-bat` (38.5s)
  tripping the **30s wall-clock perf-regression guard**. These are
  **CPU-contention flakes, not a regression**:
  - The deterministic assertions for those same runs (`outcome = victory` and the
    game-time budget) **passed** — only the wall-clock guard tripped. The test's
    own comment: "Game-time above proves the run is correct; this proves it is not
    catastrophically slow."
  - PR2c changes touch **only devtools UI + sprite-store tooling + tests** — none
    of the game runtime / ECS / AI that the headless gate exercises.
  - **Re-ran `npx vitest run --project headless` in isolation → 68/68 pass**
    (160s vs 263s under load), including both previously-failing seeds. Proof it
    was host CPU contention (full-verify steps + a shared box), not my code.
  - CI runs the headless gate on its own runner step (no competing full-verify),
    and the gate already lives on main unchanged — so it is unaffected by PR2c.
- `bash scripts/agent/lab-gate-check.sh` — ✅ (no new ECS system added; all
  existing systems remain lab-covered).

## Key Decisions Made

No ADR added — PR2c is pure UI + tests + a self-contained store fix, no
cross-system decision. The two robustness carry-forwards (which rode the whole
PR2 stack as **ADR 0023 review-note lineage** — see ADR 0023
`rerunnable-postprocess-judge` §4 structured-per-sensor + the durable-store
review notes) are resolved here so the epic ends with no loose ends. All THREE
verdicts are recorded durably below:

1. **Atomic `LocalRunStore.put` — IMPLEMENTED.** Temp-file + `renameSync` is
   ~15 lines, zero API change, and `renameSync` overwrites atomically on the same
   filesystem cross-platform in Node. Even though force-judge is still
   busy-stage-gated/one-at-a-time (so concurrent re-run writes don't exist yet),
   it is cheap insurance against a torn `summary.json` from a crash mid-write, and
   pairs with the already-tolerant `loadRunSummary`. Temp orphans (crash-only) are
   filtered by every consumer (`SHEET_RE`, exact `summary.json` reads) so they are
   harmless. Backed by a unit test (`tests/unit/sprites/run-store.test.ts`).
2. **Tolerant `loadRunSummary` — ALREADY SATISFIED, no change, but verified to
   degrade gracefully end-to-end.** `loadRunSummary` (`rerun.ts:94`) has-checks
   the key (→ typed `RerunError('run-not-found')`) and wraps parse in try/catch
   (→ `RerunError('summary-invalid')`). The **caller path does NOT hard-crash**:
   the sidecar's `resolveRunForRerun` (`server.ts:559`) catches `RerunError` and
   returns a structured `{ status, body: { error, message } }` HTTP response; the
   devtools `fetchJson` rejects on `!res.ok`, and `runJudge`'s catch reverts the
   stage and shows `Judge failed: <message>` via `setWorkflowStatus` — a clean UI
   degrade, not a crash. With atomic `put` eliminating torn reads, the only live
   case is **missing-file** (`run-not-found`), which follows the exact same
   graceful path. Verified by reading both sides; no code change needed.
3. **Stale `processed/NN.judge.json` on judge reset — WON'T-FIX (cosmetic).**
   PR2c does not touch the PR2a re-postprocess reset path. `summary.json` is the
   authoritative record and re-judge overwrites/merges per variant index, so no
   reader trusts a stale per-variant judge sidecar. Sweeping them adds I/O and a
   new failure mode for zero correctness gain. Revisit only if a judge-reset UI is
   added that surfaces those files directly.

### Completed epic summary (PR2a → PR2c)

- **PR2a #323** (ADR 0023 `rerunnable-postprocess-judge`): durable, re-runnable
  PostProcess/Judge sidecar endpoints returning a full `summary` incl. structured
  per-sensor `candidates[].breakdown`; judge accepts `{ force?, variantIndexes? }`.
- **PR2b-1 #337** (ADR 0024 `generate-stores-raw-sheet-only`): Generate stores the
  raw sheet only (Option B).
- **PR2b-2 #340** (ADR 0025 `workflow-7-stage-restructure`): 7-stage state machine
  - devtools restructure; Promote dropped; Generate→PostProcess→Judge wired to the
    PR2a endpoints.
- **PR2c (this)**: renders the per-sensor failure detail, adds the force-judge
  override (run + per-variant), commits a CI-safe Playwright visual, and closes the
  two robustness carry-forwards. Epic done.
