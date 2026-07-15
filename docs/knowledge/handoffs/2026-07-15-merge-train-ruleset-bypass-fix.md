# Session Handoff: Merge-train ruleset bypass fix (GH006)

## Date

2026-07-15

## Persona

Producer

## Systems touched

ci-policy

## Apples

3🍎 actual (rescored down from an initial 4🍎 estimate — production fix +
tooling + ADR + doc rewrite + review harness; live cutover deliberately
deferred out of this PR's scope, see DEC-015)

## What Was Done

PR #1143 merged the build-expiry train, but promotion of the next candidate
(SHA `cd609b7`, PRs #1087/#1092/#1099/#1140/#1141) failed atomically with
GH006: classic branch protection's `required_status_checks` has **no**
per-App bypass mechanism, so the trusted `Crawler CI` GitHub App (id
`4106541`) could not push the reattested candidate straight to `main` even
though fast+security validation had passed. No refs moved (fail-closed, as
designed) — but the train was stuck with `MERGE_TRAIN_ENABLED=false`.

Root-caused and fixed by moving live status-check enforcement off classic
protection and onto a dedicated **repository ruleset** targeting
`refs/heads/main`, which _does_ support `bypass_actors` with
`actor_type: 'Integration'`:

- New ruleset requires ordinary `ci` (Actions app id `15368`) **and**
  `merge-train` (Crawler CI app id `4106541`) status checks, strict mode on,
  for every actor **except** a single bypass actor:
  `{ actor_type: 'Integration', actor_id: 4106541, bypass_mode: 'always' }`.
- Classic protection's `required_status_checks` is set to `null` (disabled,
  not deleted) while the ruleset is live — every other classic setting
  (conversation resolution required, force pushes disabled, admin
  enforcement) is preserved untouched.
- Wrote `.github/scripts/merge-train/protection-lib.mjs` (pure payload
  builders/validators, 20 unit tests) and `.github/scripts/merge-train/protection.mjs`
  (CLI: `status|enable|rollback`, DI-testable via an injected `api` object,
  15 orchestration tests covering ordering/idempotence/fail-closed
  postconditions). Both files fully unit tested — 35/35 pass.
- `enable` order (the safety-critical direction): validate the live classic
  shape read-only first (fail closed before any mutation on drift or a
  missing classic-protection resource) → create/update the ruleset → verify
  its postcondition (ruleset exists, has both required checks, has exactly
  the one App bypass actor) or throw before ever touching classic protection
  → only then disable classic `required_status_checks` → verify the final
  postcondition. Reversing the create/disable order would leave a window
  where neither mechanism enforces `ci` on `main` if ruleset creation fails
  partway.
- `rollback` order (the safety-critical direction): refuse if
  `MERGE_TRAIN_ENABLED=true` unless `--force` → restore classic
  `required_status_checks` to the legacy `ci`-only shape → **then** disable
  (not delete) the ruleset → verify postcondition. This guarantees at least
  one enforcement mechanism (`ci`) is always live on `main`; there is no
  window where neither classic protection nor the ruleset enforces `ci`.
- Both `enable` and `rollback` are idempotent — re-running against an
  already-converged repo is a safe no-op (verified in tests).
- Added `npm run train:protection[:status|:enable|:rollback]` wrappers.
- Rewrote `docs/guides/merge-train.md` ("Required repository configuration",
  "Rollout" + its rollback subsection, "Emergency repair lane") to describe
  the ruleset mechanism instead of the old classic-contexts commands.
  Updated `tests/unit/merge-train-doc-rollback-ordering.test.ts` to match
  the new doc text/marker (still enforces the same ordering invariant via
  literal-text parsing).
- Wrote ADR 0062 (`docs/knowledge/adr/0062-merge-train-ruleset-app-bypass.md`)
  documenting root cause, 18 decisions, consequences, and 5 alternatives
  considered and rejected (classic bypass doesn't exist; running literal
  `ci` on the candidate SHA; native GitHub merge queue — explicitly
  out-of-scope per the request; moving unrelated classic settings into the
  ruleset; deleting vs. disabling the ruleset on rollback).
- **Observed in the real artifact**: ran `npm run train:protection:status
-- --repo nalfeo/Crawler --app-id 4106541` against the live repo — confirmed
  `mergeTrainEnabled: false`, `requiredStatusChecksDisabled: false` (classic
  `ci`/app_id 15368 still active), `ruleset.exists: false`, matching the
  reported live state exactly. **`enable` was deliberately NOT run against the
  live repo in this session** — see "What's Next / Blockers" below (DEC-015):
  running it before this PR merges would self-block this PR's own merge,
  since every non-bypass actor would then need `merge-train` too and nothing
  posts that check for an ordinary PR. The live `status` read above is
  read-only and does not change this.
- Environment fix (unrelated but blocking): this worktree's `node_modules`
  was stale/incomplete (`zod` missing), causing 5 unrelated `test:guards`
  failures. `npm install` fixed it; full `test:guards` now 773 pass/0 fail/
  21 skip (documented Windows subprocess skips).

## Key Decisions Made

- **Ruleset, not classic bypass** — classic protection literally cannot
  express a per-App status-check bypass; only rulesets support
  `bypass_actors`. This is the only supported mechanism, so no alternative
  was viable without weakening the invariant.
- **Disable (`null`), never delete** classic `required_status_checks` — a
  disabled setting is trivially and losslessly restorable by `rollback`;
  deleting the block would lose the legacy shape and require re-deriving it.
- **Disable, never delete, the ruleset on rollback** — same reasoning, and
  it means an accidental early `enable` re-run after a partial rollback
  reactivates cleanly instead of hitting a 404.
- **Rollback restores classic before disabling the ruleset** — the
  safety-critical ordering. Reversing it would create a real window where
  neither mechanism enforces `ci` on `main`. This is enforced by both a
  code-level orchestration test and a doc-level regression test that parses
  the literal guide text.
- **DI refactor of `protection.mjs`** — matched the existing
  `reconcile-lib.mjs` pattern (injected collaborator functions) instead of
  calling `request()` directly, specifically so the ordering/idempotence
  logic could be unit tested without a network mock framework.
- **Native GitHub merge queue is out of scope** — explicitly excluded per
  the request; not evaluated as an alternative beyond noting it in the ADR
  for completeness, since it would replace the repo-managed train
  architecture (ADR 0060) rather than fix its bypass gap.

## What's Next / Blockers

- **Live `enable` must run strictly AFTER this PR merges, never before.**
  Verified via live `status` reads and by reasoning through the ruleset
  semantics: once the ruleset is active, every non-bypass actor (including
  an ordinary `gh pr merge` on this very PR) must satisfy **both** `ci` and
  `merge-train` before merging to `main`. Nothing posts a `merge-train`
  check for an ordinary PR (only the merge-train pipeline does, for
  candidate SHAs). Running `enable` before this PR merges would immediately
  self-block this PR's own merge (and every other in-flight ordinary PR)
  behind a check that can never be satisfied. Correct sequence: (1) merge
  this PR under the still-live classic `ci`-only gate, (2) as a deliberate
  follow-up operational step run
  `node .github/scripts/merge-train/protection.mjs enable --app-id 4106541`,
  (3) confirm via `status` that classic is disabled and the ruleset is
  active with no `problems`, (4) resume real candidate promotion.
- The origin/kickoff session's live PRs (#1087/#1092/#1099/#1140/#1141) and
  flipping `MERGE_TRAIN_ENABLED=true` for a full live cutover were **not**
  performed in this session — that is a separate, higher-risk action
  (merging 5 real PRs unattended) than applying the protection-ruleset fix,
  which is what this PR's bounded success gate covers (tooling +
  protection config + rollback safety, verified live via `status`, with
  `enable` deliberately deferred to post-merge per the sequencing note
  above). Recommend the Shepherd or a follow-up session runs `enable`, then
  flips the flag and drives one real promotion, using
  `train:protection:status` to confirm ordinary-actor enforcement still
  blocks non-bypass pushes.
