# Handoff — AI Sweep cross-run resume: rebuild + legacy runInputs inference

## Systems touched

ai-combat-balance, ci-policy

## Summary

- Rebuilds the AI Sweep cross-run-resume feature (`resume_run_id` workflow_dispatch
  input, `resume-import` job, `assertResumeCompatible`, `runInputs` checkpoint field,
  `max-parallel: 8` on every matrix/fan-out job) **additively** on top of PR #1735's
  legitimate revert (see `docs/knowledge/handoffs/2026-07-21-pr1735-resume-revert-recovery.md`),
  restoring the exact pre-revert code from merge-commit `5b62f57f` for
  `.github/workflows/ai-sweep.yml`, `scripts/agent/perf/round-plan.ts`,
  `scripts/agent/perf/sweep-eval.ts`, and both test files — then fixing the
  disclosed bug and adding a new safe legacy-inference layer on top.
- **Bug fix**: when `legacy+legacy` is itself cross-run resumed, `resume-import`
  now derives a fresh `search-baseline-legacy+legacy` shard directly from the
  resumed checkpoint's own additive-only round-0 rows
  (`extractLegacyBaselineShard`) and uploads it under the exact artifact
  name/local filename `checkpoint-init`'s existing download step already
  expects. This closes the gap where non-LEGACY combos would otherwise
  silently fall back to their own base as the in-search incumbent instead of
  hard-requiring the real LEGACY incumbent — the exact bug class PR #1735
  reverted the feature over.
- **New**: `inferRunInputsFromCheckpoint` derives `trainSeeds`/`weapons`/`secondary`
  from a legacy (pre-`runInputs`) checkpoint's OWN complete, duplicate-free,
  rectangular baseline panel + `steps` — never trusting or hard-coding any
  canonical/expected config. `assertResumeCompatible` now calls this when
  `checkpoint.runInputs` is absent and does a SEMANTIC (sorted/deduped array)
  comparison against the new run's requested `trainSeeds`/`weapons`/`secondary`,
  failing closed on any mismatch, incomplete/duplicate/non-rectangular panel,
  or unprovable `secondary` flag. Modern checkpoints (`runInputs` present) keep
  their existing strict exact-string-equality comparison, completely unchanged.
- New `extract-legacy-baseline` CLI mode wires `extractLegacyBaselineShard`
  into `round-plan.ts`'s existing CLI dispatch, used by the new `resume-import`
  step above.
- This closes the loop the earlier session (see PR #1754/#1756/#1757's
  handoffs) had disclosed as a real gap: cancelled run 29786216369's
  checkpoints predate `runInputs` and were previously reported as
  **un-resumable by design**. They now import as compatible, non-zero
  checkpoints (assuming their baseline shard is the expected complete
  1-80-seed × sword/bow/baseball-bat rectangular panel, matching the run's
  actual dispatch inputs) instead of unconditionally failing closed.

## Why

Three legitimate, independently-confirmed decisions from the parent session
converged on this design:

