# Session Handoff: Merge-train rollback/status/hydration recovery fixes (issue #1151)

## Date

2026-07-15

## Persona

Producer

## Systems touched

ci-policy

## Apples

4🍎 estimated and actual — three distinct fail-closed/recovery gaps across
rollback, status/postconditions, and API-representation hydration, each
requiring both a code fix and new deterministic test coverage, plus ADR/issue
doc updates and (per this apple tier) an adversarial plan review and
multi-model code review with adjudication before PR.

## What Was Done

PR #1148 (ADR 0062) shipped the ruleset-based fix for `GH006` (tooling only —
DEC-015 deliberately deferred the live `enable` cutover). This session
implements and ships issue #1151's two listed gaps, plus a **third gap
discovered live** during today's actual first cutover attempt, which caused a
real (if brief and self-correcting) production incident.

### Gap 1 — rollback recovery when the live ruleset's bypass actor is missing/drifted

`buildRulesetDisablePayload()` (`.github/scripts/merge-train/protection-lib.mjs`)
is rewritten to be **shape-preserving and non-throwing**: it copies
`name`/`target`/`conditions`/`rules`/`bypass_actors` verbatim from the live
ruleset and only overrides `enforcement: 'disabled'`. The old
`requireTrainBypassId()` helper (which threw when the live ruleset had no
Integration bypass actor to preserve) is removed entirely. An optional,
independently-supplied `trainAppId` (from `--app-id`/`MERGE_TRAIN_APP_ID`) is
used **only** as a repair fallback to populate `bypass_actors` when the live
ruleset has none at all — live shape always wins when both exist, since
disabling makes `rules`/`bypass_actors` functionally inert and there is no
correctness reason to require a "clean" actor before disabling. `rollback()`
in `protection.mjs` now passes `{ trainAppId: appId }` at its disable call
site.

### Gap 2 — status/postconditions must flag missing classic protection (404), not treat null as "checks disabled"

Added a new `classic.missing` field to `printStatus()`'s report (via the
existing pure `classicProtectionMissing()` helper, previously only used by
`enable()`'s/`rollback()`'s early read-time guard). `classicStatusChecksDisabled()`
itself is intentionally left unchanged — its doc comment already documents
it's blind to the 404-vs-disabled distinction. Instead, `enable()`'s and
`rollback()`'s **final** postcondition checks now also fail if
`report.classic.missing` is true, closing the gap where classic protection
vanishing out-of-band between a mutation and its postcondition read (losing
conversation-resolution/force-push/admin-enforcement settings along with the
status-check requirement) could be silently read as "already migrated."

### Gap 3 (new, live-reproduced 2026-07-15) — ruleset list-summary vs. full-detail hydration

**This is the gap that actually caused an incident today.** `enable
--app-id 4106541` correctly created ruleset id `19000576` (independently
verified via `GET /repos/nalfeo/Crawler/rulesets/19000576`: target
`refs/heads/main`, both `ci`/`merge-train` required checks, `strict: true`,
exactly one Integration bypass actor) at `09:08:47-07:00`, then disabled
classic `ci`. But `enable()`'s own trailing call to the shared `printStatus()`
validated the ruleset using the **list endpoint's** returned object
(`GET /repos/{owner}/{repo}/rulesets` returns only `id`/`name`/`target`/
`enforcement` — no `conditions`, `rules`, or `bypass_actors`) instead of
re-fetching detail via `GET /repos/{owner}/{repo}/rulesets/{id}`.
`rulesetProblems()` therefore saw an object with an empty ref scope, no
required-checks rule, and no bypass actor, reported the ruleset as completely
broken, and `enable()`'s final postcondition threw — triggering an automatic
(correct-given-the-false-input, but factually unnecessary) `rollback` that
disabled the genuinely-correct ruleset ~27 seconds later at `09:09:14-07:00`.

`enable()`'s own **internal** postcondition check (right after create/update)
was never affected — it already called `getRuleset(id)` directly. Only the
**shared** `printStatus()` path — used by both `enable()`'s and `rollback()`'s
_final_ postcondition — had the bug, which is why the incident presented as
"`enable` appeared to succeed internally, then immediately reported failure
and rolled itself back."

