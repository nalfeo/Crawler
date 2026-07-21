# Session Handoff: AI Sweep Eval cross-run resume + max-parallel:8 everywhere

## Date

2026-07-21

## Persona

DevOps Engineer (`.github/workflows/**` owner; task delegated by cross-session
message from session `5392703e-46a9-4d27-a466-3d0af0a09c72`)

## Systems touched

ai-combat-balance

## Apples

2🍎 declared, 2🍎 actual (✅ hit). Workflow YAML + two pure TypeScript CLI
scripts + tests only — no `src/core`/`src/game` runtime changes, no
architectural refactor. Per `docs/agent-os/policies/complexity-policy.md`,
1–2🍎 requires no plan-review/code-review harness stages; ledger recorded at
`docs/knowledge/review-ledgers/2026-07-21-ai-sweep-cross-run-resume.review-ledger.json`
(ledger only, no stages required).

## Why

GitHub Actions run `29786216369` (AI Sweep Eval) was manually cancelled due to
runner starvation after completing most of its search work — baseline,
checkpoint-init, round-1/round-2 checkpoints, round candidate plans, and some
round-3 shards all exist as that run's immutable artifacts (7-day retention),
but the workflow as written could only ever `download-artifact` from **its own
run** (`github.run_id` implicit scope). There was no way to start a _new_
`workflow_dispatch` that picks up a prior cancelled run's completed rounds —
every resume required blindly recomputing from scratch, wasting the already-
completed search work.

Separately, only some matrix/fan-out jobs (`round1-eval`/`round2-eval`/
`round3-eval`) had `max-parallel: 8`; other fan-out jobs (`round1-candidates`
et al., `baseline`, `checkpoint-init`) either had no matrix cap or none was
verified, risking runner-starvation recurrence from an unbounded dispatch.

## What Was Done

