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
  generic `resume_run_id` mechanism (workflow*dispatch input, `resume-import`
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
  not apply — the actual complexity came in \_higher*, not lower, than the
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
- `.\node_modules\.bin\vitest.cmd run tests/unit/ai-sweep-workflow.test.ts tests/unit/ai/sweep-round-plan.test.ts tests/unit/ai/sweep-eval-search-promotion.test.ts` ✅ (171/171, after the 6th–10th fixes below)
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

- **`resolveInitRunInputs`**: `--mode init`'s `--train-seeds`/`--weapons` CLI
  flags previously silently dropped BOTH when only one was supplied (e.g. a
  typo omitting `--weapons`), producing a checkpoint with no `runInputs` at
  all — indistinguishable from a deliberately-legacy checkpoint, but actually
  a malformed modern one that would fall through to the legacy-inference path
  instead of the strict modern equality check the caller intended. Extracted
  the pairing validation into an exported, independently-tested
  `resolveInitRunInputs(trainSeeds, weapons, secondary)` helper that throws on
  the one-present/one-missing case; `runCli`'s `--mode init` branch now calls
  it instead of inlining the ternary. 4 new tests cover: both-absent (legacy,
  allowed), both-present (modern, allowed), and each one-present/one-missing
  combination (rejected).

A 6th bot-flagged bug surfaced in a fresh review pass right after the
`bea4bc07` push: the `resume-import` job's "Upload resumed checkpoints
bundle" step ran BEFORE the "Derive legacy+legacy baseline shard"/"Upload
derived legacy+legacy baseline shard" steps. Since a step failure without
`continue-on-error` only skips LATER steps in the same job, the
`resumed-checkpoints` artifact was already durably uploaded by the time a
later legacy-baseline derivation/upload failure could occur — so a
hard-failed `resume-import` job could still leave a usable-looking
`resumed-checkpoints` bundle (missing the derived legacy baseline) behind.
`round1-candidates`/`round1-select`/`validate` gate on `!cancelled()`, not
`needs.resume-import.result == 'success'` (documented reason: `resume-import`
runs unconditionally right after preflight and its outputs must be readable
even when it later fails one combo), so they would download and continue
from that partial bundle — silently reintroducing the narrowed
per-combo-incumbent safety-net gap the legacy-baseline-derivation step exists
to close, for every non-LEGACY combo, purely because `legacy+legacy` itself
was resumed. Fixed by reordering the "Upload resumed checkpoints bundle" step
to be the LAST step in the job (after both legacy-baseline steps), so its
existence now depends on the whole job having succeeded up to that point.
Added a regression test (`ai-sweep-workflow.test.ts`) asserting the resumed-
checkpoints upload step index is strictly greater than both legacy-baseline
step indices AND equals `steps.length - 1` (last step in the job).

Re-querying review threads after that push surfaced 3 MORE threads, all
directly enabled by the 6th fix's new guarantee (fixed together in one batch,
`d6be2fb0`'s follow-up commit):

- **7th (`ai-sweep.yml`, `checkpoint-init`'s "Build round-0 checkpoint" step)**:
  the `RESUMED_COMBOS`-conditioned fallback that degraded the legacy+legacy
  safety gate to a warning (instead of hard-failing) when `legacy+legacy` was
  itself resumed is now provably unreachable/unsafe reasoning — the 6th fix's
  ordering + the pre-existing `needs.resume-import.result == 'success'` gate on
  `checkpoint-init` together guarantee that if `checkpoint-init` runs at all
  and `legacy+legacy` was resumed, the derived legacy+legacy baseline artifact
  MUST already exist (deriving+uploading it is now an unconditional,
  non-last-position requirement for `resume-import` to report success). The
  fallback was therefore silently reintroducing the exact incumbent-narrowing
  gap the whole PR exists to close, on an "expected absence" case that can no
  longer occur. Removed the `RESUMED_COMBOS` env var and `jq`-based
  conditional entirely; the step now ALWAYS `exit 1`s (unconditionally) when
  the legacy+legacy baseline shard is missing for a non-LEGACY combo,
  regardless of resume state. Updated the surrounding step comments (the old
  comment referenced a `continue-on-error: true` on the derive step that no
  longer exists after the 6th fix).
- **8th (`round-plan.ts`'s `assertResumeCompatible`, legacy-fallback branch)**:
  the legacy-checkpoint comparison deduped the REQUESTED `trainSeeds`/`weapons`
  strings (via `new Set(...)`) before comparing against the inferred panel.
  But the real evaluator (`sweep-eval.ts`'s `--train-seeds`/`--seeds`/
  `--weapons` parsing, confirmed at lines ~724-731, backed by
  `winrate-sweep-args.ts`'s `parseSeeds` which preserves every CSV
  segment/range verbatim) does **not** dedupe — a fresh leg requesting e.g.
  `"1,1,2"` genuinely executes seed 1 TWICE and persists a duplicate row for
  it. Deduping the request before comparing meant `"1,1,2"` was silently
  accepted as equivalent to an inferred duplicate-free `[1,2]` panel, even
  though a real fresh run of that request would NOT match the imported
  panel's row set — a genuine (if narrow) correctness gap. Fixed by rejecting
  duplicate seeds and duplicate/empty weapon entries in the REQUESTED string
  outright (fail closed with a clear error) rather than canonicalizing past
  them, for the legacy-fallback comparison path only; modern
  (`runInputs`-present) checkpoints are unaffected and keep their existing
  strict raw-string equality.
- **9th (`ai-sweep-workflow.test.ts`, stale test)**: the old test codifying
  the `RESUMED_COMBOS` graceful-degrade behavior as correct/expected was
  replaced with two new tests: one asserting the hard-fail-unconditionally
  behavior (no `RESUMED_COMBOS`, no `jq` conditional, `exit 1` always
  reachable when the shard is missing) and one asserting the legacy+legacy
  download step's `if-no-artifact-found: warn` is a display-only choice, not
  a fallback mechanism.

3 new tests were added to `sweep-round-plan.test.ts` covering the 8th fix:
duplicate-seed rejection, empty-weapon-entry rejection, and duplicate-weapon
rejection — each proving the DEDUPED request would have otherwise matched the
inferred panel (so the fix is provably load-bearing, not just defensive).

A 10th bot-flagged bug surfaced after CI settled on `edef5844` (all 13 prior
threads confirmed resolved via GraphQL, but a brand-new thread appeared at
`round-plan.ts:758`): `assertResumeCompatible`'s compatibility contract never
bound the checkpoint PAYLOAD itself to the combo/round SLOT the workflow
selected it for — the `resume-import` job's "Select latest compatible
checkpoint" step only trusted the `search-checkpoint-${r}-${COMBO}.json`
ARTIFACT FILENAME (looping over `$COMBO`/`$r`), then handed the parsed JSON to
`round-plan.ts --mode resume-check` without ever passing the expected combo or
round as an argument. `assertResumeCompatible` checked metadata
(schemaVersion/floorId/budgetMs/maxFrames/stage/runnerOs/nodeVersion/
packageLockHash via `assertShardCompatible`) and run-input semantics
(trainSeeds/weapons/secondary), but never compared `checkpoint.combo` or
`checkpoint.round` against anything. A mislabeled artifact (wrong combo, or a
round exceeding the tier being imported — e.g. an r2 checkpoint accidentally
uploaded/matched under the `r1` filename) would have passed every existing
check and either failed confusingly much later in the round-DAG, or silently
resumed MORE completed optimization than the requested tier.

Fixed by adding two required fields to `ResumeExpectedProvenance`: `combo:
string` and `round: number` (the exact combo id and round number the tier
being imported implies). `assertResumeCompatible` now checks
`checkpoint.combo === expected.combo` and `checkpoint.round === expected.round`
FIRST, before the existing metadata/run-input checks, so a mislabeled artifact
fails fast with an unambiguous combo/round error. The CLI's existing generic
`--combo`/`--round` flags (already used by `init`/`plan`/`select` modes) are
reused for `--mode resume-check` rather than adding new flag names — both are
now REQUIRED for that mode. `ai-sweep.yml`'s "Select latest compatible
checkpoint" step now maps the tier name it is already looping over to the
exact round number that tier implies (`r3`→3, `r2`→2, `r1`→1, `init`→0) via an
inline `case` statement, and passes `--combo "$COMBO" --round
"$EXPECT_ROUND"` to every `resume-check` invocation.

4 new tests cover this: combo-mismatch rejection, round-mismatch rejection,
combo/round checked before other provenance fields (mislabeled artifact fails
fast on the combo error, not a confusing downstream one), plus a workflow-level
test asserting the exhaustive tier→round `case` mapping and the `--combo
"$COMBO" --round "$EXPECT_ROUND"` invocation shape are present in
`ai-sweep.yml`. Test count: 167 → 171.

## Notes

- No stacking/rebasing of PR #1754 was attempted per the parent's explicit
  "do not stack" decision — this is a brand-new, small commit on top of the
  branch's current tip.
- `workflowSha` remains informational-only in the provenance gate (already
  fixed in the original feature) — the resuming workflow's own SHA always
  differs from the run being resumed, by construction, once any change lands.
- The sweep was **not** dispatched. Parent session `5392703e-46a9-4d27-a466-3d0af0a09c72`
  will dispatch a resume against run 29786216369 once this PR merges.
