# Session Handoff: AI Sweep Eval bounded parallel-round redesign + safety-gate fixes

## Date

2026-07-19

## Persona

Producer / DevOps (session-level orchestrator; requested by cross-session
message from session `c79c7a26-9864-47f8-8b0c-467fe50cd3ac`)

## Systems touched

ai-combat-balance

## Apples

4🍎 estimated, 4🍎 actual (✅ hit). Multi-file GitHub Actions redesign
(checkpointing + matrix fan-out + bounded round DAG) plus a real safety-gate
bug fix, with an adversarial plan review, a 2-round code-review loop, and a
2-model multi-model-review round that each found genuine, previously-shipped
bugs. Full 4🍎 review harness recorded in
`docs/knowledge/review-ledgers/2026-07-19-ai-sweep-eval-parallel-rounds.review-ledger.json`.

## Why

GitHub run `29606086471` was cancelled after ~3h40 wall-clock. The prior
`.github/workflows/ai-sweep.yml` ran the whole one-round primary-knob search
(baseline + ~12 neighbors = 13 configs × 80 train seeds × 3 weapons = 3,120
headless runs) inside **one** 4-worker `search` job. A `rounds=0` baseline
alone measured ~25 minutes for 240 runs; extrapolating to 13 configs in one
serial job projected **~5h25m**, blowing past the workflow's 300-minute
timeout. Because the pipeline only emitted its artifact at the very end, the
timeout **discarded every result**, including the already-computed baseline.

Separately, a completed full graduation run (`29597840666`) surfaced a real
safety-gate bug: `riskRewardFused+legacy` and `+slackAware` both beat the
`LEGACY` incumbent on raw win-rate (292/300 = 97.3% vs 286/300 = 95.3%) but
each had **5 incumbent win→loss flips** — a hard-gate violation (the approved
qualification order requires ≥90% wins **AND zero flips** before ranking by
score). The search's promotion logic optimized total score only and never
checked for flips, so it could (and did) recommend a candidate that violates
the approved gate.

## What Was Done

Redesigned the search into a **checkpointed, matrix-parallel, bounded 1–3
round DAG** and fixed the safety-gate selection bug in both the production
and legacy code paths.

- **`scripts/agent/perf/round-plan.ts`** (new, pure) — the round-DAG brain:
  - `generateRound1Candidates()` — baseline + primary-knob neighbors as
    independent candidate descriptors (one per matrix job).
  - `applyRoundResult()` — the **production promotion gate**: applies the
    approved qualification order (≥90% official wins AND zero incumbent
    win→loss flips, then highest composite score; ties broken by faster clear
    time, higher minimum HP, then XP/gold) to select a round winner, and
    **never** promotes a flip-tainted or sub-90%-win candidate even if it has
    the highest raw score. Also drives round-to-round convergence/halving
    decisions from the winner's margin.
  - Three-way `plannedCount` sentinel (`0` | positive int | `'unknown'`): `0`
    means "planner ran and legitimately found no further candidates worth
    trying" (a real convergence signal); `'unknown'` means "candidates.json
    never appeared" (planner crashed/never ran) and must **always** suppress
    halve/converge so an infra failure can't masquerade as convergence.
  - Cardinality-safe: candidate counts are bounded well under GitHub's
    256-job matrix cap.
- **`scripts/agent/perf/sweep-eval.ts`**:
  - `selectSearchPromotion()` (new, pure, exported) — routes the **legacy**
    `--stage search` promotion path (used for local/manual smoke runs)
    through the same `buildLeaderboard` + `selectQualifiedWinner` safety gate
    as the production round-DAG path, instead of promoting by raw score.
  - Fixed a module-load-time crash: the `isMainThread`/`workerData` dispatch
    guard ran the worker-task branch unconditionally in any non-main-thread
    context, including Vitest's worker pool (where `workerData` is
    `undefined`) — now requires `workerData != null` too.