- `MERGE_QUEUE_ENABLED`/`MERGE_TRAIN_MODE` repo variables were noted as
  possibly-stale/experimental but not touched — worth a follow-up sanity
  check so no inconsistent variable state is left behind.
- **GitHub's built-in Copilot PR reviewer** (`copilot-pull-request-reviewer`)
  left 8 findings on PR #1148 after it opened (in addition to the earlier
  claude-sonnet-4.6 code-review round): a missing-classic-protection (404)
  fail-closed gap in both `enable`/`rollback` (DEC-016), classic-shape
  validation happening after the ruleset was already created/activated
  instead of before (DEC-017), a circular App-id inference in
  `printStatus()`'s problem-detection (DEC-018), a missing Administration
  permission note in the guide, a stale/reversed `enable`-order description
  and a factually-contradictory "already ran live" claim in this handoff
  (both corrected above), a stale test-count note, and a misleadingly-named
  test. All 8 were fixed in code/docs/tests (2 new tests added; one existing
  test renamed and two strengthened), taking the suite from 33 to 35
  tests — all still green.
- Review harness (adversarial plan review + code review; rescored from 4🍎 to
  3🍎 after implementation, so multi-model review was not required) run and
  ledger recorded before `create_pull_request` per the `pr-review-ledger`
  guard.