Fix: `printStatus()` now does
`const ruleset = rulesetSummary ? await api.getRuleset(rulesetSummary.id) : null;`
immediately after `findRulesetByName()` locates the summary in the list
result, and validates only the hydrated object.

### Test coverage

- `protection-lib.test.mjs`: replaced 2 old `buildRulesetDisablePayload` tests
  with 4 (shape-preservation, missing-actor recovery without throwing,
  trainAppId-as-fallback repair, live-shape-wins-over-supplied-id). Added a
  direct unit test for `classicProtectionMissing()` distinguishing 404 from
  "exists but disabled."
- `protection.test.mjs`: the in-memory fake `api`'s `getRulesets()` now
  returns **stripped summary objects** (`id`/`name`/`target`/`enforcement`
  only) distinct from `getRuleset(id)`'s full detail — matching GitHub's real
  API shape. The previous fake returned identical full objects from both
  endpoints, which is exactly why gap 3 went undetected by the 15/15-green
  suite that shipped with #1148. Added 9 new orchestration tests: rollback
  recovery from a broken ruleset (with and without `--app-id`); `printStatus`
  reporting `classic.missing`; `enable`'s and `rollback`'s final postconditions
  failing closed if classic protection vanishes mid-flight; a genuinely
  correct ruleset visible only as a stripped list-summary reporting zero
  problems once hydrated; `enable` against a fresh repo not false-failing its
  own postcondition; and a ruleset matching by name but with hydrated detail
  revealing a real drift still reporting that problem (proving hydration is
  used for validation, not just fetched and discarded).
- **Result: 46/46 tests green** (`node --test protection-lib.test.mjs
protection.test.mjs`). Full `npm run typecheck` clean. `npm run verify:fast`
  passed (`.github/scripts/` is outside `npm run lint`'s scope — confirmed
  the same 13 pre-existing `no-undef: process` lint findings exist identically
  on the pre-session `HEAD`, so out of scope for this fix). `npm run scope`
  reports `gameplay_safe=true`/`docs_only=false`/`art_only=false` for this
  change set.
- **Test count after the review harness (below): 53/53 green.** The review
  harness surfaced one blocking and several non-blocking gaps that added 7
  more tests: fail-closed duplicate-ruleset-name handling (`AmbiguousRulesetNameError`,
  3 orchestration tests + 1 unit test) and rollback drift-warning coverage (3
  tests: positive Integration-actor-mismatch case, negative appId-omitted
  case, and non-Integration-actor-type case from the multi-model review).

### Review harness (4🍎 tier: adversarial plan review + code-review loop + multi-model review)

Per the apple-scaled review-harness policy, this 4🍎 change required all three
review stages before PR, recorded in
`docs/knowledge/review-ledgers/2026-07-15-merge-train-rollback-status-hydration-fix.review-ledger.json`
(validates as a complete 4-apple ledger).

- **Adversarial plan review** (`gpt-5.4`, red-teaming ≥2 alternatives):
  returned `approved_with_changes` with 6 concerns, 1 blocking. **Blocking**:
  `findRulesetByName()` used `.find()`, silently returning the first match if
  duplicate-named rulesets existed live — fixed by rewriting it to `.filter()`
  and throw a new exported `AmbiguousRulesetNameError` when more than one
  match exists, fail-closed instead of silent. 4 non-blocking concerns fixed
  (rollback drift-warning log for a mismatched live bypass actor; duplicate-
  ruleset test coverage; two smaller items), 2 deferred with written rationale
  (a dedicated postcondition-verifier extraction and a tri-state
  `classic.missing` semantics — both suggestions/non-blocking, judged
  disproportionate churn for this fix). Recorded as `plan_divergence: minor`
  (additive fixes, not a re-architecture of gaps 1/2/3's core design). See
  ADR 0062 DEC-022 for the full per-concern write-up.
- **Code-review loop** (2-round cap): round 1 found 2 non-blocking
  suggestions (the hydration-fetch race already being an intentional
  fail-closed tradeoff — no fix needed; missing negative test for the
  drift-warning gate when `--app-id` is omitted — fixed). Round 2: clean, no
  remaining concerns.
- **Multi-model review** (`gpt-5.4` + `gemini-3.1-pro-preview`, adjudicated by
  this session): `gpt-5.4` found no issues. `gemini-3.1-pro-preview` found one
  legitimate gap — the drift-warning gate added during plan-review resolution
  gated on `inferTrainAppId(full)` truthiness, which only recognizes
  `actor_type: 'Integration'` bypass actors, so a ruleset tampered to bypass
  via a non-Integration actor type would silently escape the warning even
  though the disable payload still preserves that actor verbatim. Adjudicated
  as valid and fixed: gate now checks `hasLiveActors` (any `bypass_actors`
  entry present) instead of `liveBypassId` truthiness. See ADR 0062 DEC-023.

### Docs

- ADR 0062: added CTX-007 (the live incident narrative) and DEC-019/020/021
  (one per gap), and corrected two stale references to the now-removed
  `requireTrainBypassId()` in DEC-014/DEC-018 to point at DEC-019 instead.
- Issue #1151: commented with the full fix summary (including the newly
  discovered gap 3) and checked off the completed items; the live-cutover
  checklist item remains open until performed post-merge.
