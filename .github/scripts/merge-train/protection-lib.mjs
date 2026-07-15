// Pure, network-free payload builders and postcondition validators for the
// merge-train branch-protection fix (see docs/knowledge/adr/0062-merge-train-ruleset-app-bypass.md).
//
// Root cause this module fixes: classic branch protection's
// `required_status_checks` has no mechanism to grant a specific GitHub App a
// bypass for an individual required context. Only repository *rulesets*
// support a `bypass_actors` entry with `actor_type: 'Integration'`. So the
// trusted merge-train App (Crawler CI) can never satisfy classic protection's
// `ci` requirement on a combined candidate SHA that never ran the literal
// `ci` workflow (candidates are validated by `verify:fast` + the security
// suite, not by re-running `ci.yml`) -- promotion always fails closed with
// GH006, regardless of how the App is configured.
//
// The fix moves *live* required-status enforcement for `refs/heads/main` to
// a dedicated ruleset that requires `ci` + `merge-train` for everyone except
// one bypass actor: the Crawler CI App (`actor_type: 'Integration'`,
// `bypass_mode: 'always'`). Classic protection's `required_status_checks` is
// disabled (set to `null`) while the ruleset is live so it cannot
// independently re-block the App; every other classic setting (conversation
// resolution, force-push/deletion restrictions, etc.) is preserved exactly
// as configured.

// The built-in "GitHub Actions" App that reports the `ci` context. This is a
// stable, well-known App ID (not specific to this repository) and matches
// the `app_id` already recorded on the live `ci` required check.
export const GITHUB_ACTIONS_APP_ID = 15368;

export const RULESET_NAME = 'Merge Train Required Checks';
export const PROTECTED_REF = 'refs/heads/main';
export const REQUIRED_CONTEXT_CI = 'ci';
export const REQUIRED_CONTEXT_TRAIN = 'merge-train';

/**
 * Classic protection fields this module manages directly. Any other
 * populated classic setting (`required_pull_request_reviews`,
 * `restrictions`) is unsupported by design: guessing at a translation for a
 * setting nobody asked us to preserve risks silently weakening it. Fail
 * closed instead -- see `assertSupportedClassicProtection`.
 */
const UNSUPPORTED_CLASSIC_FIELDS = ['required_pull_request_reviews', 'restrictions'];

export class UnsupportedClassicProtectionError extends Error {
  constructor(field) {
    super(
      `Classic branch protection for main has "${field}" configured. This tool only ` +
        'preserves required_status_checks/enforce_admins/required_linear_history/' +
        'allow_force_pushes/allow_deletions/required_conversation_resolution/' +
        'block_creations/lock_branch/allow_fork_syncing. Extend ' +
        'buildClassicProtectionPayload before running enable/rollback so this setting ' +
        'is not silently dropped.',
    );
    this.name = 'UnsupportedClassicProtectionError';
    this.field = field;
  }
}

/**
 * Fail closed if the live classic protection has a setting this tool does
 * not know how to preserve. Call this before building any PUT payload from a
 * fetched protection object.
 */
export function assertSupportedClassicProtection(current) {
  for (const field of UNSUPPORTED_CLASSIC_FIELDS) {
    if (current?.[field]) {
      throw new UnsupportedClassicProtectionError(field);
    }
  }
}

export class UnknownClassicStatusChecksShapeError extends Error {
  constructor(checks) {
    super(
      `Classic branch protection's required_status_checks is populated with an ` +
        `unexpected shape (${JSON.stringify(checks)}). This tool only knows how to ` +
        `disable-and-later-restore the single legacy shape ({strict:true, checks:[{context:` +
        `'${REQUIRED_CONTEXT_CI}', app_id:${GITHUB_ACTIONS_APP_ID}}]}); disabling a drifted/` +
        `different configuration here would silently discard it, and rollback would restore ` +
        `the wrong thing. Reconcile the live classic protection to the expected legacy shape ` +
        `first, or extend legacyRequiredStatusChecks()/classicStatusChecksRestored() to model ` +
        `the new shape deliberately.`,
    );
    this.name = 'UnknownClassicStatusChecksShapeError';
    this.checks = checks;
  }
}

/**
 * Fail closed if classic protection's `required_status_checks` is populated
 * with something other than the one known legacy shape. `enable()` calls
 * this before disabling `required_status_checks` so a drifted or stronger
 * classic configuration (e.g. an operator manually added a second required
 * context) is never silently discarded -- rollback only knows how to restore
 * the single legacy shape, so anything else must be resolved by a human
 * before this tool touches it.
 */
