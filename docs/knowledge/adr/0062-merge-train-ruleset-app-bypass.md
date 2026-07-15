# ADR 0062: Merge-Train Ruleset App Bypass (Fixing GH006 Under Classic Protection)

## Status

Accepted

## Date

2026-07-15

## Estimated Complexity

🍎 x 3 (rescored down from an initial 🍎 x 4 estimate) — production branch-protection change with fail-closed idempotent tooling, exact API payload contracts, and rollback safety, but ultimately a single, well-isolated CLI tool with no live cutover in this PR (see DEC-015: `enable` is deliberately deferred to a documented post-merge operational step).

## Context

- **CTX-001**: ADR 0060 (DEC-009) required the `merge-train` check in branch
  protection and assumed the repository App (Crawler CI, id 4106541) could be
  "the only actor that writes this required context" and could bypass
  protection "for the exact fast-forward update" per the rollout guide's
  "Required repository configuration" section.
- **CTX-002**: That assumption is wrong for **classic** branch protection.
  Classic `required_status_checks` has no per-actor bypass mechanism at all —
  it is satisfied only by an actual passing check run for every actor,
  including Apps. There is no API field on classic protection that lets a
  specific GitHub App skip a required context.
- **CTX-003**: The first live rollout attempt (PR #1143, candidate SHA
  `cd609b770dc73ecd836c3db6baadeb0953e53a81`, PR order 1087/1092/1099/1140/1141)
  passed fast-path `verify:fast` + security validation, but atomic promotion
  failed closed with `GH006`: classic protection required `ci` (GitHub Actions
  App, id 15368) on the combined candidate SHA, and that SHA never ran the
  literal `ci` workflow (candidates are validated by `merge-train-validate.yml`
  running `verify:fast` + the security suite, not `ci.yml`). No refs moved;
  the fast-forward push was rejected atomically before touching any ref.
- **CTX-004**: GitHub's native merge queue remains unavailable to this
  repository (ADR 0060 ALT-001/002) and must not be used or suggested.
- **CTX-005**: The intended invariant is unchanged from ADR 0060: only the
  trusted Crawler CI App may bypass required-check enforcement, and only for
  the exact, internally reattested atomic promotion of a validated combined
  candidate. What changed is the _mechanism_ that can express that invariant.
- **CTX-006**: GitHub repository **rulesets** (a newer, separate feature from
  classic branch protection) support `bypass_actors[]` with
  `actor_type: 'Integration'`, letting a specific App bypass an otherwise
  required-status-checks rule (`bypass_mode: 'always'`). Classic protection
  and rulesets can coexist on the same ref, and each independently blocks a
  push that fails its own requirements — so leaving classic
  `required_status_checks` live would let it re-block the App even after a
  correctly configured ruleset grants the bypass.
- **CTX-007** (issue #1151, live incident 2026-07-15): the first attempt to
  actually flip `MERGE_TRAIN_ENABLED` on after PR #1148 merged surfaced three
  additional gaps, none of which were exercised by the 15/15-green test suite
  that shipped with #1148:
  1. `rollback()`'s disable path threw instead of recovering when the live
     ruleset's `bypass_actors` was missing/drifted (a partial-enable or
     manually-tampered state) — see DEC-019.
  2. Nothing distinguished classic branch protection returning `null` because
     the resource genuinely does not exist (a 404) from `null` meaning "this
     tool already migrated `required_status_checks` off it" — see DEC-020.
  3. **The actual production incident**: `enable --app-id 4106541` created
     ruleset id `19000576` correctly (independently verified via
     `GET /repos/nalfeo/Crawler/rulesets/19000576`: target
     `refs/heads/main`, both `ci`/`merge-train` required checks, `strict:
true`, exactly one Integration bypass actor) at `09:08:47-07:00`, then
     disabled classic `ci` — but `enable()`'s own trailing call to the shared
     `printStatus()` validated the **un-hydrated list-summary object**
     (`GET /repos/{owner}/{repo}/rulesets`, which returns only
     `id`/`name`/`target`/`enforcement` — no `conditions`, `rules`, or
     `bypass_actors`) instead of re-fetching detail via
     `GET /repos/{owner}/{repo}/rulesets/{id}`. `rulesetProblems()` therefore
     saw an object with no ref scope, no required-checks rule, and no bypass
     actor, reported the ruleset as completely broken, and `enable()`'s final
     postcondition threw — triggering an automatic (correct-behavior-given-
     the-false-input, but factually unnecessary) `rollback` that disabled the
     genuinely-correct ruleset at `09:09:14-07:00`, ~27 seconds later. See
     DEC-021.

