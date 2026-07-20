# Session Handoff: Allow net-win incumbent flips in AI Sweep Eval promotion gate

## Date

2026-07-20

## Persona

Implementer (single-system change; separate implementation session spun out
from an investigation session per the "split investigation from landing
implementation" policy). Requested by cross-session message from creator
session `5392703e-46a9-4d27-a466-3d0af0a09c72`, following merged PR #1674
(merge commit `6898da91bd566b8439014ed30309c73db44c275c`).

## Systems touched

ai-combat-balance

## Apples

3🍎 estimated, 3🍎 actual (✅ hit). Single logical rule change (one gate
condition swapped) but propagated across 2 production call sites + 1 workflow
doc + 3 test files, with regression tests reproducing an exact prior incident.
Plan review (gpt-5.4, `plan_divergence: minor`) + a 13-round code-review loop
(19 concerns resolved across rounds 2–10 and 12; rounds 1, 11, and 13 were clean). Full ledger:
`docs/knowledge/review-ledgers/2026-07-20-ai-sweep-net-win-promotion.review-ledger.json`.

## Why

PR #1674 (2026-07-19) introduced a hard "zero win→loss flips vs the LEGACY
incumbent" gate after GH run `29597840666` showed `riskRewardFused+legacy` and
`slackAware+legacy` both out-scoring the incumbent (292/300 = 97.3% wins vs
286/300 = 95.3%) while each had 5 individual seed flips (a seed the incumbent
won that the candidate lost). That gate rejected both candidates outright.

Human review of that incident concluded the zero-flip gate was **too strict**:
both candidates' _net_ win count still strictly increased (292 > 286, i.e. +6
net even after netting out the 5 flip losses against ~11 seed recoveries), so
rejecting them on flip-count alone was throwing away genuine improvements. The
approved fix: stop gating on flip count entirely and gate on the metric that
actually matters — does the candidate's absolute total win count on the fixed
validation panel strictly exceed the incumbent's?

## What Was Done

Replaced the "zero flips" hard-gate clause with a "strictly more total wins
than the incumbent" clause in the shared qualification gate, in both the
production round-DAG path and the legacy/manual hill-climb path (they already
shared one underlying function, so one code change updates both).

### Exact rule change

**Old gate** (`selectQualifiedWinner`, `scripts/agent/perf/aggregate-shards.ts`):
candidate qualifies iff `flipsVsIncumbent === 0 && winRate >= 0.90`.

**New gate**: candidate qualifies iff
`winsVsIncumbentDelta !== null && winsVsIncumbentDelta > 0 && winRate >= 0.90`,
where `winsVsIncumbentDelta = candidateTotalWins - incumbentTotalWins` on the
same fixed validation panel. Flips are no longer disqualifying by themselves —
only a net decrease (or tie) in total wins is. The win-rate floor (≥90%) is
UNCHANGED. Tie-break ordering among qualifiers is UNCHANGED: highest composite
score → faster mean clear time on wins → higher mean minimum HP% → higher mean
XP → higher mean gold.

### Design

Added a new field `winsVsIncumbentDelta: number | null` to `LeaderboardRow`,
computed eagerly inside `buildLeaderboard()` (parallel to the existing
`flipsVsIncumbent`/`winRateDeltaVsIncumbent` informational fields) rather than
lazily inside `selectQualifiedWinner()`. This is required because 2 of the 3
call sites (`round-plan.ts`'s `applyRoundResult`, `sweep-eval.ts`'s
`selectSearchPromotion`) pre-filter the incumbent's own row out before calling
`selectQualifiedWinner` — only `buildLeaderboard()` has the incumbent's rows in
scope to compute its total win count. `flipsVsIncumbent` and
`winRateDeltaVsIncumbent` are KEPT as informational/display-only fields
(still surfaced in the markdown leaderboard and in `sortByLexicographic`'s
diagnostic-only tie-break), no longer used as a hard gate.