export function assertKnownClassicStatusChecksShape(current) {
  const checks = current?.required_status_checks;
  if (!checks) return; // already disabled/absent -- nothing to preserve
  if (classicStatusChecksRestored(current)) return; // matches the known legacy shape exactly
  throw new UnknownClassicStatusChecksShapeError(checks);
}

/**
 * The legacy/rollback shape of classic `required_status_checks`: exactly what
 * was live before this fix (and what rollback restores) -- `ci` only,
 * strict, scoped to the GitHub Actions App.
 */
export function legacyRequiredStatusChecks() {
  return {
    strict: true,
    checks: [{ context: REQUIRED_CONTEXT_CI, app_id: GITHUB_ACTIONS_APP_ID }],
  };
}

/**
 * Build a full PUT body for `/repos/{owner}/{repo}/branches/main/protection`
 * from the currently live protection object, replacing only
 * `required_status_checks`. Every other field is copied through unchanged so
 * running this tool can never silently alter conversation-resolution,
 * force-push, or deletion settings.
 *
 * `requiredStatusChecks` must be either `null` (disable -- used while the
 * ruleset is live) or the object returned by `legacyRequiredStatusChecks()`
 * (restore -- used on rollback).
 */
export function buildClassicProtectionPayload(current, { requiredStatusChecks }) {
  assertSupportedClassicProtection(current);
  return {
    required_status_checks: requiredStatusChecks,
    enforce_admins: Boolean(current?.enforce_admins?.enabled),
    required_pull_request_reviews: null,
    restrictions: null,
    required_linear_history: Boolean(current?.required_linear_history?.enabled),
    allow_force_pushes: Boolean(current?.allow_force_pushes?.enabled),
    allow_deletions: Boolean(current?.allow_deletions?.enabled),
    required_conversation_resolution: Boolean(current?.required_conversation_resolution?.enabled),
    block_creations: Boolean(current?.block_creations?.enabled),
    lock_branch: Boolean(current?.lock_branch?.enabled),
    allow_fork_syncing: Boolean(current?.allow_fork_syncing?.enabled),
  };
}

/**
 * True only when the classic branch-protection *resource itself* is missing
 * entirely (the `GET .../branches/main/protection` endpoint 404s -- mapped to
 * `null` by `buildGithubApi`). This is a materially different state from "the
 * protection resource exists but `required_status_checks` is disabled": a 404
 * means conversation-resolution, force-push/deletion restrictions, and admin
 * enforcement are ALSO entirely absent, not merely that the migration already
 * ran. `enable()`/`rollback()` must fail closed on this rather than treating
 * a missing resource as "already migrated" -- see `classicStatusChecksDisabled`,
 * which only reflects `required_status_checks` and is deliberately blind to
 * this distinction.
 */
export function classicProtectionMissing(protection) {
  return protection === null || protection === undefined;
}

/** True when classic protection's required_status_checks is disabled (null/absent). */
export function classicStatusChecksDisabled(protection) {
  return !protection?.required_status_checks;
}

/** True when classic protection's required_status_checks matches the legacy/rollback shape. */
export function classicStatusChecksRestored(protection) {
  const checks = protection?.required_status_checks;
  if (!checks || checks.strict !== true) return false;
  const contexts = (checks.checks || []).map((check) => `${check.context}:${check.app_id}`);
  return contexts.length === 1 && contexts[0] === `${REQUIRED_CONTEXT_CI}:${GITHUB_ACTIONS_APP_ID}`;
}

/**
 * Build the create/update body for the `refs/heads/main` ruleset that
 * requires `ci` + `merge-train` for everyone except the trusted merge-train
 * App, which bypasses always (needed for a direct, non-PR ref push).
 */
export function buildRulesetPayload({ trainAppId, name = RULESET_NAME }) {
  if (!Number.isInteger(trainAppId) || trainAppId <= 0) {
    throw new Error(`trainAppId must be a positive integer, received: ${trainAppId}`);
  }
  return {
    name,
    target: 'branch',
    enforcement: 'active',
    conditions: {
      ref_name: { include: [PROTECTED_REF], exclude: [] },
    },
    rules: [
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: REQUIRED_CONTEXT_CI, integration_id: GITHUB_ACTIONS_APP_ID },
            { context: REQUIRED_CONTEXT_TRAIN, integration_id: trainAppId },
          ],
        },
      },
    ],
    bypass_actors: [{ actor_id: trainAppId, actor_type: 'Integration', bypass_mode: 'always' }],
  };
}