- **`.github/workflows/ai-sweep.yml`**:
  - Added a `resume_run_id` `workflow_dispatch` input (blank by default — a
    blank/omitted value takes the fresh-run path: same combo set and search
    semantics as before this change, though not scheduling-identical, since
    `baseline` now always waits on the new `resume-import` job's
    checkout/Node-setup/metadata step).
  - Added `actions: read` to `permissions:` (read-only; required for
    cross-run `download-artifact@v4` via `run-id`/`github-token`).
  - New **`resume-import`** job (runs unconditionally right after
    `preflight`, before `baseline`): computes this run's own provenance via
    `sweep-eval.ts --print-meta` (schemaVersion/floorId/budgetMs/maxFrames/
    stage/runnerOs/nodeVersion/packageLockHash/workflowSha), conditionally
    cross-run-downloads the prior run's checkpoint artifacts only when
    `inputs.resume_run_id != ''` (`continue-on-error: true` so a bad/expired
    run id degrades to a fully fresh run rather than failing the whole
    dispatch), then per-combo walks candidate checkpoint tiers in strict
    **r3 > r2 > r1 > init** order (latest-completed-round-first) validating
    each candidate through `round-plan.ts --mode resume-check` (new CLI mode
    wrapping `assertResumeCompatible`, see below). Always emits well-formed
    `freshCombos`/`resumedCombos` JSON array outputs unconditionally, so
    downstream `fromJSON(...)` matrix sources never see an empty/malformed
    string regardless of which branch ran.
  - `baseline`/`checkpoint-init`: matrix source switched to
    `fromJSON(needs.resume-import.outputs.freshCombos)` (excludes resumed
    combos — no wasted recomputation of their baseline/round-0 checkpoint);
    both jobs now `needs: [preflight, resume-import]`.
  - `round1-candidates`/`round1-select`/`validate`: added downloads of the
    `resume-import`-produced `resumed-checkpoints` bundle artifact alongside
    each job's existing fresh-path checkpoint download, so a resumed combo's
    checkpoint is available wherever a fresh combo's would normally be. These
    use a bare `pattern:`-based `download-artifact@v4` step with **no**
    `if-no-artifact-found` input — v4 dropped that v3-only input, and a
    `pattern` matching zero artifacts already succeeds as a no-op by design,
    so fresh combos (with nothing in the `resumed-checkpoints` bundle) simply
    download nothing from that step without erroring. `round1-select`'s
    existing init-checkpoint download was converted from a required
    `name:`-based download to a tolerant dual-source `pattern:`-based download
    (fresh ∪ resumed), with a defensive fail-loud existence check afterward
    (every combo, fresh or resumed, MUST have exactly one checkpoint file
    present by the time `round1-select` runs). The unrelated
    `if-no-artifact-found: warn` lines already present elsewhere in this file
    (e.g. `round1-select`'s `round1-candidates`/`round1-shard-*` downloads) are
    pre-existing on `main`, untouched by this PR, and out of scope here.
  - `round1-eval`/`round2-eval`/`round3-eval`: confirmed/added
    `max-parallel: 8`.
  - `round2-select`/`round3-select`/`round2/3-candidates`/`aggregate`:
    required **zero** changes — they consume per-round artifacts that are
    uniformly produced for every combo (fresh or resumed) once
    `round1-select` runs, whose matrix source remains the **full**
    `preflight` combo list (not `freshCombos`). Resume complexity is fully
    absorbed by `round1-select`'s fan-in.
  - Rewrote the header comment's RESIDUAL LIMITATION section and added a new
    CROSS-RUN RESUME section documenting exact resume granularity (see
    "Resume granularity" below) and the accepted `legacy+legacy`-resumed edge
    case (narrows, never removes, the in-search safety-gate reference; the
    final graduation gate at `validate`/`aggregate` is unaffected).

- **`scripts/agent/perf/round-plan.ts`**:
  - `RoundCheckpoint.runInputs?: { trainSeeds: string; weapons: string; secondary: boolean }` —
    stamped once in `initCheckpoint` (new optional 5th param) and carried
    unchanged through every later round, same lifecycle as `meta`. Absent on
    checkpoints produced before this change (deliberately, so
    `assertResumeCompatible` fails closed rather than silently trusting an
    old checkpoint's unknown TRAIN panel/weapon/knob-set).
  - New exported `ResumeExpectedProvenance` interface + `assertResumeCompatible()`:
    reuses the existing `assertShardCompatible` (schemaVersion/floorId/
    budgetMs/maxFrames — the same guard intra-run candidate shards already
    have to pass) and adds checks that only matter **across separate runs**
    (stage/runnerOs/nodeVersion/packageLockHash/workflowSha/trainSeeds/
    weapons, plus a hard fail when `runInputs` is entirely absent). Fails
    closed on the first mismatch found — never partially merges an
    incompatible checkpoint.
  - New CLI mode `resume-check` (+ `--train-seeds`/`--weapons`/
    `--expect-meta`/`--expect-train-seeds`/`--expect-weapons` flags) so the
    workflow's bash loop can invoke this check per-combo per-tier without any
    new script.

- **`scripts/agent/perf/sweep-eval.ts`**: new `--print-meta` flag (+
  `printMeta` CliArgs field) that relaxes the `--combo` requirement and
  early-returns `buildMeta(args.stage, args.floorId)` as JSON — this is how
  `resume-import` computes "this run's own provenance" to compare resumed
  checkpoints against, with zero duplicated meta-construction logic.

- **Tests**:
  - `tests/unit/ai-sweep-workflow.test.ts` — updated for the
    `resume_run_id` input, `actions: read` permission, `baseline`/
    `checkpoint-init`'s new needs+matrix-source, and flipped the round-eval
    max-parallel assertion to `toBe(8)`; added a new `describe('cross-run
resume ...')` block (7 tests): exhaustive `max-parallel: 8` sweep across
    every matrix job (including `eval`/`select`/`baseline`/`validate` and any
    dynamic matrices), resume-import always-emits-valid-JSON-outputs,
    conditional cross-run download gated on non-blank input, strict
    r3>r2>r1>init tier-order assertion, resume-check reuse + fail-closed
    logging assertion, default-blank-preserves-fresh-behavior assertion, and
    tolerant resumed-checkpoints-bundle-download presence across
    `round1-candidates`/`round1-select`/`validate` plus a `round1-select`
    fail-loud assertion. Extended `WorkflowJob.steps`'s type with `if?:
string` to support the conditional-download-step test.
  - `tests/unit/ai/sweep-round-plan.test.ts` — new
    `describe('assertResumeCompatible ...')` block: a fully-compatible
    pass-through case, one dedicated throwing test per mismatched field
    (schemaVersion/floorId/budgetMs/maxFrames reusing the existing shard
    guard, plus stage/runnerOs/nodeVersion/packageLockHash/workflowSha/
    trainSeeds/weapons), and a fail-closed case for a checkpoint with no
    recorded `runInputs` at all. Also extended the `initCheckpoint` describe
    block with a test proving `runInputs` is stamped verbatim when supplied
    and genuinely absent (not `undefined`-valued) when omitted.

## Review-driven fixes (GitHub `copilot-pull-request-reviewer`, post-PR-open)

The automated PR reviewer found 8 issues on the initial push. Per repo policy
(a different-model validator must verify every finding against actual code
before acting), each was independently re-derived from source, not taken on
faith:

1. **Stage-name mismatch** — verified **false positive** empirically; no fix.
2. **Missing `--train-seeds`/`--weapons` on the round-0 `init` call** — REAL:
   `checkpoint-init`'s `round-plan.ts --mode init` invocation never passed
   these flags, so every checkpoint's `runInputs` was always `undefined` —
   `assertResumeCompatible` would fail-closed on literally every future
   resume attempt, not just incompatible ones. **Fixed**: `checkpoint-init`
   now threads `inputs.train_seeds`/`inputs.weapons` through as `TRAIN_SEEDS`/
   `WEAPONS` env + `--train-seeds`/`--weapons` CLI flags.
3. **Tier-selection loop `break`d unconditionally** — REAL: the per-combo
   r3→r2→r1→init scan `break`d after the FIRST tier file found, even when
   that tier failed `resume-check` (incompatible), instead of continuing to
   try older, possibly-compatible tiers. **Fixed**: `break` moved inside the
   compatibility-success branch only; an incompatible tier now falls through
   to try the next older one.
4. **Round offset not preserved across resume** — REAL: `planCandidates`/
   `applyRoundResult` ignored `checkpoint.round` entirely, so a combo resumed
   at round 2 would still plan+evaluate a "round 1" step against its own
   already-more-advanced state, silently doing an extra unrequested
   optimization step beyond `inputs.rounds`. **Fixed** in
   `scripts/agent/perf/round-plan.ts`: `planCandidates`/`planRoundMatrix`
   gained an optional `round` param that returns zero candidates once
   `checkpoint.round >= round`; `applyRoundResult` gained a matching
   idempotent no-op (unchanged checkpoint when `checkpoint.round >= round`
   and no candidate shards arrived) and switched its `round` field
   assignment to `Math.max(round, checkpoint.round)` everywhere, so a
   resumed-ahead checkpoint's round number can never be relabelled backward.
   5/6. **Empty `freshCombos` matrix crashes `baseline`/`checkpoint-init`** —
   REAL: GitHub Actions hard-**fails** (not skips) a job whose
   `strategy.matrix.<key>` source array is empty — an all-combos-resumed run
   (`freshCombos: []`) would crash both jobs instead of correctly running
   zero legs. **Fixed**: `resume-import` now also emits a string
   `hasFreshCombos` (`'true'`/`'false'`) output; `baseline`'s and
   `checkpoint-init`'s `if:` conditions gate on it.
5. **`workflowSha` will always differ from the motivating run post-merge** —
   verified **accurate but NOT a bug**: `workflowSha` is `GITHUB_SHA`, which
   changes on every commit including this PR's own merge commit. This means
   the very first `resume_run_id: 29786216369` dispatch after merge will
   resume **zero** combos (full fresh run for every combo) — that historical
   run's checkpoints were produced under a pre-merge SHA and can never
   satisfy the fail-closed provenance check by design. Documented (top-of-file
   header comment + this handoff) rather than "fixed" — weakening the SHA
   check to make that one historical run resumable would violate the
   explicit fail-closed provenance requirement and the "never weaken explicit
   human requirements without asking" rule. **Only a LATER run, cancelled and
   resumed on the SAME already-merged SHA, actually benefits.**
6. **Legacy+legacy fallback contradicted its own adjacent comment** — REAL:
   the `checkpoint-init` legacy-baseline-missing branch always hard-`exit 1`d,
   even in the one case its own comment described as an acceptable narrowing
   (legacy+legacy itself was cross-run resumed this run, so no fresh baseline
   artifact was ever going to exist). **Fixed**: checks
   `needs.resume-import.outputs.resumedCombos` (via `jq -e`) for
   `legacy+legacy` membership before failing; if present, warns and falls
   back to the combo's own base as in-search incumbent (final graduation at
   `validate`/`aggregate` is unaffected either way) — genuine misconfiguration
   (legacy+legacy simply omitted/failed) still hard-fails exactly as before.

All 6 real-bug fixes have matching new/updated deterministic tests (see
Verification Run below for the updated pass count).

## Round-2 review findings (5 more comments on the fix commit)

A second automated review pass fired on the round-1 fix commit and produced 5
more findings (#9-#13). Each was independently re-derived from actual code
before acting, same as round 1:

9. **`secondary` (knob-set flag) missing from resume provenance** — REAL:
   `knobsFor(combo, secondary)` selects a genuinely DIFFERENT `TunableKnob[]`
   set depending on `secondary`, so a checkpoint searched with one value
   resumed under a dispatch requesting the other would silently continue a
   different search space — the exact class of bug the whole
   `runInputs`/`assertResumeCompatible` mechanism exists to prevent for
   `trainSeeds`/`weapons`. **Fixed**: `RoundCheckpoint.runInputs` and
   `ResumeExpectedProvenance` both gained a `secondary: boolean` field;
   `initCheckpoint` stamps it from the CLI's existing `--secondary` flag (no
   workflow change needed there — `checkpoint-init` already passes it);
   `assertResumeCompatible` now throws on mismatch; a new CLI
   `--expect-secondary` flag (same presence-only pattern as `--secondary`)
   feeds `resume-check` mode; `resume-import`'s "Select latest compatible
   checkpoint" step computes a `SECONDARY_FLAG` the same way every other job
   in this workflow already does for `inputs.secondary`, and appends it to
   the `resume-check` invocation.
10. **Legacy+legacy resumed-fallback narrows the in-search promotion gate for
    OTHER fresh combos in a mixed resume/fresh scenario** — verified
    **accurate but NOT a new bug**: this exact tradeoff was already
    documented by round-1's own Fix #6 (see the "NOTE (resume edge case,
    documented not hidden)" comment at the `checkpoint-init` legacy-baseline
    step) BEFORE round 2 ran, including the clarification that final
    graduation (`validate`/`aggregate`) always re-checks the real LEGACY
    incumbent regardless — only in-search candidate selection in one narrow
    mixed scenario is affected, never final promotion. Reconstructing a
    synthetic legacy baseline shard from a resumed non-baseline checkpoint
    would require materially more machinery than a 2-apple change allows and
    was already ruled out of scope for the identical reason in round 1. No
    further code change; replied on-thread pointing at the pre-existing
    documentation.
11. **`if-no-artifact-found: warn` claimed unsupported on
    `actions/download-artifact@v4`** — verified **accurate**: fetched the
    real `action.yml` from
    `https://raw.githubusercontent.com/actions/download-artifact/v4/action.yml`
    — v4's only inputs are `name`, `artifact-ids`, `path`, `pattern`,
    `merge-multiple`, `github-token`, `repository`, `run-id`;
    `if-no-artifact-found` was a v3-only input, dropped in v4. Confirmed via
    upstream docs that a `pattern` matching zero artifacts already succeeds
    by design ("0 artifacts downloaded", not a failure), so the invalid input
    had zero functional effect — it was just misleading dead config. **Fixed**:
    removed all 6 occurrences newly added by this PR (resume-import download,
    checkpoint-init's resumed-checkpoints download, round1-select's fresh +
    resumed init-checkpoint downloads, validate's all-checkpoints +
    resumed-checkpoint downloads). 7 PRE-EXISTING occurrences on `main`
    (round1/2/3-select's candidate-plan/shard downloads) were left untouched
    — unrelated to this PR's scope, and already relying on the same
    harmless-no-op v4 behavior before this change existed.
    12/13. **Review ledger / handoff doc classified as 2🍎, reviewer argues
    3-10 files + cross-cutting resume logic meets the 3🍎 "new
    subsystem" bar in `docs/agent-os/policies/complexity-policy.md`** —
    genuine scope disagreement, NOT reclassified. The delegating human
    instruction for this exact task explicitly said: _"Scope cap is
    explicitly 2 apples... no >=3 apple review harness."_ Silently
    reclassifying to 3🍎 here would both contradict that explicit
    instruction and retroactively require review-harness stages the human
    said not to run. Per the "never weaken explicit human requirements
    without asking" rule, this is being surfaced transparently to the
    requesting parent session instead of resolved unilaterally in either
    direction — see the final report for the flag.

Resume operates at **round-boundary granularity**: the latest fully-completed
checkpoint per combo (round-3 > round-2 > round-1 > baseline/init tier) is
imported and continued; individual in-flight/incomplete candidate shards from
a cancelled round are never salvaged. This was verified — not just assumed —
to be functionally correct and complete for "continue only unfinished work":

- `planCandidates` returns `[]` for an already-`converged: true` checkpoint,
  so a fully-converged resumed combo produces zero new round-1 candidates and
  flows through unchanged to `validate` with its final `bestConfigId` intact.
- A resumed checkpoint that is **not** yet converged continues coordinate-
  ascent correctly on its own: `planCandidates` computes neighbours from the
  checkpoint's persisted `bestConfigId`/`steps` (never from a "round number"),
  and filters out already-`evaluated` config ids — so relabeling a genuinely
  mid-search checkpoint as this run's "init" tier and running it through
  round1/2/3 naturally continues the search from exactly where it left off.
- `applyRoundResult`'s `round` field overwrite on a converged checkpoint is
  purely cosmetic/display — never read by any downstream decision logic
  (`validate` reads `bestConfigId`/`configs`/`rows`/`meta`, never `.round`).

This is the smallest-correct 2-apple design per the task's explicit
allowance; salvaging partial round-3 shards was out of scope.

## Round-3 review findings (1 more comment, on the handoff doc itself)

14. **Handoff "What Was Done" section 68-77 still described the
    pre-Finding-#11-fix state** (claimed `round1-candidates`/`round1-select`/
    `validate` used `if-no-artifact-found: warn` for the `resumed-checkpoints`
    bundle downloads) even though Finding #11's own fix (further down the same
    doc) correctly recorded that `if-no-artifact-found` was removed because v4
    doesn't support it. **Confirmed as a real doc-only inaccuracy** by
    re-reading the actual current `ai-sweep.yml`: none of the three
    `resumed-checkpoints` pattern-based downloads (in `round1-candidates`,
    `round1-select`, `validate`) use `if-no-artifact-found` — they rely on the
    documented v4 zero-match-pattern-is-a-no-op behavior. The 7
    `if-no-artifact-found: warn` occurrences that DO exist in the file (e.g.
    `round1-select`'s unrelated `round1-candidates`/`round1-shard-*`
    downloads) are pre-existing on `main`, confirmed via
    `git diff origin/main...HEAD -- .github/workflows/ai-sweep.yml` showing
    zero added/changed `if-no-artifact-found` lines. **Fixed**: rewrote the
    "What Was Done" paragraph to accurately state all three jobs' resumed-
    checkpoints downloads are bare `pattern:`-based with no
    `if-no-artifact-found`, and to explicitly note the pre-existing/unrelated
    occurrences elsewhere are out of scope. No code change was needed — the
    implementation was already correct; only the doc text lagged it.

## Verification Run

- `npx tsc --noEmit` (via `npm run typecheck`) — clean, re-verified after all
  review-driven fixes.
- Targeted unit suites — 99/99 passed (84 original + 13 round-1 fixes + 2 new
  for round-2's `secondary` provenance fix; round-2's `if-no-artifact-found`
  fix updated 1 existing assertion rather than adding a test; round-3's
  Finding #14 was doc-only, no test impact):
  `npx vitest run tests/unit/ai-sweep-workflow.test.ts tests/unit/ai/sweep-round-plan.test.ts`.
- `bash scripts/agent/verify-fast.sh` (`npm run verify:fast`) — GREEN.
- `npm run review:ledger -- validate` — valid 2-apple ledger (no stages
  required).
- `npm run verify:pr-prereqs` — GREEN, re-run after the fixes.

## Observe Before Done (rule #10)

This change is entirely GitHub Actions YAML scheduling/orchestration plus
pure TypeScript CLI/provenance-check logic (`round-plan.ts`,
`sweep-eval.ts --print-meta`) — it does **not** touch any runtime `*System`,
so there is no lab/wiring obligation (rule #9 N/A). Verification consisted of
(a) direct end-to-end re-reading of every `if:`/`download-artifact`/
`upload-artifact` step in the rewritten YAML, including a full re-derivation
of which jobs' matrix sources changed and which needed zero changes, (b) the
`yaml`-parser-backed workflow-guard tests asserting the resume-support
structure (conditional download, tier order, matrix caps) actually parses as
intended, and (c) direct source-level tracing of `planCandidates`/
`applyRoundResult` confirming round-boundary resume is semantically correct,
not just assumed. Per the task's explicit instruction, **the actual AI Sweep
was NOT dispatched or resumed from this session** — the parent session
(`5392703e-46a9-4d27-a466-3d0af0a09c72`) owns that step after merge.

**Residual limitation** (unchanged from the prior 2026-07-19 handoff, still
applies): the resume path has not yet been observed running end-to-end
against real GitHub Actions cross-run artifact retention/expiry behavior —
its first real dispatch with a non-blank `resume_run_id` should be watched
for actual cross-run download timing/size and for the `continue-on-error`
degrade-to-fresh path firing correctly if the referenced run's artifacts have
since expired or never existed.

## Unresolved / Next Steps

1. **UPDATED (post-stacking, supersedes the original point 1 below):**
   `workflowSha` was subsequently EXCLUDED from `assertResumeCompatible`'s
   hard-fail set (it is `GITHUB_SHA` at record time, guaranteed to differ
   across runs/commits, so hard-equality on it would make cross-run resume
   permanently impossible for any run after the first commit touching this
   workflow — defeating the exact scenario this feature exists for). What
   still governs comparability is schemaVersion/floorId/budgetMs/maxFrames,
   stage, runnerOs/nodeVersion/packageLockHash, and TRAIN
   seeds/weapons/secondary via `runInputs` — all still fully enforced.
   **However, dispatching `resume_run_id: 29786216369` will still resume
   ZERO combos for a different, more fundamental reason:** `runInputs` is
   brand-new in this PR, so run 29786216369's own checkpoints all predate it
   and have `runInputs === undefined`. `assertResumeCompatible` unconditionally
   fails closed on a missing `runInputs` (cannot verify an old checkpoint's
   TRAIN seed panel/weapon/knob-set), so every combo from that specific run
   falls back to fresh with a visible `::warning::`. This is correct
   fail-closed behavior by explicit design (not a bug, and not fixable within
   the 2🍎/no-refactor cap without either weakening the safety check or
   fetching external run metadata) — **only runs dispatched AFTER this
   feature merges are resumable.** The original point 1 below (about
   `workflowSha` alone blocking resume) is now stale/superseded; kept for
   history.
2. ~~First real resume dispatch — expect a full fresh run, not a resume, for
   run 29786216369 specifically. Because `workflowSha` = `GITHUB_SHA` and
   this PR's merge commit necessarily produces a new SHA (see Finding #7
   above), dispatching `resume_run_id: 29786216369` immediately after merge
   will resume zero combos...~~ (superseded by point 1 above — `workflowSha`
   is no longer a hard-fail field; the real blocker is the `runInputs` gap).
3. Report the PR link + merge commit back to the requesting session
   (`5392703e-46a9-4d27-a466-3d0af0a09c72`), flagging point 1 above.
4. Flag the round-2 Findings #12/#13 apple-scope disagreement (2🍎 declared
   vs. reviewer's 3🍎 argument) to the parent session for human awareness —
   not resolved unilaterally in either direction, per instruction.

## Stacked-PR Reconciliation + Final Merge Outcome (added post-hoc)

PR #1754 was blocked in the repo's FIFO merge-train queue behind PR #1735
(`nalfeo-ai-sweep-net-win-promotion`, a real content conflict, not a false
positive) and, per explicit parent instruction (session
`5392703e-46a9-4d27-a466-3d0af0a09c72`), was converted into a stacked PR
directly onto #1735's exact head (`df498098af152cfa90eb144224c7a28c4ea6c74e`)
rather than waiting for #1735 to land first.

- **Reconciliation method**: `git rebase --onto` was tried first and rejected
  after it silently dropped the `hasFreshCombos` output/guard with no
  conflict marker — a real, dangerous data-loss failure mode of git's diff3
  merge, not a hypothetical concern. All 8 overlapping files (`round-plan.ts`,
  `sweep-eval.ts`, `aggregate-shards.ts`, `ai-sweep.yml`, and their test/doc
  files) were instead reconciled by hand: non-overlapping files copied
  wholesale from #1735, overlapping files rebuilt from #1735's base with this
  PR's changes manually spliced back in and verified via typecheck + targeted
  tests after each file. Final commit (`23e38148`, later amended to
  `f91d3667` with review-finding fixes) reduced to exactly 8 truly-differing
  files vs #1735's head — confirmed via `git reset --soft` onto #1735's tip
  and re-diffing, proving the wholesale copies were byte-identical and no
  content was lost or duplicated.
- **`workflowSha` fix**: made as part of this same reconciliation (see point 1
  above) — this was the parent's explicitly stated blocker for resuming run
  29786216369 post-merge; it is now fixed. The separate `runInputs` gap (also
  described above) was found and is NOT fixable within this PR's declared
  scope; it is disclosed rather than hidden.
- **Base changed** to `nalfeo-ai-sweep-net-win-promotion` via
  `gh api -X PATCH repos/nalfeo/Crawler/pulls/1754 -f base=...` (explicit
  REST call, per parent's literal instruction, rather than `gh pr edit
--base`, even though the latter also uses the same REST endpoint
  internally).
- **Merge outcome**: PR #1754's previously-armed `gh pr merge --auto --squash`
  fired as soon as the stacked base became mergeable — **before** a final
  round of 4 review-finding fixes (secondary-field wording in the handoff
  doc, and 3 "byte-identical"/"exactly as before" scheduling-accuracy
  corrections) could be pushed to it. Those fixes therefore landed as a
  separate tiny follow-up, **PR #1756** (`nalfeo-ai-sweep-resume-wording-fix`,
  wording/doc-comment-only, 3 files, +18/-9, no behavior change), stacked
  on top of #1754's merge commit and targeting the still-open
  `nalfeo-ai-sweep-net-win-promotion` branch. Both #1754 and #1756 are now
  MERGED (commits `0cea2fd4` and `eaae25d7` respectively) onto that branch,
  which remains open against `main` as PR #1735. All originally-unresolved
  review threads on #1754 were replied to with `✅ Addressed in eaae25d7 (PR
#1756)...` markers and explicitly resolved via the GraphQL
  `resolveReviewThread` mutation (the automated ci-recovery reconciler only
  sweeps open PRs, so it would not have picked these up on its own once
  #1754 had already merged).
- **Net-win promotion logic** (#1735's own scope) verified preserved
  byte-for-byte throughout — confirmed via the clean, minimal 8-file
  incremental diff and by re-running the full 202-test combined suite
  (`ai-sweep-workflow.test.ts` + `sweep-round-plan.test.ts` +
  `sweep-aggregate-shards.test.ts` + `sweep-eval-search-promotion.test.ts`)
  both before and after the stacking work.
- This feature's own AI Sweep was **not** dispatched or resumed from any
  session in this chain, per instruction — that remains the parent session's
  responsibility once #1735 itself merges to `main`.
