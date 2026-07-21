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

- **2🍎** (declared at kickoff, workflow/test/docs-only, no `src/core`/`src/game`
  runtime changes, no architectural refactor).

## Verification

- `npx tsc --noEmit -p tsconfig.json` ✅ (0 errors)
- `npx vitest run tests/unit/ai-sweep-workflow.test.ts tests/unit/ai/sweep-round-plan.test.ts` ✅ (124/124)
- `npm run verify:fast` ✅
- `npm run verify:pr-prereqs` ✅

## Granularity note (per human's explicit 2-apple-cap instruction)

Resume still operates at **round-boundary granularity** — it selects the
latest fully-completed per-combo checkpoint tier (`r3 > r2 > r1 > init`, in
that strict order) rather than attempting to salvage individual in-flight
candidate shards from a partially-completed round. This was confirmed as the
smallest correct 2-apple design in the original resume-feature session and is
unchanged here.

## Notes

- No stacking/rebasing of PR #1754 was attempted per the parent's explicit
  "do not stack" decision — this is a brand-new, small commit on top of the
  branch's current tip.
- `workflowSha` remains informational-only in the provenance gate (already
  fixed in the original feature) — the resuming workflow's own SHA always
  differs from the run being resumed, by construction, once any change lands.
- The sweep was **not** dispatched. Parent session `5392703e-46a9-4d27-a466-3d0af0a09c72`
  will dispatch a resume against run 29786216369 once this PR merges.