/**
 * Thrown by `findRulesetByName` when more than one ruleset shares the
 * expected name -- see that function's doc comment for why this fails
 * closed instead of picking one.
 */
export class AmbiguousRulesetNameError extends Error {}

/**
 * Locate an existing ruleset by name from a `GET .../rulesets` list
 * response. Fails closed (throws `AmbiguousRulesetNameError`) if MORE THAN
 * ONE ruleset shares the name, instead of silently returning the first
 * match. This tool only ever creates a ruleset by this name after first
 * confirming none exists (see `enable()`), so a genuine second one appearing
 * means manual tampering, a race, or a bug elsewhere -- picking one blindly
 * risks `status`/`enable`/`rollback` all inspecting/mutating the "wrong" one
 * while another stale or active duplicate keeps enforcing (or fails to
 * enforce) independently, invisible to every command in this tool (raised
 * during issue #1151's adversarial plan review).
 */
export function findRulesetByName(rulesets, name = RULESET_NAME) {
  const matches = (rulesets || []).filter((ruleset) => ruleset.name === name);
  if (matches.length > 1) {
    throw new AmbiguousRulesetNameError(
      `Found ${matches.length} rulesets named "${name}" (ids: ` +
        `${matches.map((ruleset) => ruleset.id).join(', ')}) -- refusing to guess which one is ` +
        'authoritative. Resolve this manually in the GitHub UI/API (delete or rename the extra ' +
        'ruleset) before re-running status/enable/rollback.',
    );
  }
  return matches[0] || null;
}

/**
 * Validate a live ruleset object (as returned by `GET .../rulesets/{id}`)
 * against the expected live/enabled shape. Returns an array of human-readable
 * problems; empty means the ruleset matches. Fail-closed: any ambiguity
 * (missing fields, extra bypass actors) is reported as a problem rather than
 * silently accepted.
 */
export function rulesetProblems(ruleset, { trainAppId }) {
  const problems = [];
  if (!ruleset) {
    problems.push('ruleset does not exist');
    return problems;
  }
  if (ruleset.target !== 'branch') {
    problems.push(`ruleset target is "${ruleset.target}", expected "branch"`);
  }
  if (ruleset.enforcement !== 'active') {
    problems.push(`ruleset enforcement is "${ruleset.enforcement}", expected "active"`);
  }
  // Require an EXACT scope match (include is only main, exclude is empty) --
  // not just "main is somewhere in the list" -- so a ruleset broadened to
  // cover extra refs (which would silently extend the App's bypass beyond
  // main) is reported as a problem rather than accepted.
  const includes = ruleset.conditions?.ref_name?.include || [];
  const excludes = ruleset.conditions?.ref_name?.exclude || [];
  if (includes.length !== 1 || includes[0] !== PROTECTED_REF || excludes.length !== 0) {
    problems.push(
      `ruleset ref scope is include=[${includes.join(', ')}] exclude=[${excludes.join(', ')}], ` +
        `expected include=[${PROTECTED_REF}] exclude=[]`,
    );
  }
  const statusCheckRule = (ruleset.rules || []).find(
    (rule) => rule.type === 'required_status_checks',
  );
  if (!statusCheckRule) {
    problems.push('ruleset has no required_status_checks rule');
  } else {
    const contexts = (statusCheckRule.parameters?.required_status_checks || [])
      .map((check) => `${check.context}:${check.integration_id}`)
      .sort();
    const expected = [
      `${REQUIRED_CONTEXT_CI}:${GITHUB_ACTIONS_APP_ID}`,
      `${REQUIRED_CONTEXT_TRAIN}:${trainAppId}`,
    ].sort();
    if (JSON.stringify(contexts) !== JSON.stringify(expected)) {
      problems.push(
        `required_status_checks contexts are [${contexts.join(', ')}], expected [${expected.join(', ')}]`,
      );
    }
    if (statusCheckRule.parameters?.strict_required_status_checks_policy !== true) {
      problems.push('required_status_checks strict_required_status_checks_policy is not true');
    }
  }
  const bypassActors = ruleset.bypass_actors || [];
  const trainBypass = bypassActors.find(
    (actor) => actor.actor_type === 'Integration' && actor.actor_id === trainAppId,
  );
  if (!trainBypass) {
    problems.push(`ruleset has no Integration bypass actor for App id ${trainAppId}`);
  } else if (trainBypass.bypass_mode !== 'always') {
    problems.push(
      `Integration bypass actor for App id ${trainAppId} has bypass_mode "${trainBypass.bypass_mode}", expected "always"`,
    );
  }
  if (bypassActors.length !== 1) {
    problems.push(
      `ruleset has ${bypassActors.length} bypass actor(s), expected exactly 1 (the trusted App)`,
    );
  }
  return problems;
}

