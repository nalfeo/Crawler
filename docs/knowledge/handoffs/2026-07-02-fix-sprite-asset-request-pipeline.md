# Session Handoff: Fix sprite asset-request pipeline (poison-loop + bad-grid slice mismatch)

## Date

2026-07-02

## Persona(s) adopted

**Producer** — the task spans two coupled layers (the queue↔worker failure contract in
`scripts/sprites/queue/*` + `worker.ts`, and the generation prompt in `build-prompt.ts`), needs an
ADR, and drives the full apple-scaled review harness. That is Producer territory (multi-system,
ambiguous root cause, coordination of review models) rather than a single specialist.

## Routing verdict

✅ right persona — the work genuinely touched two systems plus an ADR and a 4-stage review harness;
a single specialist persona would have under-served either the infra contract or the generation fix.

## Apples

Estimated: 🍎 x 4 <!-- declared before work began -->
Actual: 🍎 x 4
Verdict: 🎯 Exact — multi-system contract change (queue + worker) coupled with a prompt fix, an ADR,
deterministic tests across 5 files, and the full 4-stage review harness (dual-plan synthesis, plan
review, code-review loop, multi-model review). Landed squarely where estimated.

Hello kitties: 4/5 = 0.80 🎀

## Systems touched

quests

## Review Harness

Ledger: `docs/knowledge/review-ledgers/2026-07-02-fix-sprite-asset-request-pipeline.review-ledger.json`
Stages (4-apple tier): plan_review ✅ · dual_plan_synthesis ✅ · code_review ✅ · multi_model_review ✅
`npm run review:ledger -- validate <path>` → **valid 4-apple ledger**.

- **dual_plan_synthesis:** plans from gpt-5.5 + gemini-3.1-pro-preview, judged/synthesized by
  claude-opus-4.8. Converged on dequeueCount-gated poison handling + prompt-gutter fix; rejected a
  durable store-marker/fingerprint design as over-engineered (recorded as an ADR alternative).
- **plan_review:** gpt-5.4 reviewed the synthesized plan; 6/6 concerns adopted (honest at-most-once
  framing, permanent/transient classifier via `err.kind` duck-typing, anti-loop test via a
  resurfacing-queue fake, gutter thin-but-continuous wording, faithful 8-cell fixture).
- **code_review + multi_model_review:** 3 distinct-model reviewers (gpt-5.5, gemini-3.1-pro-preview,
  claude-opus-4.8) on the branch diff surfaced **5 valid concerns** (all adjudicated by opus-4.8, all
  resolved), then a **confirmatory round** (gpt-5.5 + gemini) returned "No material concerns — fixes
  verified correct", closing the loop clean.

## What Was Done

Two coupled, actively-harmful bugs fixed end-to-end.

### Bug A — poison-message loop + comment spam (worker failure contract)