- `docs/guides/merge-train.md`: reviewed, no changes needed — it documents
  operator-facing commands/sequencing, not internal API representation
  details, and nothing in it was inaccurate.

## Key Decisions Made

- **Shape-preserving disable over "rebuild from scratch"** for gap 1 — since
  disabling makes `rules`/`bypass_actors` inert, there's no correctness
  benefit to reconstructing an idealized payload, and copying the live
  object's fields verbatim always succeeds regardless of how broken the
  ruleset is.
- **`classicStatusChecksDisabled()` left unchanged; new `classic.missing`
  field added instead** for gap 2 — preserves the pure function's documented,
  already-tested semantics while still closing the postcondition gap at the
  call sites that need the distinction.
- **Fixed the fake `api` to split list-summary from detail** for gap 3 — the
  single most important test-infrastructure change in this session; without
  it, the exact class of bug that caused today's incident would remain
  structurally invisible to the test suite going forward.

## What's Next / Blockers

- **Live cutover has not yet been performed as of this handoff being
  written** — see the PR/session for the post-merge cutover sequence:
  `status` → `enable --app-id 4106541` → confirm classic disabled + ruleset
  `problems: []` → `MERGE_TRAIN_ENABLED=true` → dispatch recovery + train →
  observe at least one real candidate validation and one atomic promotion
  with GitHub merged-state postconditions. If any invariant/config issue
  appears during that cutover, `rollback` first, then fix via a **separate**
  follow-up PR — never weaken an invariant in place to force it through.
- Native GitHub merge queue remains explicitly out of scope/forbidden per
  standing instruction; not evaluated as an alternative in this session
  beyond the existing ADR 0062 ALT-005/006 rejection.

## Retrospective

### Lessons Learned

- A DI-testable fake `api` is only as good as its fidelity to the real API's
  actual shape distinctions. This session's core lesson: the previous fake
  returning identical objects from both the list and detail endpoints wasn't
  just an oversight — it structurally hid the exact bug that later caused a
  live incident. When writing a fake for an external API, deliberately model
  known asymmetries between "list" and "get" endpoints (partial vs. full
  representations), not just the happy-path fields the current code happens
  to read.
- A postcondition check that reuses a shared read function (`printStatus`)
  across multiple call sites (here, both `enable()`'s own internal check AND
  its final trailing check) can have one call site correctly hydrated and
  another not, producing exactly the confusing "succeeded internally, then
  immediately failed and rolled back" symptom seen live. When two call sites
  are meant to check the "same" postcondition, verify they actually share the
  same data-fetching path, not just the same validation function.

### Mistakes Made

- None significant this session — the plan review process for gap 3
  specifically (see review ledger) confirmed the hydration fix and its test
  fixture change were correct on first implementation, likely because the
  live incident already provided a concrete, falsifiable reproduction to
  design against rather than a hypothetical gap.

### Opportunities for Future Improvement

- Consider a lightweight contract test (or a shared fixture helper) that
  asserts, for any GitHub-API-shaped fake used across the merge-train test
  suite, that its list-endpoint fake never includes fields the real GitHub
  list endpoint doesn't return — so future fakes for other resources (e.g. if
  a similar list/detail split exists for branch protection or checks) don't
  quietly reintroduce the same class of bug in a different file.