- **`scripts/agent/perf/aggregate-shards.ts`** — updated fan-in aggregation to
  support the round-DAG's per-candidate shard shape.
- **`.github/workflows/ai-sweep.yml`** — restructured into the bounded round
  DAG: `checkpoint-init` → `baseline` (once) → `round1-candidates` (planner) →
  matrix of `round1-eval` (one job per candidate, each internally 4 workers
  over weapon×seed) → `round1-select` (fan-in) → (repeat for rounds 2–3, each
  gated on `inputs.rounds`) → `validate` (unchanged full 1–100 × 3-weapon
  final validation) → `aggregate`. Every stage persists its own checkpoint
  artifact so a later round's failure/timeout never discards prior rounds'
  results. All existing `workflow_dispatch` inputs remain unchanged and
  valid; no default mode flip. `contents: read`, `fail-fast: false`,
  deterministic seeds preserved throughout.
- **`.github/extensions/sweep-results-viewer/lib/cloud-results.mjs`** —
  extended the AI-Sweep-Eval job-name → phase-key matcher so the round-DAG's
  new job names (`Baseline`, `Checkpoint init`, `Round N — ...`) still surface
  under the existing "search in progress" viewer UI, alongside the legacy
  `Search <combo>` job name from historical runs.
- **Tests**: `tests/unit/ai/sweep-round-plan.test.ts` (new, round-DAG
  generation, safety-gate selection incl. flip-rejection, `unknown`-sentinel
  handling, convergence/halving), `tests/unit/ai-sweep-workflow.test.ts` (new,
  workflow-guard: matrix cardinality caps, checkpoint-artifact wiring,
  cancellation-safety, per-candidate-unique shard filenames, no `if:
always()` anywhere in the workflow), `tests/unit/ai/sweep-eval-search-promotion.test.ts`
  (new, legacy-path safety-gate coverage), `tests/unit/ai/sweep-aggregate-shards.test.ts`
  (updated for the round-DAG shard shape), and `.github/extensions/sweep-results-viewer/tests/cloud-results.test.mjs`
  (updated for the new phase-key matcher).

## Two multi-model-review bugs worth flagging explicitly

Both were caught only because the review harness required a **second**
distinct model, not because the first reviewer or the implementation missed
something obvious in retrospect:

1. **Artifact-collision data loss** (gemini-3.1-pro-preview, Critical): every
   `roundN-eval` candidate job wrote its shard to the same local filename
   (`shard.json`) despite uploading under a uniquely-named artifact.
   `roundN-select`'s `download-artifact@v4` step used `merge-multiple: true`,
   which silently overwrites same-named files across merged artifacts —
   collapsing every candidate's shard down to just the last-downloaded one
   per combo per round. This would have silently starved the leaderboard of
   nearly every candidate's result while looking completely healthy (no
   error, no warning). Fixed by giving each candidate's local output file a
   name matching its unique artifact name (`shard-$HASH.json`).
2. **YAML `!`-leading scalar gotcha** (self-discovered while fixing gemini's
   `always()` → `!cancelled()` finding): a bare `if: !cancelled()` (unquoted
   YAML scalar starting with `!`) is parsed as a YAML tag indicator, silently
   truncating the condition — confirmed both via the `yaml` npm parser used
   by the test suite and via GitHub's own documented guidance on this exact
   gotcha. The fix-for-a-fix would have shipped a workflow that silently lost
   its cancellation-safety check at runtime. Fixed by wrapping every
   `!cancelled()` condition in `${{ ... }}`.

## Verification Run

- `npm run typecheck` — clean.
- Targeted unit suites — 113/113 passed across
  `tests/unit/ai/sweep-round-plan.test.ts`, `tests/unit/ai-sweep-workflow.test.ts`
  (23 tests), `tests/unit/ai/sweep-aggregate-shards.test.ts`,
  `tests/unit/ai/sweep-eval-search-promotion.test.ts`.