## Retrospective

### Lessons Learned

- When `test:guards`/`npm test` reports several unrelated
  `ERR_MODULE_NOT_FOUND` failures across unrelated files, check for a stale
  `node_modules` (`npm install`) before assuming they're real regressions —
  saved significant investigation time once recognized.
- Parsing doc text for ordering invariants (as
  `merge-train-doc-rollback-ordering.test.ts` does) is a cheap, effective
  way to keep prose and code in lockstep for safety-critical ordering, but
  it's brittle to line-wrap changes — loosen regexes with `\s+` rather than
  literal spaces when rewriting surrounding prose.
- Rulesets and classic protection are genuinely different feature surfaces
  with no overlap in bypass semantics — worth checking early (via `gh api`)
  which one actually supports the mechanism needed, rather than assuming
  richer permissions on the classic side would eventually unlock it.

### Mistakes Made

- Initially wrote `protection.mjs`'s orchestration functions calling
  `request()` directly at module scope, mirroring older non-DI scripts in
  the repo instead of the newer `reconcile-lib.mjs` DI pattern. Caught
  before any tests were written by recognizing the orchestration logic
  would otherwise be untestable without a network mock — refactored before
  it became load-bearing.
- One unit test assertion in `protection-lib.test.mjs` checked for the
  literal string `'1 bypass actor(s)'` when the actual error message said
  `'2 bypass actor(s)'` for that fixture — an assertion bug, not a logic
  bug. Caught immediately on first test run.

### Opportunities for Future Improvement

- The `docs/knowledge/adr/` directory has several duplicate ADR numbers in
  use (two 0060s conceptually, two 0061s, 0058, 0055, 0054, 0046, 0044,
  0034, 0033, 0031, 0026, 0025, 0024, 0023, 0018, 0017, 0009). Not fixed
  here (out of scope), but a future docs-tooling session could add a lint
  to `scripts/agent/docs/` that fails on duplicate ADR numbers.
- Consider a small `gh api` smoke script that periodically diffs live
  classic-protection + ruleset state against the `protection.mjs status`
  expected shape, so drift (e.g., someone manually re-enabling classic
  `required_status_checks` while the ruleset is live) is caught before the
  next promotion attempt rather than at promotion time.