1. The original cross-run-resume feature (PRs #1754/#1756/#1757) merged onto
   `nalfeo-ai-sweep-net-win-promotion`, but a separate agent session later
   reverted it wholesale from the same branch (commits `4d1e14ca`/`1d81c38a`/
   `df3f3d67`) because resuming `legacy+legacy` itself left non-LEGACY combos'
   in-search safety gate silently degraded — a real, disclosed bug, not a
   false alarm.
2. The parent explicitly rejected re-stacking/rebasing PR #1754 onto the
   revert (that would either fight a validated decision or reintroduce the
   bug), and explicitly rejected treating cancelled run 29786216369 as
   "resumes fresh" (the human cancelled specifically to recover completed
   search work).
3. The parent's own design — infer `runInputs` deterministically from the
   checkpoint's own contents, compare exactly to the new run's requested
   inputs, fail closed otherwise — is the correct minimal fix: it recovers
   run 29786216369 without ever trusting an externally-asserted "canonical"
   config, and without touching `src/core`/`src/game` runtime.

Given the source branches for #1754/#1756/#1757 were GitHub-auto-deleted
post-merge, the only way to rebuild without reverting/rewriting anyone's
history was to restore the exact pre-revert file states from the surviving
merge-commit objects and layer the fix + new inference logic on top as one
new commit.

## Apple estimate

- **Estimated (kickoff): 2🍎** — workflow/test/docs-only, no `src/core`/`src/game`
  runtime changes, no architectural refactor.
- **Actual: 3🍎** — honest post-hoc recalibration. The diff rebuilds the full
  generic `resume_run_id` mechanism (workflow_dispatch input, `resume-import`
  job, `assertResumeCompatible`/`inferRunInputsFromCheckpoint`/
  `normalizeResumedCheckpoint`/`extractLegacyBaselineShard`) across 8 files
  (~1560 insertions: `.github/workflows/ai-sweep.yml`,
  `scripts/agent/perf/round-plan.ts`, `scripts/agent/perf/sweep-eval.ts`, two
  test files, review ledger, this handoff) — the size of the originally
  narrower-scoped feature before the 2🍎 cap was imposed, not a small
  incremental fix. Flagged by `copilot-pull-request-reviewer[bot]`; the review
  ledger (`docs/knowledge/review-ledgers/2026-07-21-ai-sweep-legacy-runinputs-infer.review-ledger.json`)
  already records `estimated_apples: 3` with a completed plan-review + code-review
  round matching that tier. This estimate is recorded as calibration, not a
  downward re-score (complexity-policy.md's downward-only re-scoring rule does
  not apply — the actual complexity came in _higher_, not lower, than the
  kickoff estimate).
- **Verdict: 📉 Under** (delta = actual − estimated = +1: the task was harder/
  larger than the kickoff estimate). Recorded via `npm run apples:record` at
  `docs/knowledge/metrics/apples/2026-07-21-ai-sweep-legacy-runinputs-infer.json`.
- **Gap explanation**: the original 2🍎 cap was set assuming the smallest
  correct design (a narrow, single-run validate-only recovery — later shipped
  separately as PR #1760). The human's explicit override ("I want generic
  resume capability") reopened this PR to ship the full reusable
  `resume_run_id` mechanism instead, which is legitimately a 3🍎 feature: it
  touches the main `ai-sweep.yml` workflow's round-DAG, adds a new
  compatibility/inference module, and requires provenance reasoning across
  legacy and modern checkpoint schemas.

## Verification

- `npx tsc --noEmit -p tsconfig.json` ✅ (0 errors)
- `.\node_modules\.bin\vitest.cmd run tests/unit/ai-sweep-workflow.test.ts tests/unit/ai/sweep-round-plan.test.ts tests/unit/ai/sweep-eval-search-promotion.test.ts` ✅ (158/158)
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Granularity note

Resume still operates at **round-boundary granularity** — it selects the
latest fully-completed per-combo checkpoint tier (`r3 > r2 > r1 > init`, in
that strict order, bounded by the requesting run's own `rounds` input via a
`$TIERS` case-statement) rather than attempting to salvage individual
in-flight candidate shards from a partially-completed round. This was
confirmed as the smallest correct design in the original resume-feature
session and remains unchanged.

## Later fixes (this reopened session)

PR #1759 was briefly **closed as superseded** by the narrower, standalone
PR #1760 (`recover-checkpoint-validate.ts` + `ai-sweep-recover.yml`, a
one-off validate-only recovery for run 29786216369's round-2 checkpoints —
merged separately, does not touch `ai-sweep.yml`/`round-plan.ts`, and remains
untouched by this PR). The human directly overrode that closure ("I want
generic resume capability") and this PR was **reopened**; #1759 and #1760
now coexist as two independent, non-conflicting mechanisms — #1760 for the
one-off historical recovery, #1759 for the general reusable
`resume_run_id` capability going forward.

After reopening, merged latest `main` (which included both #1735 net-win
promotion at `904e4e84` and #1760 at `5b617abd`) and fixed 4 remaining
bot-flagged bugs in one batched commit:

- **`normalizeResumedCheckpoint`**: an accepted resumed checkpoint is now
  re-stamped with the CURRENT run's `meta.workflowSha` before re-entering the
  round-DAG (the prior run's SHA was previously left in place, which would
  fail every downstream same-run provenance check in `applyRoundResult`,
  `initCheckpoint`, and `aggregate-shards.ts` once the resuming commit — by
  construction — carries a different SHA).
- **Tier scan bounded by `rounds` input**: the resume-check tier scan (`r3 >
r2 > r1 > init`) is now bounded by a `$TIERS` case-statement keyed on
  `inputs.rounds`, instead of an unconditional 4-tier scan that ignored a
  request for fewer rounds.
- **`continue-on-error` removed** from the legacy-baseline-derivation step
  (a resumed `legacy+legacy` checkpoint has already passed `resume-check`,
  so a derivation failure there means an invariant is broken and must fail
  the job, not silently degrade).
- **`SECONDARY_KNOBS` detection** in `inferRunInputsFromCheckpoint` fixed
  from an unsound `.some()` (any single stray secondary key proved
  `secondary=true`) to an all-or-none check matching production
  `knobsForCombo` behavior exactly.

Investigated but initially thought no-bug, then hardened with a real fix:
`--print-meta`'s default `--stage search` already matched the `meta.stage`
value every `search-baseline`/`search-eval` shard stamped (`evalStandalone`
hardcoded the literal `'search'` regardless of the invoked CLI stage), so
`assertResumeCompatible`'s `stage` check was not actually rejecting prior
checkpoints today. However, both call sites used **independent** `'search'`
string literals with no compiler-enforced link between them — a real latent
drift risk the reviewer correctly flagged (a future edit to either literal
alone would silently reject every cross-run resume checkpoint on the `stage`
axis). Fixed by extracting both to one exported constant,
`STANDALONE_SHARD_STAGE`, in `sweep-eval.ts`, used by both `parseArgs`'s
default and both `evalStandalone` call sites, plus a pinning regression test
in `sweep-eval-search-promotion.test.ts` (`STANDALONE_SHARD_STAGE` describe
block) that fails if the constant's value ever changes without a
deliberate edit.

## Notes

- No stacking/rebasing of PR #1754 was attempted per the parent's explicit
  "do not stack" decision — this is a brand-new, small commit on top of the
  branch's current tip.
- `workflowSha` remains informational-only in the provenance gate (already
  fixed in the original feature) — the resuming workflow's own SHA always
  differs from the run being resumed, by construction, once any change lands.
- The sweep was **not** dispatched. Parent session `5392703e-46a9-4d27-a466-3d0af0a09c72`
  will dispatch a resume against run 29786216369 once this PR merges.