/**
 * Build the ruleset PATCH body used to disable it during rollback (kept, not
 * deleted). Shape-preserving: copies `name`/`target`/`conditions`/`rules`/
 * `bypass_actors` verbatim from the fetched LIVE ruleset object, only
 * overriding `enforcement`.
 *
 * An earlier version of this function instead called
 * `buildRulesetPayload({ trainAppId: requireTrainBypassId(ruleset) })`,
 * reconstructing an "expected" ruleset body from scratch and THROWING if the
 * live ruleset had no Integration bypass actor to infer the trusted App id
 * from. That made recovery impossible for exactly the incident this function
 * exists to handle: a partially-applied `enable()` (or manual tampering)
 * leaves the ruleset active but missing/wrong its bypass actor. Because
 * `rollback()` restores classic `ci` protection BEFORE this function runs, a
 * throw here left `main` in a state where classic `ci` is enforced (good)
 * but the ruleset is STILL ACTIVE requiring `merge-train` (bad -- nothing
 * posts that check while the train is off) with no automated way to shut it
 * off, since the only disable path required data (a valid bypass actor) the
 * broken ruleset itself didn't have -- a permanent-lockout window.
 *
 * Disabling (`enforcement: 'disabled'`) makes a ruleset's `rules`/
 * `bypass_actors` content functionally inert: nothing is enforced, so there
 * is no correctness reason to also "fix" the bypass actor just to turn
 * enforcement off. Preserving the ruleset's OWN live shape verbatim (rather
 * than reconstructing an idealized one) means disabling always succeeds
 * regardless of how broken the ruleset currently is; the only field this
 * function changes is `enforcement`.
 *
 * `trainAppId`, when supplied (from `--app-id`/`MERGE_TRAIN_APP_ID` --
 * independent of the ruleset's own possibly-broken content), is used ONLY to
 * repair `bypass_actors` in the case the live ruleset has none at all, so a
 * later `enable()` re-run starts from a ruleset that still names the trusted
 * App instead of one that silently lost track of it. It is never required:
 * omitting it still produces a valid disable payload with whatever
 * `bypass_actors` the live ruleset already has (including none).
 */
export function buildRulesetDisablePayload(ruleset, { trainAppId } = {}) {
  const bypassActors =
    ruleset.bypass_actors && ruleset.bypass_actors.length > 0
      ? ruleset.bypass_actors
      : trainAppId
        ? [{ actor_id: trainAppId, actor_type: 'Integration', bypass_mode: 'always' }]
        : [];
  return {
    name: ruleset.name,
    target: ruleset.target,
    conditions: ruleset.conditions,
    rules: ruleset.rules,
    bypass_actors: bypassActors,
    enforcement: 'disabled',
  };
}

/**
 * Infer the trusted App id from a live ruleset's Integration bypass actor,
 * for the read-only `status` reporting path and as the preferred (but never
 * required -- see `buildRulesetDisablePayload`) source `rollback()` uses to
 * preserve the existing bypass actor on disable, so `printStatus` can render
 * `problems` against the right expected id without requiring the operator to
 * re-supply it during an incident. Returns `null` (never throws) when no
 * ruleset or no Integration bypass actor exists yet -- `enable` always
 * requires an explicit `--app-id` since there may be nothing to infer from
 * on a first run, and `rollback`'s disable path falls back to an
 * independently-supplied `--app-id`/`MERGE_TRAIN_APP_ID` (or an empty
 * `bypass_actors` list) when this returns `null` too.
 */
export function inferTrainAppId(ruleset) {
  const bypass = (ruleset?.bypass_actors || []).find((actor) => actor.actor_type === 'Integration');
  return bypass ? bypass.actor_id : null;
}

/** True once the ruleset is present but not enforced (rollback complete). */
export function rulesetDisabled(ruleset) {
  return Boolean(ruleset) && ruleset.enforcement !== 'active';
}