- `bash scripts/agent/verify-fast.sh` — GREEN.
- `npm run review:ledger -- validate docs/knowledge/review-ledgers/2026-07-19-ai-sweep-eval-parallel-rounds.review-ledger.json` — exit 0 (valid 4-apple ledger).
- `npm run verify:pr-prereqs` — run before PR creation (see PR for result).

Per the maintainer's explicit request, **no broad local sweep was run** —
CI/cloud owns performance execution. The ≤90-minute timing claim is a
conservative model built from the observed ~25-minute wall-clock for a
240-run candidate batch (80 seeds × 3 weapons on 4 workers) combined with the
new one-candidate-per-matrix-job fan-out, not a locally-measured wall time.

## Observe Before Done (rule #10)

This changes CI workflow structure and pure scheduling/selection TypeScript
(`round-plan.ts`, `sweep-eval.ts`'s promotion logic) — it does **not** touch
any runtime `*System`, so there is no lab/wiring obligation. Verification
consisted of: (a) direct code inspection of every `if:`/`download-artifact`/
`upload-artifact` step in the rewritten YAML before and after each fix
(catching the shard-collision and `!cancelled()` YAML-parsing bugs this way),
(b) the `yaml`-parser-backed workflow-guard tests asserting the fixed
conditions actually parse as intended, and (c) unit tests directly exercising
`applyRoundResult`/`selectSearchPromotion` against fixture data reproducing
the real GH-run-29597840666 flip scenario, confirming the fixed selection
logic rejects the flip-tainted higher-scorer and instead promotes the
gate-compliant candidate.

**Residual limitation**: the redesigned workflow has not yet been observed
running end-to-end on real GitHub Actions infrastructure — its first real
dispatch should be watched closely for the actual wall-clock timing and for
any GitHub Actions behavior (matrix scheduling, artifact retention, dynamic
job counts) that differs from the YAML-parser-level and unit-level
verification done here.

## Review Harness (4🍎)

- **plan_review** — adversarial (gpt-5.4), 3 concerns, all adopted.
- **code_review** — 2 rounds (claude-sonnet-4.6): round 1 found 1 valid
  concern (confounded flip-gate test), fixed; round 2 found 1 valid concern
  (confounded win-rate-floor isolation test), fixed. Terminal clean within
  the 2-round cap.
- **multi_model_review** — 1 round, 2 distinct models (gpt-5.3-codex +
  gemini-3.1-pro-preview), adjudicated by the orchestrating session
  (claude-sonnet-5) against the actual code/YAML for every finding: 5
  concerns raised, 4 valid (legacy search-path safety-gate bypass; infra-vs-
  convergence `plannedCount` ambiguity; the artifact-collision data loss; the
  `always()`-ignores-cancellation issue, which surfaced the YAML `!`-scalar
  gotcha during its own fix) — all fixed with dedicated test coverage. 1
  (missing `applyRoundResult` flip-rejection test coverage) was adjudicated
  **invalid**: that coverage already existed pre-review (3 dedicated tests in
  `sweep-round-plan.test.ts`, including a direct GH-run-29597840666
  reproduction). Terminal clean.

## Unresolved / Next Steps

1. **First real dispatch.** Run `gh workflow run ai-sweep.yml` on the merged
   redesign and watch the actual wall-clock timing, matrix job counts, and
   checkpoint-artifact behavior on real GitHub Actions infrastructure — the
   ≤90-minute target is currently a conservative extrapolation, not an
   observed number.
2. **Re-run the full graduation search** once the redesign is live, to
   re-derive whether `riskRewardFused+legacy`/`+slackAware` (or any other
   candidate) can clear the **corrected** safety gate (≥90% wins AND zero
   flips) — the prior 292/300-with-5-flips result should not be treated as
   qualified under the fixed selection logic.
3. Report back to the requesting session (`c79c7a26-9864-47f8-8b0c-467fe50cd3ac`)
   with the PR link and both residual limitations above.
