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
  **Extended by DEC-019**: when the live ruleset has no bypass actor (drift /
  partial `enable()`), `rollback()`'s disable path also falls back to the
  supplied `--app-id`, so `--app-id` is now the recovery mechanism for the
  bypass-actor-absent case.
- **DEC-016** (added after code review, round 1): `enable()` and `rollback()`
  both fail closed if `getClassicProtection()` returns `null`/`undefined`
  (the branch-protection resource itself 404s), instead of treating a missing
  resource the same as "required_status_checks already disabled." A 404 means
  conversation-resolution, force-push/deletion restrictions, and admin
  enforcement are _also_ entirely absent — a materially different state than
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
  safe) for the unrelated, purely-informational `ruleset.bypassActorId` field
  and for `rollback()`'s own independent bypass-actor discovery (used only to
  _preserve_ the existing actor on a disable payload, never to _validate_ it).
- **DEC-019** (added after post-merge Copilot review, issue #1151): `rollback()`'s
  ruleset-disable path now also accepts the caller-supplied `--app-id`
  (`appId`) as a `fallbackAppId` for `buildRulesetDisablePayload()`. The
  prior implementation derived the App id solely from the live ruleset's
  bypass actor via a private `requireTrainBypassId()` function; if the
  ruleset was partially-applied or operator-drifted and had no bypass actor,
  `requireTrainBypassId()` would throw _after_ classic protection had already
  been restored, leaving `main` permanently blocked by the still-active
  ruleset requiring `merge-train` (which nothing posts while
  `MERGE_TRAIN_ENABLED=false`) with no automated recovery path. The fix
  replaces the private helper with `inferTrainAppId(ruleset) ?? fallbackAppId`
  in `buildRulesetDisablePayload()`: the live bypass actor is used when
  present (nominal path), and the caller-supplied `--app-id` is the recovery
  path. Throws with an informative error if both are absent.
- **DEC-020** (added after post-merge Copilot review, issue #1151):
  `printStatus()` now reports `classic.missing: true` and sets
  `requiredStatusChecksDisabled: false` (not `true`) when the
  classic-protection resource itself is absent (404 → `null`). The prior
  implementation delegated directly to `classicStatusChecksDisabled(null)`,
  which returns `true` because `null?.required_status_checks` is `undefined`
  and `!undefined` is `true` — conflating "resource exists with status checks
  disabled" with "resource does not exist at all." A missing resource also
  means conversation-resolution, force-push/deletion restrictions, and admin
  enforcement are entirely absent; reporting it as a clean "status checks
  disabled" state would mask a materially broken repository configuration and
  could let the `enable()` postcondition treat a fully-deleted classic
  protection as a successful post-migration state.
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
