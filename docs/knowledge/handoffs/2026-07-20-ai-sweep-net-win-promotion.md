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
Plan review (gpt-5.4, `plan_divergence: minor`) + a 6-round code-review loop
(11 concerns resolved across rounds 2–6; round 1 was clean). Full ledger:
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
- `scripts/agent/perf/round-plan.ts` — doc-comment wording only; logic
  unchanged (consumes `winsVsIncumbentDelta` transparently via
  `selectQualifiedWinner`).
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
  check.
- `.github/workflows/ai-sweep.yml` — header comment wording updated to
  describe the new rule.
- `tests/unit/ai/sweep-aggregate-shards.test.ts` — reworked graduation-
  scenario test (now rejects on a wins-TIE, not the flip itself); new
  `netWinRegressionRows()` test reproducing the exact 292/300-vs-286/300-with-
  5-flips scenario now qualifying; new isolated reject-on-tie and reject-on-
  decrease tests; reworked below-90%-floor test to isolate the floor clause
  from the win-count clause; new incumbent-identity-scoping regression test.
- `tests/unit/ai/sweep-round-plan.test.ts` — header doc comment rewritten;
  several fixtures adjusted so candidates have strictly-more (not tied) wins
  where the test's intent required a genuinely qualifying candidate.
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
  `maxFrames` mismatch; rejects a row missing `safeRoomMs`.
- `docs/knowledge/handoffs/2026-07-19-ai-sweep-eval-parallel-rounds.md` —
  added a superseded-notice pointing here so operators reading that handoff
  don't apply the now-replaced zero-flip rule.

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
tests/unit/ai/sweep-eval-search-promotion.test.ts` — **112/112 passing**
  (58 + 39 + 15, including the two mirrored 292/300-vs-286/300 regression tests
  at the aggregate-shards and legacy-path levels, the wins-tie rejection test,
  the wins-decrease rejection test, the isolated below-90%-floor test, the
  incumbent-identity-scoping test, 2 non-LEGACY combo path tests, and the
  8-test `assertLegacyBaselineProvenance` suite).
- `npx vitest run tests/unit/ai` (full AI suite) — **309/309 passing**.
- `npm run verify:fast` — ✅ passed (typecheck + lint + changed tests + size/
  weight/physics-defs coverage checks).
- `npm run verify:pr-prereqs` — checked after handoff + ledger were committed.
- Review harness (3🍎 tier): plan review (gpt-5.4, `plan_divergence: minor`,
  4/4 concerns resolved — addressed single-incumbent-invariant documentation +
  test, `sortByLexicographic` diagnostic-only doc clarification, superseded-
  notice on the prior handoff) + 6-round code-review loop (11 concerns
  resolved):
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
    `assertRowSafeRoomInRange()`, plus an 8-test regression suite. Ledger:
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