`scripts/sprites/worker.ts` previously never ack'd a message on failure, relying on the Azure
visibility timeout for a "natural retry". For a **deterministic** failure that was an unbounded-cost
poison loop (full gpt-4o + gpt-image-1 pipeline every ~3 min) that also posted a "⚠️ pipeline failed"
issue comment on **every** retry (issue #555 accrued 12).

- `scripts/sprites/queue/types.ts`: added required `readonly dequeueCount: number` to
  `DequeuedMessage` (forces every backend to participate in poison handling).
- `scripts/sprites/queue/azure-queue.ts`: surfaces Azure's native `dequeueCount` (`?? 1`).
- `scripts/sprites/worker.ts`: `MAX_DEQUEUE_ATTEMPTS = 3`; `PERMANENT_FAILURE_KINDS =
{auth, bad-grid, non-png}` classified by duck-typing `err.kind`; `giveUp = permanent ||
dequeueCount >= MAX`. On give-up the worker **acks first, then comments only if the ack succeeded**
  (`dropped === true`) → true at-most-once even across an ack failure; the failure comment moved OUT
  of `runIssueRequest` into the single gated give-up branch. `WorkerStatus.error` gained optional
  `dropped?: boolean` for observability/tests.
- `scripts/sprites/issue-pipeline.ts`: added `postProgressComments` option (default true); the worker
  passes `dequeueCount <= 1` so the 3 intermediate progress comments (🧪/🧠/📌) are suppressed on
  redeliveries while the terminal ✅ and give-up ⚠️ always post.

### Bug B — bad-grid slice-gate mismatch (prompt-only fix, honest 16-cell target kept)

The content-aware slicer (`slice-sheet.ts`) infers cells from background bands. The character/enemy
prompt permitted touching columns, so 4 columns collapsed to 2 → a 4×4 sheet sliced to 8 cells,
tripping the exact-16 gate at `generate-one.ts:212`.

- `scripts/sprites/build-prompt.ts`: `sheetConstraintsBlock` now mandates a four-side background
  margin for character/enemy; `sheetLayoutBlock` (gated to `brief.type !== 'tile'`) requires a
  uniform background gutter between every adjacent row AND column. The exact-16 gate and the slicer
  are **unchanged** (repo rules #12/#13 — target stays an honest 16).

### Tests (deterministic, fake/local providers — never live Azure)

- `tests/unit/sprites/slice-sheet.test.ts`: gutter sheet → 16 cells; touching-column sheet → 8
  (proves the root cause without changing the slicer).
- `tests/unit/sprites/build-prompt.test.ts`: character prompt contains the gutter language and no
  longer permits touching columns; still says exactly 16 / 4 rows / 4 columns.
- `tests/integration/generate-one.test.ts`: a 4×4/16 sheet passes the exact-16 gate.
- `tests/unit/sprites/worker.test.ts`: permanent-drop, transient-no-comment, cap-drop, brief-path
  silent-drop, resurfacing anti-loop, first-delivery permanent drop, and a new **ack-failure** case
  (give-up ack throws once → no comment, resurfaces, next delivery acks → comment exactly once).
- `tests/unit/sprites/issue-pipeline.test.ts`: default posts all progress + terminal comments;
  `postProgressComments:false` suppresses the 3 progress comments but keeps the terminal ✅.

### ADR

`docs/knowledge/adr/0037-sprite-worker-poison-message-handling.md` (registered in the ADR README) —
documents the dequeueCount-gated bounded-failure contract, ack-first/comment-only-if-dropped
at-most-once guarantee, progress-comment suppression, and the rejected store-marker / DLQ
alternatives.

## What's Next

- Open the PR (holistic title covering **both** bugs; justify the honest 16 target). Do **not** arm
  auto-merge unless gates are green.
- A **sibling subsession** owns the issue-body **parser** fix (unparseable multi-sentence briefs) in
  `scripts/sprites/asset-request.ts` / the ingester — out of scope here; coordinate before merge if
  both PRs touch overlapping brief flows (they should not).
- Optional future: a real dead-letter sub-queue (deferred in ADR 0037) if operators want to inspect
  dropped messages rather than re-request.

## Blockers

None blocking. One flaky-signal note: the `npm run verify` headless perf guard
(`floor1-completion.test.ts` "wall-time budget") flaked once (seed 2 · sword 156.5s > 150s) **only
when two `verify` runs collided on CPU** — it passed cleanly (17/17) in the non-contended run. It is
a coarse wall-clock blowup guard unrelated to the sprite-script changes (different code paths). Run
`verify` as a **single** process to avoid the false positive.

## Branch State

- Branch: `nalfeo-fix-sprite-asset-request-pipeline`
- All tests passing: yes (unit 2859, integration 50/1-skip, headless 17/17 non-contended; a final
  clean single-process `npm run verify` should be run before merge to capture step 10 build green)
- PR created: no (opening after this handoff is staged so `verify:pr-prereqs` passes)

## Agent-OS Telemetry

`files/guard-telemetry.jsonl` does not exist this session — no guard-telemetry section to paste.

## Test Results

- `npm run verify:fast` → ✅ 198 unit tests (10 files), typecheck + lint clean.
- Heavy suite: unit **2859 passed** (248 files); integration **50 passed / 1 skipped**; headless
  **17/17** (non-contended run); `vite build` exit 0 (verified standalone earlier).
- `verify:pr-prereqs` → review-ledger ✅ valid; the only gate was "no handoff file", satisfied by this
  file.
- Ledger: `npm run review:ledger -- validate …` → valid 4-apple ledger.

## Key Decisions Made

- **At-most-once, not durable exactly-once.** dequeueCount + ack-first/comment-only-if-dropped
  satisfies the task's "at most once" requirement without a new durable-state dependency; a
  store-marker/fingerprint was rejected as over-engineered (ADR 0037).
- **Honest 16-cell target kept.** Fixed the model's grid via the prompt (background gutters) instead
  of loosening the gate or lowering the expected count (repo rules #12/#13).
- **`bad-grid`/`non-png` classified permanent** even though they are retried in-run by
  `generateSheetCore` — re-running the whole pipeline cannot help a deterministic slice mismatch, so
  they drop immediately rather than burning 3 deliveries.

## Retrospective

### Lessons Learned

- The branch base (`8c6ccbaf`) is **behind** `origin/main`; `git diff origin/main` shows a huge
  unrelated delta (lighting/vfx/floor-manifest churn on main). Always diff against the **merge-base**
  (`git merge-base origin/main HEAD`) to see only in-scope changes — the PR itself diffs correctly
  against the merge-base.
- The content-aware slicer intentionally ignores the brief grid and infers cells from background
  bands (`slice-sheet.ts:300`). The honest fix for "expected N, produced M" is to make the _model_
  draw separable cells (gutters), not to touch the slicer or the gate.
- `worker.test.ts` mocks `runIssuePipeline`, so progress-comment behavior can only be tested in
  `issue-pipeline.test.ts` (which fakes the issue API with a `comments: string[]` collector).

### Mistakes Made

- Accidentally left a first `npm run verify` running (its tool result was blocked by a policy hook)
  and started a **second** one, so two full suites ran concurrently and the wall-time perf guard
  flaked under CPU contention. Early signal: the first "blocked" powershell result did **not** mean
  the process died. Next time, confirm the prior shell is actually stopped (`list_powershell` /
  `stop_powershell`) before relaunching a long job.
- An earlier `sleep` edit dropped the trailing newline in `worker.ts` (would fail `format:check`);
  caught by a pre-commit prettier pass. Run `prettier --check` on touched files before assuming clean.

### Opportunities for Future Improvement

- The headless wall-time guard is machine/contention-sensitive; consider gating it on simulated
  frames (deterministic) rather than wall-clock, or skipping it when host CPU is saturated, so
  concurrent local runs don't produce false regressions.
- A real Azure Storage poison sub-queue (DLQ) would let operators inspect dropped messages instead of
  re-requesting; deferred in ADR 0037.