`buildLeaderboard()` supports exactly ONE incumbent identity (`incumbentCombo`,
`incumbentConfigId`) per call — documented explicitly on
`BuildLeaderboardOptions` after a plan-review concern about batching rows from
multiple differently-incumbented checkpoints/combos into one call (not
something any current caller does, but now an explicit, tested invariant:
incumbent identity is scoped to the exact `(combo, configId)` pair, not
`configId` alone).

### Files changed

- `scripts/agent/perf/aggregate-shards.ts` — core gate logic: new
  `winsVsIncumbentDelta` field + computation, `selectQualifiedWinner()`'s gate
  condition swapped, doc comments (`BuildLeaderboardOptions`,
  `sortByLexicographic`, `QualifiedSelection`, `selectQualifiedWinner`)
  rewritten to describe the net-win rule and cite the GH-run-29597840666
  scenario as the canonical reproduction case, `renderMarkdown()`'s qualified-
  winner text updated, reason strings updated. **Round 6**:
  `assertRowSafeRoomInRange` changed from private to `export`ed (+ doc comment
  explaining the reuse rationale) so `sweep-eval.ts`'s
  `assertLegacyBaselineProvenance` can validate externally-injected rows with
  the same check used for shard rows.
- `scripts/agent/perf/round-plan.ts` — doc-comment wording only initially;
  logic unchanged (consumes `winsVsIncumbentDelta` transparently via
  `selectQualifiedWinner`). **Round 10**: `assertShardCompatible` refactored
  from `(checkpoint, shard)` to `(expectedMeta: ShardMeta, shard: ShardArtifact,
contextLabel: string)`, adding 4 build-fingerprint checks
  (`runnerOs`/`nodeVersion`/`packageLockHash`/`workflowSha`) matching the ones
  added to `aggregate-shards.ts`/`sweep-eval.ts` in round 9; `applyRoundResult`'s
  call site updated to the new signature; `initCheckpoint` gained a NEW call to
  `assertShardCompatible(baseline.meta, legacyBaseline, ...)` plus a
  row-combo-tag check, closing the gap where the production round-DAG's
  `legacyBaseline` parameter had ZERO provenance validation of any kind (see
  round 10 below). **Round 12**: `assertShardCompatible` gained a `meta.stage`
  equality check (mirroring `mergeShards`' own stage guard); `initCheckpoint`'s
  `legacyBaseline` block gained a config-identity check (every row must
  reference the shard's sole declared config, else the incumbent becomes
  unfindable via `buildLeaderboard`'s `(incumbentCombo, incumbentConfigId)`
  lookup) and a per-row `assertRowSafeRoomInRange` loop, closing the last gap
  between this path and `sweep-eval.ts`'s `assertLegacyBaselineProvenance`.
- `scripts/agent/perf/sweep-eval.ts` — doc-comment wording updated (round 3);
  **Round 4**: added `incumbentCombo?` param to `selectSearchPromotion`,
  `legacyBaseline?` threading in `searchCombo` (mirrors `initCheckpoint`),
  `--legacy-baseline` CLI flag for `--stage search`, and `LEGACY_COMBO_ID`
  import from `gen-configs.js`. **Round 5**: `searchCombo` now automatically
  computes the LEGACY baseline inline (one extra headless eval pass via
  `register()`/`buildTasks()`/`runTasks()`) whenever `opts.legacyBaseline` is
  omitted, so correctness of the non-LEGACY-combo incumbent threading no
  longer depends on remembering to pass `--legacy-baseline`; the flag is now
  purely a perf optimization to reuse a precomputed LEGACY shard across
  multiple combo searches in one session. **Round 6**: added
  `assertLegacyBaselineProvenance()` (exported), which validates a supplied
  `--legacy-baseline` artifact — single-config invariant, all rows tagged
  `combo === LEGACY_COMBO_ID`, schema/stage/floorId/budgetMs/maxFrames via the
  existing `assertSearchArtifactProvenance()`, and per-row `safeRoomMs` via the
  newly-exported `assertRowSafeRoomInRange()` — before it is injected as the
  search's fixed incumbent; `searchCombo`'s `if (opts.legacyBaseline)` branch
  now calls this single validator instead of an ad-hoc inline config-count
  check. **Round 9**: `assertLegacyBaselineProvenance`'s `expected` param
  extended with 4 build-fingerprint fields (`runnerOs`/`nodeVersion`/
  `packageLockHash`/`workflowSha`), refactored to require the CALLER to supply
  these (rather than compute them internally via `currentBuildFingerprint()`)
  so unit tests can inject deterministic fixture values instead of depending on
  the real host's OS/Node/dependency hash; new `currentBuildFingerprint()`
  helper (also used by `buildMeta`); `searchCombo`'s call site updated to pass
  `...currentBuildFingerprint()`. **Round 10**: `currentBuildFingerprint()`'s
  `nodeVersion` truncated to major-version-only (`process.version.match(/^v\d+/)`)
  and exported, so a mid-run Node PATCH bump (GitHub's `setup-node@v4` only
  pins the major version) can no longer cause a false rejection between two
  jobs of the same multi-hour workflow run.
- `.github/workflows/ai-sweep.yml` — header comment wording updated to
  describe the new rule.
- `tests/unit/ai/sweep-aggregate-shards.test.ts` — reworked graduation-
  scenario test (now rejects on a wins-TIE, not the flip itself); new
  `netWinRegressionRows()` test reproducing the exact 292/300-vs-286/300-with-
  5-flips scenario now qualifying; new isolated reject-on-tie and reject-on-
  decrease tests; reworked below-90%-floor test to isolate the floor clause
  from the win-count clause; new incumbent-identity-scoping regression test.
  **Round 9**: 4 new regression tests for `assertSearchArtifactProvenance`'s
  build-fingerprint checks (mirrors the sweep-eval.ts suite below).
- `tests/unit/ai/sweep-round-plan.test.ts` — header doc comment rewritten;
  several fixtures adjusted so candidates have strictly-more (not tied) wins
  where the test's intent required a genuinely qualifying candidate. **Round
  10**: 4 new regression tests for `initCheckpoint`'s new legacyBaseline
  validation (row-combo-tag mismatch, schemaVersion mismatch, nodeVersion
  mismatch, workflowSha mismatch). **Round 12**: 3 new regression tests for
  `initCheckpoint`'s legacyBaseline stage mismatch, out-of-range `safeRoomMs`
  row, and a row referencing a configId other than the shard's sole declared
  config.
- `tests/unit/ai/sweep-eval-search-promotion.test.ts` — new mirrored
  292/300-vs-286/300 qualifying test at the legacy-path level (proves both
  paths share the identical rule via `selectSearchPromotion`); reworked tie-
  rejection and out-score-isolation tests; **Round 4**: added 2 new regression
  tests for the non-LEGACY combo path (one confirming promotion qualifies with
  correct `incumbentCombo='legacy+legacy'`, one confirming disqualification when
  `incumbentCombo` is omitted and the incumbent rows carry the legacy tag).
  **Round 6**: added an 8-test `assertLegacyBaselineProvenance` suite — accepts
  a well-formed artifact; rejects >1 config; rejects mixed/wrong combo tags;
  rejects stale `schemaVersion`, `floorId` mismatch, `budgetMs` mismatch,
  `maxFrames` mismatch; rejects a row missing `safeRoomMs`. **Round 9**: 4 new
  regression tests for `assertLegacyBaselineProvenance`'s build-fingerprint
  checks (runnerOs/nodeVersion/packageLockHash/workflowSha mismatches).
  **Round 10**: 2 new tests for `currentBuildFingerprint`'s major-version
  truncation and `runnerOs` format.
- `docs/knowledge/handoffs/2026-07-19-ai-sweep-eval-parallel-rounds.md` —
  added a superseded-notice pointing here so operators reading that handoff
  don't apply the now-replaced zero-flip rule.
- `scripts/agent/perf/aggregate-shards.ts` — **Post-review (CI security +
  duplicate-row guard)**: `buildLeaderboard` now requires exactly one row per
  `(weapon, seed)` cell in both the candidate group and the incumbent group
  before computing `winsVsIncumbentDelta`; a duplicate winning row can no longer
  inflate `wins`/`runs` past the panel check and produce a false positive delta.
  Two regression tests added covering both the candidate-duplicate and
  incumbent-duplicate cases.
- `package.json` / `package-lock.json` — added `brace-expansion: ^5.0.7`
  override to fix security vulnerability GHSA-3jxr-9vmj-r5cp, surfaced by the
  CI security check during PR shepherding. Validated: `npm install` updated
  the lockfile; `npm run verify:fast` and the CI security check both pass.

### Scoped out

`scripts/agent/perf/ab-pathing-mode.ts` / `ab-decision-mode.ts` — these use a
separate zero-flip gate for a different purpose (proving A/B byte-identity /
behavioral equivalence for decision-mode changes, not sweep promotion
ranking). Confirmed with the requester that "legacy/manual promotion path"
means `sweep-eval.ts`'s `--stage search` hill-climb only. Not touched.

No ADR was needed (single-system change, not affecting 2+ systems).

## Verification

- `npx tsc --noEmit` — clean, no errors.
- `npx vitest run tests/unit/ai/sweep-aggregate-shards.test.ts
tests/unit/ai/sweep-round-plan.test.ts
tests/unit/ai/sweep-eval-search-promotion.test.ts` — **129/129 passing**
  (including the two mirrored 292/300-vs-286/300 regression tests at the
  aggregate-shards and legacy-path levels, the wins-tie rejection test, the
  wins-decrease rejection test, the isolated below-90%-floor test, the
  incumbent-identity-scoping test, 2 non-LEGACY combo path tests, the 8-test
  `assertLegacyBaselineProvenance` suite, 8 build-fingerprint regression tests
  across both provenance-check call sites, 4 `initCheckpoint` legacyBaseline
  provenance tests, 2 `currentBuildFingerprint` truncation tests, and 3
  round-12 `initCheckpoint` legacyBaseline stage/safeRoomMs/config-identity
  tests).
- `npx vitest run tests/unit/ai` (full AI suite) — **326/326 passing**.
- `npm run verify:fast` — ✅ passed (typecheck + lint + changed tests + size/
  weight/physics-defs coverage checks).
- `npm run verify:pr-prereqs` — checked after handoff + ledger were committed.
- Review harness (3🍎 tier): plan review (gpt-5.4, `plan_divergence: minor`,
  4/4 concerns resolved — addressed single-incumbent-invariant documentation +
  test, `sortByLexicographic` diagnostic-only doc clarification, superseded-
  notice on the prior handoff) + 13-round code-review loop (19 concerns
  resolved, rounds 1, 11, and 13 clean):
  - **Round 1** (claude-sonnet-4.6): 0 concerns, clean.
  - **Round 2** (github-copilot-pr-reviewer + claude-sonnet-4.6): 4 concerns,
    all resolved — added `samePanel` Set-equality guard on `winsVsIncumbentDelta`
    in `aggregate-shards.ts`, redesigned the decrease-rejection test to isolate
    the decrease clause from the 90%-floor clause (10-seed same-panel fixture),
    fixed a broken markdown paragraph in this handoff, corrected an inaccurate
    test comment in `sweep-eval-search-promotion.test.ts`.
  - **Round 3** (github-copilot-pr-reviewer): 4 concerns, all resolved — 2
    genuine (sweep-round-plan partial-round test and sweep-eval-search-promotion
    out-score-isolation test had mismatched candidate/incumbent panels; fixed by
    adding the missing cells to the incumbent as losses); 2 stale (GitHub line-
    remap landed old comments onto already-correct lines).
  - **Round 4** (github-copilot-pr-reviewer): 1 concern, resolved — the legacy
    `--stage search` path (`selectSearchPromotion`) did not thread `incumbentCombo`
    correctly for non-LEGACY combos: it passed `comboStr` as `incumbentCombo` to
    `buildLeaderboard` even when the LEGACY incumbent rows carried `combo:
'legacy+legacy'`, making `winsVsIncumbentDelta` null for all candidates and
    permanently disqualifying them. Fixed by adding `incumbentCombo?` param to
    `selectSearchPromotion` and mirroring `initCheckpoint`'s LEGACY-baseline
    threading in `searchCombo` (+ `--legacy-baseline` CLI flag).
  - **Round 5** (github-copilot-pr-reviewer): 1 concern, resolved — the round-4
    fix's `--legacy-baseline` flag was opt-in only, so the default invocation
    (no flag) silently preserved the original bug. `searchCombo` now
    automatically computes the LEGACY baseline inline whenever the flag is
    omitted, so correctness no longer depends on remembering to pass it; the
    flag is now purely a perf optimization to reuse a precomputed LEGACY shard.
  - **Round 6** (github-copilot-pr-reviewer): 1 concern, resolved — the
    `--legacy-baseline` artifact was consumed with no provenance or row
    validation (stale/wrong-floor/pre-v2-schema data could silently corrupt the
    incumbent's win count). Added `assertLegacyBaselineProvenance()`, reusing
    `assertSearchArtifactProvenance()` and the newly-exported
    `assertRowSafeRoomInRange()`, plus an 8-test regression suite.
  - **Round 7** (github-copilot-pr-reviewer): 1 concern, resolved — the PR
    description itself was stale relative to the committed ledger/handoff
    (reported 101 targeted tests and a single clean round vs. the durable
    119/6-round record). Fixed by rewriting the PR description via the GitHub
    API to match. Docs/process-only finding, no code change.
  - **Round 8** (github-copilot-pr-reviewer): 1 concern, resolved —
    `.github/workflows/ai-sweep.yml`'s checkpoint-init job comments still
    called the safety gate a "flip check" that rejects any flip (the
    superseded zero-flip wording). An automated `copilot-swe-agent[bot]` push
    (commit `b8e97f2b`) fixed the wording to describe the net-win comparison
    actually enforced; this session verified the fix was adequate and reset to
    it rather than duplicate it. A companion bot commit (`dabe0e82`) also
    corrected a stale test-count arithmetic error in this handoff (46 claimed
    vs. 39 actual for `sweep-round-plan.test.ts`, total corrected 119→112); the
    PR description was updated to match. No production code change.
  - **Round 9** (github-copilot-pr-reviewer): 2 concerns, resolved —
    `assertSearchArtifactProvenance` validated schema/stage/floor/budget/frames/
    combo but NOT the build fingerprint (`runnerOs`/`nodeVersion`/
    `packageLockHash`/`workflowSha`) that `mergeShards`'s per-shard checks DO
    enforce, so a stale `--legacy-baseline` artifact from a different code/
    runtime build could silently pass; also a stale doc comment above
    `selectSearchPromotion`'s call site. Fixed by extending
    `assertSearchArtifactProvenance`'s `expected` param to require and check
    the 4 fingerprint fields, adding `currentBuildFingerprint()`, and
    correcting the comment. This round also surfaced a meta finding: rounds
    2–8 were all recorded `clean:true` despite `concerns_count>0`, contradicting
    the review-harness's per-round semantics — fixed by retroactively
    correcting rounds 2–9's `clean` flag to `false`.
  - **Round 10** (independent background code-review agent,
    `round9-fingerprint-review`): 2 concerns, resolved — round 9's fix only
    protected `sweep-eval.ts`'s local/manual `--stage search` path; the actual
    PRODUCTION round-DAG path (`round-plan.ts`'s `initCheckpoint`/
    `assertShardCompatible`, called by every `checkpoint-init`/`round*-select`
    workflow job) had ZERO build-fingerprint validation, and `initCheckpoint`
    had ZERO provenance validation of any kind on `legacyBaseline` — the exact
    gap the task explicitly named ("update both production round-DAG and
    legacy/manual promotion paths"). Also flagged a speculative Medium risk:
    comparing the full `process.version` could false-reject across a
    multi-hour run since `setup-node@v4` only pins the Node MAJOR version.
    Fixed by extending `assertShardCompatible` with the same 4 fingerprint
    checks, adding a new `initCheckpoint` legacyBaseline validation call plus a
    row-combo-tag check, and truncating `currentBuildFingerprint()`'s
    `nodeVersion` to major-version-only.
  - **Round 11** (independent background code-review agent,
    `round10-provenance-review`): 0 concerns, clean — a further independent
    pass specifically targeting round 10's diff (ran `git diff`, `git stash`/
    `stash pop` test-count comparison, `tsc --noEmit`, `eslint`) found no
    genuine code issues: the refactor is applied consistently, the new
    `initCheckpoint` check compares against the correct reference
    (`baseline.meta`, not a live-computed fingerprint), the existing
    LEGACY-incumbent test path is unaffected, the `nodeVersion` truncation is
    applied symmetrically, and no call site was missed. Honest, independently-
    earned terminal clean round.
  - **Round 12** (github-copilot-pr-reviewer): 2 concerns, resolved — a fresh
    GraphQL `reviewThreads` query in a follow-up shepherding session surfaced
    2 previously-unaddressed threads: (a) `initCheckpoint`'s `legacyBaseline`
    validation still fell short of `assertLegacyBaselineProvenance` in two
    ways — `assertShardCompatible` didn't check `meta.stage`, and
    `legacyBaseline`'s rows were injected with no per-row `safeRoomMs` check
    and no check that every row references the shard's sole declared config
    (a mismatch there would silently make the incumbent unfindable via
    `buildLeaderboard`'s lookup, disqualifying every candidate rather than
    failing fast); (b) the PR description had drifted stale again relative to
    the committed ledger/handoff. Fixed by adding the `meta.stage` check to
    `assertShardCompatible`, a config-identity check, and a per-row
    `assertRowSafeRoomInRange` loop over `legacyBaseline.rows`; re-synced the
    PR description. 3 new regression tests added.
  - **Round 13** (independent background code-review agent,
    `round12-baseline-boundary-review`): 0 concerns, clean — re-verified
    `tsc`/`eslint`/tests independently, traced the stage check's correctness
    against `sweep-eval.ts`'s stage-stamping semantics, confirmed the new
    tests genuinely exercise the new code paths (not an earlier check), and
    confirmed no call site was missed. Flagged (not counted as a concern,
    out of scope for this finding) that `applyRoundResult`'s own candidate-
    shard merge loop still lacks a per-row `safeRoomMs` check — a real,
    pre-existing gap unrelated to the baseline-boundary finding this round
    addressed. Honest, independently-earned terminal clean round.
    Ledger:
    `docs/knowledge/review-ledgers/2026-07-20-ai-sweep-net-win-promotion.review-ledger.json`.
- Apple record: `docs/knowledge/metrics/apples/2026-07-20-ai-sweep-net-win-promotion.json`
  (3🍎 estimated → 3🍎 actual, exact).

## Deferred / explicitly out of scope

- **AI Sweep Eval dispatch**: NOT run from this session. The creator session
  (`5392703e-46a9-4d27-a466-3d0af0a09c72`) will dispatch the sweep after this
  PR merges, per explicit instruction.
- `ab-pathing-mode.ts`/`ab-decision-mode.ts`'s separate zero-flip gate — out of
  scope, unrelated purpose (see "Scoped out" above).

## Unresolved issues / recommended next steps

None outstanding. The rule change is self-contained and fully covered by the
regression tests. If a future incident finds the net-win rule itself too
permissive (e.g. a candidate improves net wins by 1 while flipping 20 seeds),
that would be a new human-approved policy question, not a bug in this change.