## Decision

- **DEC-001**: Move _live_ required-status enforcement for `refs/heads/main`
  from classic branch protection to a new repository ruleset named
  **"Merge Train Required Checks"**, targeting `refs/heads/main` only.
- **DEC-002**: The ruleset's `required_status_checks` rule requires both `ci`
  (`integration_id` = 15368, the built-in GitHub Actions App) and
  `merge-train` (`integration_id` = the trusted Crawler CI App id) with
  `strict_required_status_checks_policy: true`, for every actor.
- **DEC-003**: The ruleset has exactly one bypass actor:
  `{actor_type: 'Integration', actor_id: <Crawler CI App id>, bypass_mode: 'always'}`.
  No other bypass actor (user, team, role) is permitted — `rulesetProblems()`
  fails closed if more than one bypass actor is present or the trusted App's
  entry has any other `bypass_mode`.
- **DEC-004**: While the ruleset is live, classic protection's
  `required_status_checks` is set to `null` (disabled, not deleted-repository-wide
  — the protection resource itself remains and still enforces every other
  classic setting). This is required, not optional: leaving it populated would
  let classic protection independently reject the App's promotion push with
  the same `GH006` this fix exists to resolve.
- **DEC-005**: Every other classic protection setting —
  `required_conversation_resolution`, `allow_force_pushes`, `allow_deletions`,
  `required_linear_history`, `enforce_admins`, `block_creations`,
  `lock_branch`, `allow_fork_syncing` — is preserved exactly as configured.
  These settings already work correctly for the train's promotion path (a
  genuine fast-forward using `--force-with-lease` only for atomicity, not
  history rewriting) and are out of scope for this fix.
- **DEC-006**: `assertSupportedClassicProtection()` fails closed (throws,
  rather than guessing a translation) if the live repository has
  `required_pull_request_reviews` or `restrictions` configured on classic
  protection, since this tool does not model a safe way to preserve those
  through a full-replace PUT.
- **DEC-007**: Provide idempotent, side-effect-checked CLI tooling
  (`.github/scripts/merge-train/protection.mjs status|enable|rollback`) rather
  than one-off hand commands. `enable` and `rollback` are safe to re-run
  (detect and skip already-applied state) and both verify their postcondition
  via the same live API reads `status` uses, throwing if the postcondition is
  not met.
- **DEC-008**: `rollback` refuses to run (without `--force`) while
  `MERGE_TRAIN_ENABLED=true`, and always restores classic
  `required_status_checks` to the exact legacy shape (`ci`, strict, scoped to
  App id 15368) **before** disabling the ruleset — never the reverse — so
  there is never a window where neither classic protection nor the ruleset
  enforces `ci` on `main`. Disabling (not deleting) the ruleset preserves an
  audit trail and allows re-enabling without recreating it.
- **DEC-009**: Orchestration logic (`enable`/`rollback`/`printStatus`) takes an
  injected `api` object (GitHub-call functions) rather than calling `fetch`
  directly, so ordering, idempotence, and fail-closed behavior are unit-tested
  against an in-memory fake without touching the network or GitHub API rate
  limits.
- **DEC-010** (added after adversarial plan review): `enable()` creates/updates
  the ruleset and verifies its postcondition via a direct `getRuleset(id)` read
  **before** touching classic protection at all — the reverse of the original
  implementation's order. The original order (disable classic first, then
  create the ruleset) mirrored `rollback()`'s order backwards: if ruleset
  creation failed partway, `main` would have had **neither** mechanism
  enforcing `ci`. The fix applies the same fail-closed invariant `rollback()`
  already had, in the opposite direction: whichever mechanism is being
  _removed_ is only removed after the mechanism _replacing_ it is confirmed
  live.
- **DEC-011** (added after adversarial plan review): `printStatus()` always
  computes `ruleset.problems` via `rulesetProblems()` — including when the
  ruleset does not exist (`rulesetProblems(null, ...)` already returns
  `['ruleset does not exist']`) — instead of a ternary that omitted the
  `problems` key entirely for a missing ruleset. The original ternary let
  `enable()`'s `report.ruleset.problems || []` silently default to an empty
  array, so `enable` could report success even if the ruleset was never
  actually created. `enable()`'s final postcondition now also explicitly
  checks `report.ruleset.exists`.
