# Session Handoff: Merge-train rollback/status recovery gaps (issue #1151)

## Date

2026-07-15

## Systems touched

ci-policy, merge-train

## What Was Done

Fixed two technical gaps in the merge-train protection tooling identified by
GitHub Copilot's post-merge review of PR #1148, before live `enable` cutover
is run against the real repository:

### Fix #1 — Rollback recovery path when bypass actor is absent (DEC-019)

**Root cause**: `rollback()` derived the App id it needed to build the
ruleset-disable payload exclusively from `requireTrainBypassId(full)` — a
private function that reads the Integration bypass actor from the live ruleset.
If `enable()` had partially applied (or an operator manually broke the ruleset)
and the ruleset had no bypass actor, `requireTrainBypassId` would throw AFTER
classic protection was already restored, leaving `main` permanently blocked by
the still-active ruleset requiring `merge-train` (which nothing posts while
`MERGE_TRAIN_ENABLED=false`) with no automated recovery path.

**Fix**: Replaced the private `requireTrainBypassId()` with
`inferTrainAppId(ruleset) ?? fallbackAppId` in `buildRulesetDisablePayload()`.
The function now accepts an optional `{ fallbackAppId }` parameter. `rollback()`
passes its `appId` argument (from `--app-id` / `MERGE_TRAIN_APP_ID`) as the
fallback. The live bypass actor is used when present (nominal path); the
caller-supplied id is the recovery path. Throws an informative error if both
are absent, telling the operator to retry with `--app-id`.

**Files changed**:
- `.github/scripts/merge-train/protection-lib.mjs`: `buildRulesetDisablePayload`
  accepts `{ fallbackAppId }` and uses `inferTrainAppId ?? fallbackAppId`;
  removed now-unused private `requireTrainBypassId()` function.
- `.github/scripts/merge-train/protection.mjs`: `rollback()` passes
  `{ fallbackAppId: appId }` to `buildRulesetDisablePayload`.

### Fix #2 — `printStatus` flags missing classic-protection resource (DEC-020)

**Root cause**: `printStatus()` delegated directly to
`classicStatusChecksDisabled(protection)`, which returns `true` when
`protection` is `null` (the 404/missing case) because
`null?.required_status_checks` is `undefined` and `!undefined` is `true`.
This conflated "the classic-protection resource exists but its
`required_status_checks` is disabled" (post-`enable` state) with "the
classic-protection resource does not exist at all" (fully-deleted). A missing
resource means conversation-resolution, force-push/deletion restrictions, and
admin enforcement are ALSO absent — a materially different, more broken state
— but the old code would report `requiredStatusChecksDisabled: true` for both,
potentially masking a broken configuration as a clean "migration complete" state.

**Fix**: Added `classicProtectionMissing(protection)` detection in
`printStatus()`. The status report now includes:
- `classic.missing: true` when the resource itself is absent (404 → null).
- `classic.requiredStatusChecksDisabled: !classicMissing && classicStatusChecksDisabled(protection)` — `false` (not `true`) when the resource is missing.

`classicStatusChecksDisabled()` itself is unchanged (still a pure function that
returns `true` for `null`); only the `printStatus` report shape was updated.
This correctly fails the `enable()` postcondition check
(`!report.classic.requiredStatusChecksDisabled`) if classic protection
disappears after mutations.

**Files changed**:
- `.github/scripts/merge-train/protection.mjs`: `printStatus()` adds
  `classic.missing` field and uses `!classicMissing && ...` for
  `requiredStatusChecksDisabled`.

### Tests added

**`protection.test.mjs`** (+4 new tests):
- `rollback can disable a drifted ruleset whose bypass actor is absent, when --app-id is supplied as fallback`
- `rollback throws an informative error when the ruleset has no bypass actor AND no --app-id is supplied`
- `printStatus flags a missing classic-protection resource (404) instead of reporting requiredStatusChecksDisabled: true`
- `printStatus reports classic.missing: false when the resource exists (normal case)`

**`protection-lib.test.mjs`** (+2 new tests):
- `buildRulesetDisablePayload uses fallbackAppId when the live ruleset bypass actor is absent`
- `buildRulesetDisablePayload prefers the live bypass actor over fallbackAppId when both are present`

Total test count: **35 → 41** (all pass).

### ADR 0062 updated

Added DEC-019 (rollback fallback App id) and DEC-020 (printStatus missing-resource
flag). Updated DEC-014 to reference the extension and DEC-018 to remove the stale
reference to the now-deleted `requireTrainBypassId()` private function.

## What Was NOT Done

- Live `enable` cutover against the real repository — still deliberately deferred
  per DEC-015. The `protection.mjs status` command output is expected:
  `mergeTrainEnabled: false`, classic `ci` still active, `ruleset.exists: false`.
  Run `npm run train:protection:status -- --repo nalfeo/Crawler --app-id ******`
  before any live cutover to confirm this state.

## Key Decisions Made

- **`buildRulesetDisablePayload` accepts an optional fallback** — keeps the
  function backward-compatible (no-fallback callers get the old throw behaviour
  when the live bypass actor is also absent) while enabling the recovery path.
- **Live bypass actor takes precedence over fallback** — preserves the existing
  bypass actor faithfully when the ruleset is in a good state; the fallback only
  fires when it isn't.
- **`classicStatusChecksDisabled()` unchanged** — it remains a pure function
  whose `null` → `true` behaviour is correct for its narrow semantics ("is the
  field absent?"). Only `printStatus`'s reporting layer is updated to distinguish
  "field absent because resource is missing" from "field absent because migration
  ran."
- **Added `classic.missing` to report shape** — explicit, additive field so
  callers (human operators reading the JSON output) can distinguish the two cases
  without reimplementing the null-check themselves.
