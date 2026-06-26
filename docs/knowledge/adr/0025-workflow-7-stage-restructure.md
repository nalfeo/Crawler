# ADR 0025: Devtools sprite workflow — 7-stage restructure, drop standalone Promote

## Status

Accepted

## Date

2026-06-26

## Estimated Complexity

🍎 x 4 — multi-module rewrite across a seam PR2a/PR2b-1 already built: the pure
state machine (`sprite-workflow-queue.ts`) plus the large devtools UI
(`devtools-main.ts`), the unit suite reworked + extended (38 → 41 tests), and this
ADR. No brand-new pipeline, subsystem, or lab — the PostProcess/Judge endpoints,
the `breakdown`/`sensors` data, and the `RawGenerateCandidate` shape already exist
(PR2a #323, PR2b-1 #337). This PR only restructures the stage machine and rewires
the UI onto those endpoints.

## Context

ADR 0023 (`rerunnable-postprocess-judge`) built durable, re-runnable PostProcess
and Judge sidecar endpoints (`POST /api/runs/:b/:r/postprocess` and `/judge`),
returning a full `summary` with structured per-sensor `candidates[].breakdown`.
ADR 0024 (`generate-stores-raw-sheet-only`, Option B) then made the **Generate**
stage produce and store the **raw sheet only** (`candidates: []`) — explicitly
leaving the devtools UI showing 0 candidates after a Generate as an interim
mid-stack state for PR2b-2 to rewire.

The pure state machine and the devtools UI still encoded the OLD 6-step model:

```
Synthesize → Choose → Promote → Generate → Approve → Tag
```

with `WORKFLOW_STAGES = draft, synthesizing, candidates, promoting, promoted,
generating, variants, approved, tagging, done`. Under Option B this is wrong:

- **Generate no longer yields scored variants** — it lands a sheet-only run, so
  the UI must have an explicit step that turns the stored sheet into variants.
- **PostProcess and Judge are first-class operator steps now** (re-runnable on the
  stored sheet without regenerating) but had no representation in the stage machine
  or UI — there were no buttons wired to the PR2a endpoints.
- **Promote was a redundant standalone step.** It only copied the chosen candidate
  YAML to a draft brief (`POST /api/workflow/promote-brief`) and set `briefPath`;
  it produced no artifact the operator needs to inspect between Choose and
  Generate.

## Decision

**Restructure the devtools sprite workflow to a 7-step model, drop the standalone
Promote step by folding promotion into Generate, and add explicit PostProcess and
Judge stages wired to the PR2a re-run endpoints.**

```
Synthesize → Choose → Generate → PostProcess → Judge → Approve → Tag
```

### 1. New `WorkflowStage` machine (`sprite-workflow-queue.ts`)

`WORKFLOW_STAGES` drops `promoting`/`promoted` and adds `sheet`, `postprocessing`,
`postprocessed`, `judging`:

| Stage            | Active step (label) | Busy? | Meaning                            |
| ---------------- | ------------------- | ----- | ---------------------------------- |
| `draft`          | 0 Synthesize        |       | new item                           |
| `synthesizing`   | 0 Synthesize        | ✓     | synth in flight                    |
| `candidates`     | 1 Choose            |       | choosing / chosen (pre-generate)   |
| `generating`     | 2 Generate          | ✓     | generate in flight                 |
| `sheet`          | 3 PostProcess       |       | raw sheet landed, `candidates: []` |
| `postprocessing` | 3 PostProcess       | ✓     | postprocess in flight              |
| `postprocessed`  | 4 Judge             |       | variants stored, not yet judged    |
| `judging`        | 4 Judge             | ✓     | judge in flight                    |
| `variants`       | 5 Approve           |       | judged — pick winner               |
| `approved`       | 6 Tag               |       | approved into catalog              |
| `tagging`        | 6 Tag               | ✓     | metadata in flight                 |
| `done`           | 7 (all done)        |       | terminal                           |

`STEP_LABELS` is now the 7-entry list above (`done === 7` in `STAGE_ACTIVE_STEP`,
was 6). `BUSY_STAGES = synthesizing, generating, postprocessing, judging, tagging`
(drops `promoting`). `primaryActionLabel`: `candidates` → "Generate run", `sheet` →
"PostProcess", `postprocessed` → "Judge". `stepperFor` / `STAGE_ACTIVE_STEP` /
`isBusyStage` are pure and fully unit-covered.

### 2. Drop standalone Promote — fold into Generate

The Promote button, its handler, and the `promoting`/`promoted` badges are removed.
The `POST /api/workflow/promote-brief` call moves **into the Generate handler**:
when an item has no promoted draft brief yet (`item.briefPath === null`), Generate
promotes the chosen candidate first (sets `briefPath`, adds the draft-brief key,
`void recompute()`), then generates the raw sheet from it. So **Choose → Generate**
replaces **Choose → Promote → Generate** with no loss of behaviour — the same draft
brief is written, one click earlier in the flow.

### 3. Generate lands a sheet-only run

`applyGeneratedRunToQueue` is generalised into `applyRunToQueue(itemId, briefId,
runId, candidates, opts)` (stage + status + optional `resetApproval`). Generate now
targets stage `sheet` and stores the `run` even with `candidates: []` (both the
synchronous and the queued/worker poll paths). Generate is reachable **only from
`candidates`** (with a chosen candidate); a fresh sheet ("re-roll") is reached by
re-Choosing, which already resets `briefPath`/`run`. This drops the old
re-generate-from-`variants` path, so cancel/error reset collapses to a single
`candidates` target — iterating on an existing sheet is now done via the
re-runnable PostProcess/Judge steps, which is the entire point of the Option B
split.

### 4. PostProcess + Judge buttons wired to PR2a endpoints

Two new buttons call the existing PR2a endpoints and merge the returned full
`summary.candidates` back into queue state via the **unchanged** `toWorkflowRunState`
mapper (preserving `judge` **and** `sensors`/`breakdown` — PR2c renders them):

- **PostProcess** (`POST /api/runs/:b/:r/postprocess`): `sheet` → `postprocessed`;
  re-runnable from `postprocessed`/`variants` (a re-postprocess resets judge
  verdicts, landing back on `postprocessed`). Populates `candidates`.
- **Judge** (`POST /api/runs/:b/:r/judge`): `postprocessed`/`variants` →
  `variants`. Gated behind PostProcess (only enabled once `run.candidates.length >
0`) because it needs the stored `processed/NN.png`. Refused in CI (403) and 400
  with no vision provider — both surface via the standard `fetchJson` error path,
  which restores the prior stage.

Both handlers gate on the per-item busy stage (`postprocessing`/`judging`), so a
re-run cannot be triggered concurrently for the same item.

### 5. Stage-aware run-candidates panel

`renderRunCandidates` branches on run contents: **0 candidates** → "raw sheet
stored, no variants yet" + a PostProcess hint (early return); **post-processed but
not judged** (`!ranked.some(c => c.judge !== null)`) → "N variant(s) post-processed,
not yet judged" + "Judge to rank, or Approve directly"; **judged** → the existing
"N/M pass the judge" title. The per-card status label distinguishes `sensor fail`
(no judge verdict yet) from `judge fail`.

## Consequences

### Positive

- The devtools workflow now matches the Option B product model end to end: Generate
  → PostProcess → Judge are explicit, and the re-runnable PostProcess/Judge steps
  are the iteration path on a stored sheet (no regeneration needed to retry
  slicing/judging).
- One fewer click and one fewer stage: promotion is invisible plumbing folded into
  Generate, removing a step that produced nothing the operator inspects.
- `sensors`/`breakdown` continue to flow through queue state untouched, so PR2c can
  render per-sensor failures on top of this restructure without backend changes.
- The state machine stays pure and fully unit-tested (41 tests), so the 6→7
  transition is validated independently of the DOM-heavy UI.

### Negative

- Re-rolling a fresh sheet now requires re-Choosing rather than clicking Generate
  again from `variants`. This is intentional (the re-run endpoints are the
  iteration path), but it is a behaviour change for anyone used to the old
  regenerate-from-variants affordance.
- `devtools-main.ts` grows two more async handlers and a stage-aware render branch;
  it remains a large single entry file (no DOM unit tests), so its coverage is
  indirect — the pure machine carries the test weight.

### Risks

- Judge depends on PostProcess having written `processed/NN.png`. The UI gates the
  Judge button on `run.candidates.length > 0`, but a manually-edited persisted
  state could in principle reach Judge without processed sprites; the endpoint
  returns an error in that case, surfaced via the standard error path.
- PostProcess/Judge are triggered one-at-a-time per item via busy-stage gating, so
  PR2a's atomic-write / tolerant-load carry-forward (relevant only under concurrent
  re-run triggering) stays **deferred to PR2c** — noted in the handoff.

## Alternatives Considered

- **Keep a standalone Promote stage/button.** Rejected — it produces no operator-
  inspectable artifact between Choose and Generate; folding it into Generate
  removes a click without losing the draft-brief write.
- **Keep regenerate-from-`variants`.** Rejected — under Option B the re-runnable
  PostProcess/Judge endpoints are the iteration path on a stored sheet; a second
  "regenerate over an existing run" affordance would multiply the reset/cancel
  target stages for no product gain. Re-Choosing is the explicit "start over" path.
- **Split this into a state-machine-only PR and a UI PR.** Rejected — `STEP_LABELS`
  and the `WorkflowStage` union are compile-coupled to the UI's `STAGE_BADGES`,
  button enablement, and reset targets, so a machine-only PR would leave `verify`
  red with no green intermediate. The two layers must co-land.
- **Render per-sensor failures and add a force-judge button here.** Deferred to
  PR2c — the data (`breakdown`) and the `force` backend already exist from PR2a;
  this PR keeps them flowing through state without rendering them, to keep the
  restructure reviewable.