- **DEC-012** (added after adversarial plan review): `rulesetProblems()`'s
  ref-scope check now requires an **exact** match
  (`include = [refs/heads/main]`, `exclude = []`) instead of merely "include
  contains main somewhere." A ruleset broadened to cover additional refs (or
  with a non-empty `exclude`) would silently extend the trusted App's bypass
  beyond `main` and is now reported as a problem.
- **DEC-013** (added after adversarial plan review):
  `assertKnownClassicStatusChecksShape()` fails closed if classic
  `required_status_checks` is populated with anything other than the single
  known legacy shape before `enable()` disables it. Without this guard, a
  drifted classic configuration (e.g. an operator manually added a second
  required context after this fix's design was reviewed) would be silently
  discarded by `enable`, and `rollback()` would then restore the wrong
  (stale) shape rather than what was actually live.
- **DEC-014** (added after adversarial plan review): `--app-id` is optional
  for `status` and `rollback` (rollback's own write path derives the id it
  needs directly from the live ruleset's bypass actor, independent of
  `--app-id`) but remains **mandatory** for `enable`, since there may be no
  existing ruleset to infer an id from on a first run. This matches
  `docs/guides/merge-train.md`'s existing examples, which never passed
  `--app-id` to `status`/`rollback`.
  **Superseded in part by DEC-018**: `printStatus()`'s `ruleset.problems`
  validation no longer falls back to an id inferred from the live ruleset
  itself (see DEC-018) — only the id used to locate/preserve the bypass actor
  during a write remains inference-eligible.
  **Superseded in part by DEC-019**: rollback's write path no longer derives
  the bypass actor id via a throwing `requireTrainBypassId()` helper (that
  helper has been removed); see DEC-019 for the shape-preserving replacement,
  which never throws and treats `--app-id` as an optional repair fallback
  rather than a required source of truth.
- **DEC-016** (added after code review, round 1): `enable()` and `rollback()`
  both fail closed if `getClassicProtection()` returns `null`/`undefined`
  (the branch-protection resource itself 404s), instead of treating a missing
  resource the same as "required*status_checks already disabled." A 404 means
  conversation-resolution, force-push/deletion restrictions, and admin
  enforcement are \_also* entirely absent — a materially different state than
  "classic protection exists but its status-check requirement was already
  migrated" — and this tool cannot safely infer which case it's looking at.
  Silently proceeding in the missing case risked completing a migration while
  quietly never restoring/preserving protections that were assumed present.
- **DEC-017** (added after code review, round 1): `enable()` validates the
  live classic protection shape (missing-resource check + drift check via
  `assertKnownClassicStatusChecksShape()`) as a **read-only pre-flight step
  before the ruleset is created or updated at all**, not just before the
  classic-protection PUT later in the function. The write ordering from
  DEC-010 (ruleset first, then classic) is preserved for the writes
  themselves; this only moves the _validation read_ earlier. Without this,
  an abort triggered by a drifted/missing classic shape could happen **after**
  the ruleset had already been created and activated — leaving `main` behind
  an active ruleset requiring the `merge-train` context while
  `MERGE_TRAIN_ENABLED` is still `false` and nothing posts that check,
  permanently blocking every ordinary merge until a human manually disables
  the half-applied ruleset.
- **DEC-018** (added after code review, round 1): `printStatus()`'s
  `ruleset.problems` is computed against the trusted App id **only when
  explicitly supplied** (`--app-id` / `MERGE_TRAIN_APP_ID`); when it is not
  supplied and a ruleset exists, `problems` reports a single explicit
  "trusted App id not supplied" entry rather than falling back to
  `inferTrainAppId(ruleset)` as the "expected" id. The prior inference-based
  check was circular: it derived "what the bypass actor should be" from the
  very same live ruleset it was validating, so a ruleset drifted to bypass
  _any_ single Integration actor — including a wrong or compromised one —
  would trivially report zero problems. Inference is still used (and remains
  safe) for the unrelated, purely-informational `ruleset.bypassActorId` field.
  **Superseded in part by DEC-019**: rollback's own bypass-actor handling on
  disable no longer uses a separate inference-then-throw helper; see DEC-019.
- **DEC-015** (deployment sequencing, added after adversarial plan review):
  `enable` must be run as a deliberate operational step **strictly after**
  this fix's own PR merges, never before or as part of the same PR's merge.
  Reasoning: once the ruleset is live, every non-bypass actor — including an
  ordinary `gh pr merge` on this fix's own PR — must satisfy both `ci` and
  `merge-train` before merging to `main`. Nothing posts a `merge-train` check
  for an ordinary PR (only the merge-train pipeline posts it, for validated
  candidate SHAs). Running `enable` before this PR merges would immediately
  self-block this PR's own merge — and every other in-flight ordinary PR —
  behind a check that can never be satisfied for a non-candidate change. This
  PR therefore ships tooling + tests + docs only; the live cutover is a
  documented follow-up.
- **DEC-019** (issue #1151 gap 1, rollback recovery): `buildRulesetDisablePayload()`
  is rewritten to be **shape-preserving and non-throwing** instead of
  constructing an idealized payload and throwing
  (`requireTrainBypassId()`, now removed) when the live ruleset had no
  Integration bypass actor to preserve. Since disabling
  (`enforcement: 'disabled'`) makes `rules`/`bypass_actors` functionally
  inert on the ruleset, there is no correctness reason to require a "clean"
  bypass actor before disabling — the function now copies `name`/`target`/
  `conditions`/`rules`/`bypass_actors` verbatim from whatever the live
  ruleset actually is and only overrides `enforcement`. An optional,
  independently-supplied `trainAppId` (from `--app-id`/`MERGE_TRAIN_APP_ID`)
  is used **only** as a repair fallback to populate `bypass_actors` when the
  live ruleset has none at all — so a subsequent `enable()` isn't starting
  from a bypass-less ruleset — and the live ruleset's own shape always wins
  over a supplied `trainAppId` when both exist, since the live shape is
  ground truth and the supplied id is untrusted for this purpose (rollback's
  job is "make main safe again," not "re-validate/repair the ruleset").
  Without this fix, `rollback()` could restore classic `ci` successfully and
  then throw partway through disabling a partially-enabled or
  manually-drifted ruleset, leaving `main` behind an **active** ruleset that
  requires the `merge-train` context with no automated way to finish
  disabling it.
- **DEC-020** (issue #1151 gap 2, classic-404 flagging): a new
  `classic.missing` boolean field is added to `printStatus()`'s report,
  computed via the existing pure `classicProtectionMissing()` helper (already
  used by `assertClassicProtectionExists()` at read time in `enable()`/
  `rollback()`, but previously not surfaced in the status report or checked
  in either function's **final** postcondition). `classicStatusChecksDisabled()`
  itself is left unchanged — its doc comment already documents that it is
  deliberately blind to the 404-vs-disabled distinction, and existing tests
  assert `classicStatusChecksDisabled(null) === true`. Instead,
  `enable()`'s and `rollback()`'s final postcondition checks now also fail
  if `report.classic.missing` is true, and the read-only `status` command
  surfaces it directly. This closes a gap where classic branch protection
  disappearing entirely between a mutation and its postcondition read (e.g.
  deleted out-of-band by another operator/tool) would have been silently
  treated as "the migration already happened," rather than flagged as a
  materially different and more dangerous state (conversation-resolution,
  force-push/deletion restrictions, and admin enforcement are also entirely
  gone, not just the status-check requirement).
- **DEC-021** (issue #1151 gap 3, ruleset hydration — the live-reproduced
  2026-07-15 incident, see CTX-007): `printStatus()` now fetches the full
  ruleset **detail** via `await api.getRuleset(rulesetSummary.id)`
  immediately after locating a ruleset by name in the **list** results
  (`findRulesetByName(await api.getRulesets(), RULESET_NAME)`), and validates
  that hydrated object — never the raw list-summary object — via
  `rulesetProblems()`. This is the direct fix for the incident in CTX-007:
  GitHub's list endpoint (`GET /repos/{owner}/{repo}/rulesets`) returns only
  `id`/`name`/`target`/`enforcement`; only the detail endpoint
  (`GET /repos/{owner}/{repo}/rulesets/{id}`) includes `conditions`, `rules`,
  and `bypass_actors`. `enable()`'s own internal postcondition check was
  never affected by this bug — it already called `getRuleset(id)` directly
  right after create/update — but its final, shared call to `printStatus()`
  was, which is why the incident manifested as "`enable` appeared to succeed
  internally, then immediately reported failure and rolled itself back." The
  test suite's in-memory fake `api` is updated so `getRulesets()` returns
  stripped summary objects (matching the real list endpoint) while
  `getRuleset(id)` returns full detail from the same in-memory store — the
  previous fake returned identical full objects from both, which is exactly
  why 15/15 green tests from PR #1148 did not catch this gap. New tests
  cover: (a) a genuinely correct live ruleset, visible only as a stripped
  summary in `getRulesets()`, must report zero problems once hydrated; (b)
  `enable()` against a fresh repository (no pre-existing ruleset) must not
  false-fail its own trailing postcondition; and (c) a ruleset that matches
  by name in the list summary but whose hydrated detail reveals a genuine
  drift (e.g. an emptied `bypass_actors`) must still report that problem —
  proving hydration is actually used for validation, not merely fetched and
  discarded.
- **DEC-022** (issue #1151, adversarial plan review response): before
  implementation, a separate-model adversarial plan review (per the
  apple-scaled review-harness policy, 4🍎 tier) red-teamed DEC-019/020/021
  and raised six concerns. Each is addressed here, resolved or explicitly
  and reasonedly deferred rather than silently dropped:
  1. **[Blocking, fixed]** `findRulesetByName()` previously picked the FIRST
     ruleset matching the expected name via `.find()`, silently ignoring any
     duplicates. If a second same-named ruleset ever existed live (manual
     tampering, a race, a bug), `status`/`enable`/`rollback` could all
     inspect/mutate the wrong one while the other kept enforcing (or failing
     to enforce) invisibly — directly threatening the "use the current
     ruleset idempotently, never create a duplicate" invariant. Fixed:
     `findRulesetByName()` now throws `AmbiguousRulesetNameError` when more
     than one ruleset shares the name, propagating through all three
     commands rather than guessing. Covered by a unit test
     (`protection-lib.test.mjs`) and three orchestration tests proving
     `status`/`enable`/`rollback` all fail closed and never mutate anything
     once duplicates are detected (`protection.test.mjs`).
  2. **[Non-blocking, deferred with rationale]** Extracting a dedicated
     machine-postcondition verifier separate from the human-readable
     `printStatus()` report (so a future `status`-only change can't
     re-introduce a shared-path bug like CTX-007) is a real architectural
     improvement, but is a larger refactor than this incident-response fix
     warrants right now — `printStatus()` has exactly one read path
     (hydrate-then-validate) after DEC-021, and there is currently only one
     call site of the hydrate-then-validate pattern, so there is no
     duplication yet to centralize. Deferred to when a second call site
     appears or as dedicated follow-up work; not blocking for this PR.
  3. **[Non-blocking, resolved — already fail-closed]** A hydration race
     (list finds a ruleset by name, then `getRuleset(id)` 404s or errors
     before the read completes) was flagged as unhandled. Verified: unlike
     `getClassicProtection()`/`getMergeTrainEnabled()`, which explicitly
     catch a 404 and normalize it to `null`/`false`, `getRuleset(id)` in
     `buildGithubApi()` has no such catch — any error (including a 404)
     propagates as an uncaught rejection, aborting `status`/`enable`/
     `rollback` outright rather than silently misreporting. This is already
     the correct fail-closed behavior; no code change needed, only this
     note.
  4. **[Non-blocking, fixed]** `buildRulesetDisablePayload()` preserves an
     existing (possibly wrong/drifted) live bypass actor verbatim rather
     than normalizing it against a supplied `--app-id`, which is inert once
     `enforcement: 'disabled'` but leaves "tainted" state an operator might
     not notice. Rather than have the disable path silently make a policy
     decision about which actor is "correct" during an incident response,
     `rollback()` now logs an explicit `WARNING` when the live bypass actor
     id does not match the supplied trusted `--app-id`, while still
     preserving the live shape verbatim. Covered by a new orchestration
     test. **Refined further during multi-model review** (see below): the
     initial implementation gated the warning on `inferTrainAppId(full)`
     being truthy, which only detects `actor_type: 'Integration'` bypass
     actors — a ruleset tampered to bypass via a non-Integration actor
     (`'RepositoryRole'`, `'Team'`) would make `liveBypassId` null, silently
     escaping the warning even though `buildRulesetDisablePayload` still
     preserves that actor verbatim. Fixed by gating on `hasLiveActors` (any
     `bypass_actors` entry present) instead of `liveBypassId` truthiness,
     with a new test covering the non-Integration-actor case.
  5. **[Suggestion, deferred with rationale]** A tri-state
     `classic.missing`/`disabled`/`present-and-enabled` was suggested over
     the current `{ missing: bool, requiredStatusChecksDisabled: bool }`
     pair. Kept as two fields: `classicStatusChecksDisabled()` is an
     existing, independently tested pure function whose contract
     (`classic-protection-exists → checks-disabled?`) predates this fix;
     changing its return shape to a tri-state would ripple into every
     existing caller/test for a readability improvement only, with no
     behavior change (both fields are already read together everywhere
     that matters). Not worth the churn for this fix.
  6. **[Suggestion, fixed]** Add duplicate-same-name-ruleset test coverage —
     done as part of resolving concern #1 above.

  `plan_divergence: minor` — the review did not change the load-bearing
  design of gaps 1/2/3 (shape-preserving disable, explicit `classic.missing`,
  hydrate-before-validate), but did surface and lead to fixing one genuine
  blocking gap (duplicate-ruleset ambiguity) plus a smaller drift-visibility
  improvement, both additive rather than a re-architecture.

- **DEC-023** (issue #1151, multi-model code review): after implementation,
  two independent models (gpt-5.4, gemini-3.1-pro-preview) reviewed the full
  diff in parallel, focused on correctness/security. gpt-5.4 found no issues.
  gemini-3.1-pro-preview found one legitimate, non-blocking gap: the
  drift-warning gate added in DEC-022 point 4 checked
  `inferTrainAppId(full)` truthiness, which only recognizes
  `actor_type: 'Integration'` bypass actors — a ruleset tampered to bypass
  via a non-Integration actor type would produce a null `liveBypassId`,
  silently indistinguishable from "no bypass actors at all" and therefore
  never warned about, even though `buildRulesetDisablePayload` still
  preserves that actor verbatim. Adjudicated as valid and fixed: the gate
  now checks `hasLiveActors` (any `bypass_actors` entry present) instead of
  `liveBypassId` truthiness, with a new test (`'rollback logs the drift
warning even when the live bypass actor is not an Integration type at
all'`) covering the non-Integration-actor case specifically.

- **DEC-024** (4th gap, discovered live during the actual `enable` cutover on
  2026-07-15, in `.github/scripts/merge-train/reconcile-lib.mjs` rather than
  `protection.mjs`): after DEC-019 through DEC-023 shipped (PR #1153) and the
  live cutover proceeded — `enable` succeeded cleanly with no false rollback,
  `MERGE_TRAIN_ENABLED` was set `true`, and a real 6-PR batch
  (#1087, #1092, #1099, #1140, #1141, #1147) was atomically promoted via
  `promoteExactBatch`'s single `git push --atomic ... --force-with-lease` — the
  dispatched reconcile run threw: `PR #1087 was not recorded as merged after
atomic promotion to <sha>`. Investigation confirmed the atomic push had
  **fully succeeded** (`git log origin/main` showed all 6 PRs' commits
  correctly present, each tagged with its PR number) and the ruleset/classic
  protection layer from DEC-019–023 remained completely healthy
  (`protection.mjs status` → `problems: []` throughout). The bug was isolated
  to `promoteExactBatch`'s **postcondition-and-cleanup tail**: GitHub's own
  asynchronous "merged" detection (a secondary confirmation of a fact the
  atomic push already proved) lagged past the ~31s retry budget for PR #1087
  specifically, and the old code aborted the entire post-push loop on that
  first failure — before the separate cleanup loop below it ever ran for
  **any** entry, including the 5 siblings that had already confirmed cleanly.
  Because `reconcile.mjs` builds its queue via `pulls?state=open`, and these
  PRs closed within seconds (webhook-driven, independent of the slower
  `merged_at` field), all 6 PRs were left permanently stuck with a stale
  `merge-train` label that no future reconcile cycle would ever clean up —
  requiring manual `gh pr edit --remove-label` cleanup for all 6 this session.
  Per this task's explicit instruction ("if any invariant/config issue
  appears, safe rollback first, then fix via separate PR"), the train was
  immediately paused (`MERGE_TRAIN_ENABLED=false`) as a safety measure while
  the fix below was implemented, tested, and reviewed in this same PR/ADR
  update, before re-enabling and re-observing a live cycle.

  **Fix** (preserves the trust invariant; does not weaken it — a genuinely
  unconfirmed entry still blocks its own cleanup and the function still
  throws): restructured the entire post-push phase in `promoteExactBatch` to
  collect-and-continue instead of abort-on-first-failure, in three respects
  that a separate-model plan review (gpt-5.4) confirmed were all necessary
  (see below): (1) confirmation reads for every entry now run in parallel via
  `Promise.all` with a per-entry `try/catch` — an API error confirming one
  entry is treated as "unconfirmed" (with the error recorded) rather than
  aborting the batch, and parallelizing also caps the worst-case wall-clock
  wait near the single-entry budget instead of multiplying it by batch size;
  (2) publishing the `-promotion-postcondition` failure check is wrapped in
  its own `try/catch` so a failure to publish it cannot itself block cleanup;
  (3) the cleanup loop (remove `merge-train`/`merge-train-blocked` labels,
  update status) wraps each entry in its own `try/catch`, so one entry's
  cleanup failure does not prevent cleanup for its siblings. All collected
  failures (unconfirmed entries, cleanup failures, postcondition-check-publish
  failures) are aggregated into a single thrown error only after cleanup has
  been attempted for every eligible entry — an existing, deliberate
  pre-existing test (`reconcile.test.mjs`, "promoteExactCandidate publishes a
  separate failure when GitHub does not record the PR as merged") proves the
  single-entry hard-fail contract is unchanged. `reconcile.mjs`'s
  `waitForMergedPr` retry budget was also increased from ~31s to ~77s total
  (`MERGED_PR_POLL_DELAYS_MS`) to reduce recurrence frequency under load,
  while staying well inside the reconcile job's 15-minute timeout even for a
  full batch where every entry independently exhausts the budget.

  **API-representation distinction, generalized from DEC-021's ruleset
  lesson**: DEC-021 fixed `protection.mjs` treating a summary API response
  (list-rulesets) as if it were the authoritative detail response. DEC-024 is
  the same class of lesson one layer up the stack, in `reconcile.mjs`/
  `reconcile-lib.mjs`: GitHub's `merged`/`merged_at` PR fields are themselves
  a **derived, asynchronously-computed mirror** of an underlying fact (here,
  "is this ref an ancestor of main's tip"), not the ground truth — the actual
  atomic `git push` result is. Both gaps share the same root shape: code
  treated an eventually-consistent, secondary GitHub API signal as if it were
  synchronous and authoritative, and let a lag in that signal override or
  block correctly-established ground truth. Filed as a new issue rather than
  reopening #1151, since it is a distinct discovery in `reconcile-lib.mjs`
  outside #1151's declared `protection.mjs` scope (rollback/status/hydration).
  New tests cover: a sibling confirms while another does not (cleanup runs for
  the confirmed entry only); all entries unconfirmed (no cleanup runs at all);
  a `waitForMergedPr` rejection is treated like an unconfirmed entry, not a
  hard abort; a per-entry cleanup step throwing does not block a sibling's
  cleanup; and a postcondition-check publish failure is surfaced in the
  aggregated error without blocking cleanup.

## Consequences

### Positive

- **POS-001**: The trusted App can promote a validated combined candidate to
  `main` without `GH006`, restoring the ADR 0060 design intent.
- **POS-002**: Ordinary actors (any push, PR merge, or other App) remain
  blocked unless both `ci` and `merge-train` pass — the ruleset's
  `bypass_actors` list contains only the one trusted Integration.
- **POS-003**: Rollback is fail-closed and idempotent: at every step, at least
  one of {classic `ci`, the ruleset} enforces `ci` on `main`.
- **POS-004**: All classic settings unrelated to the App-bypass problem are
  untouched, minimizing blast radius.

### Negative

- **NEG-001**: Two protection mechanisms (classic + ruleset) now coexist on
  the same ref conceptually, even though only one (`required_status_checks`)
  is live in either at a time. Operators must understand both to reason about
  `main`'s protection state; `protection.mjs status` exists specifically to
  make this legible in one command.
- **NEG-002**: If `enable`/`rollback` is run with a stale or wrong App id, the
  ruleset either grants the wrong bypass or fails its own postcondition check
  (fails closed rather than silently misconfiguring).

### Risks

- **RSK-001**: A ruleset created by a token without sufficient permissions
  (rulesets require `administration: write`, distinct from `contents`/
  `checks` write) will fail the API call; this surfaces as an explicit HTTP
  error rather than a silent no-op.
- **RSK-002**: This directly resolves ADR 0060's own RSK-003 ("Incorrect App
  bypass configuration causes promotion to fail closed after validation") for
  the specific classic-protection case that manifested in the PR #1143
  rollout.
- **RSK-003** (raised and investigated during adversarial plan review):
  `getRulesets()` reads with `includes_parents=false`, so it is blind to any
  organization/enterprise-level ruleset that might independently constrain
  `main`. **Verified inapplicable to this repository today**: `nalfeo/Crawler`
  is owned by a personal GitHub _User_ account
  (`gh api repos/nalfeo/Crawler --jq .owner.type` → `"User"`), and GitHub does
  not support org/enterprise rulesets for repos under a personal account —
  there is no parent scope to inherit from. Deliberately **not** switching to
  `includes_parents=true` now: doing so would add an untested code path (and
  risk of `updateRuleset` mistakenly targeting an inherited/parent ruleset id
  via the repo-scoped endpoint) to guard against a scenario that cannot occur
  for this repo's current account type. Revisit if the repository is ever
  transferred into an organization (see code comment on `getRulesets()` in
  `protection.mjs`).

## Alternatives Considered

### Grant the App a classic branch-protection bypass directly

- **ALT-001**: **Description**: Look for a classic-protection field or App
  permission that lets a specific App satisfy/skip a required context.
- **ALT-002**: **Rejection Reason**: No such mechanism exists. Classic
  `required_status_checks` bypass is not actor-scoped; only rulesets support
  `bypass_actors`. Confirmed via the GitHub REST API docs for
  `/repos/{owner}/{repo}/branches/{branch}/protection` (no bypass field) vs.
  `/repos/{owner}/{repo}/rulesets` (`bypass_actors[]` with `actor_type:
'Integration'`).

### Make the candidate SHA actually run the literal `ci` workflow

- **ALT-003**: **Description**: Trigger `ci.yml` itself (not just
  `verify:fast` + security) on the combined candidate SHA before promotion, so
  classic protection's `ci` context is satisfied honestly without any bypass.
- **ALT-004**: **Rejection Reason**: Duplicates the exact-SHA validation ADR
  0060 already performs (fast gate = `verify:fast` + targeted security suite,
  by design, for speed) and does not remove the underlying problem: `main`
  itself would still need `ci` to run on the literal candidate ref/SHA before
  fast-forwarding, which requires either running `ci.yml` against an
  unmerged, ephemeral ref (novel trust-boundary and workflow-dispatch
  complexity) or still bypassing classic protection for the final push. It
  also roughly doubles CI cost per promotion for no invariant benefit — the
  fast gate is already the trusted validation signal.

### Enable GitHub's native merge queue

- **ALT-005**: **Description**: Use GitHub's managed merge queue instead of
  ruleset-based enforcement.
- **ALT-006**: **Rejection Reason**: Unavailable to this repository (ADR 0060
  ALT-001/002); explicitly out of scope per this fix's own brief.

### Move conversation-resolution / force-push settings into the ruleset too

- **ALT-007**: **Description**: While rebuilding protection as a ruleset,
  also migrate `required_conversation_resolution` and force-push/deletion
  restrictions into ruleset-native rule types
  (`pull_request.required_review_thread_resolution`, `non_fast_forward`).
- **ALT-008**: **Rejection Reason**: Those settings already work correctly
  under classic protection and are unrelated to the `GH006` failure. Moving
  them adds surface area, risk, and payload complexity to this fix without
  addressing the actual root cause, and the train's promotion push is a
  genuine fast-forward — `non_fast_forward` restrictions are not implicated.

### Delete the ruleset on rollback instead of disabling it

- **ALT-009**: **Description**: `rollback` deletes the "Merge Train Required
  Checks" ruleset entirely instead of setting `enforcement: 'disabled'`.
- **ALT-010**: **Rejection Reason**: Disabling preserves the exact
  bypass-actor/required-context configuration for audit and near-zero-cost
  re-enable; deleting would force `enable` to reconstruct the payload from
  scratch every time and loses any ruleset-level audit-log history GitHub
  retains for the object.

## Related

- ADR 0060: Repository-Managed Speculative Merge Train (original design;
  DEC-009's classic-protection assumption is the specific gap this ADR fixes)
- `docs/guides/merge-train.md`: "Required repository configuration",
  "Rollout", and "Emergency repair lane" sections updated to describe the
  ruleset + classic-disable mechanism
- `.github/scripts/merge-train/protection-lib.mjs`,
  `.github/scripts/merge-train/protection.mjs`: implementation
- Issue #1151 and `docs/knowledge/handoffs/2026-07-15-merge-train-rollback-status-hydration-fix.md`:
  the three rollback/status/hydration gaps found preparing for and during the
  first live `enable` cutover attempt (DEC-019/020/021, CTX-007)
- Issue #1154 and `.github/scripts/merge-train/reconcile-lib.mjs`,
  `.github/scripts/merge-train/reconcile.mjs`: the 4th gap (DEC-024),
  discovered live during the actual cutover this ADR's fix enabled — a
  distinct bug in `promoteExactBatch`'s promotion-postcondition/cleanup tail,
  outside this ADR's `protection.mjs` scope
