#!/usr/bin/env node
// CLI for the merge-train branch-protection fix. See protection-lib.mjs for
// the full rationale and docs/knowledge/adr/0062-merge-train-ruleset-app-bypass.md
// for the design. Idempotent: safe to re-run any subcommand.
//
// Usage:
//   node .github/scripts/merge-train/protection.mjs status
//   node .github/scripts/merge-train/protection.mjs enable
//   node .github/scripts/merge-train/protection.mjs rollback [--force]
//
// Auth/target resolution (in order):
//   --repo owner/repo         | GITHUB_REPOSITORY            | `gh repo view`
//   --app-id <id>             | MERGE_TRAIN_APP_ID            | required for `enable`;
//                                                                optional for `status`/`rollback`.
//                                                                When omitted, `status`/`rollback`
//                                                                still run, but `status.ruleset.problems`
//                                                                reports "trusted App id not supplied"
//                                                                instead of silently validating against
//                                                                an id inferred from the very ruleset
//                                                                being checked (that would be circular).
//   MERGE_TRAIN_TOKEN | GITHUB_TOKEN | `gh auth token` (for API calls)
//
// Orchestration (`enable`/`rollback`/`printStatus`) takes an injected `api`
// object so it can be unit-tested against an in-memory fake instead of the
// real GitHub API -- see protection.test.mjs. `buildGithubApi` below is the
// only piece that talks to the network; it is deliberately thin.

import { execFileSync } from 'node:child_process';

import { paginate, request } from '../ci-recovery/github.mjs';
import {
  assertKnownClassicStatusChecksShape,
  buildClassicProtectionPayload,
  buildRulesetDisablePayload,
  buildRulesetPayload,
  classicProtectionMissing,
  classicStatusChecksDisabled,
  classicStatusChecksRestored,
  findRulesetByName,
  inferTrainAppId,
  legacyRequiredStatusChecks,
  rulesetDisabled,
  rulesetProblems,
  RULESET_NAME,
} from './protection-lib.mjs';

/**
 * Fail closed if classic branch protection for `main` does not exist at all
 * (404 -- mapped to `null`/`undefined` by `buildGithubApi`). A missing
 * protection resource is NOT the same as "required_status_checks already
 * disabled": it also means conversation-resolution, force-push/deletion
 * restrictions, and admin enforcement are entirely absent, which this tool
 * has no way to distinguish from unintentional drift. `enable()` and
 * `rollback()` both call this before doing anything else with the fetched
 * classic protection object.
 */
function assertClassicProtectionExists(protection) {
  if (classicProtectionMissing(protection)) {
    throw new Error(
      'Classic branch protection for main does not exist (404 from ' +
        '/branches/main/protection). Refusing to proceed: this tool only migrates ' +
        'required_status_checks off of an EXISTING classic configuration -- a missing ' +
        'protection resource means conversation-resolution/force-push/deletion/admin-' +
        'enforcement settings are also entirely absent, and treating that the same as ' +
        '"already migrated" would silently skip preserving them. Configure classic branch ' +
        'protection for main (matching the documented legacy shape) before running this.',
    );
  }
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const flags = { force: false, repo: null, appId: null };
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--force') flags.force = true;
    else if (arg === '--repo') flags.repo = rest[++index];
    else if (arg === '--app-id') flags.appId = Number.parseInt(rest[++index], 10);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { command, flags };
}

function resolveRepo(flags) {
  if (flags.repo) return flags.repo;
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner'], {
    encoding: 'utf8',
  }).trim();
}

function resolveToken() {
  if (process.env.MERGE_TRAIN_TOKEN) return process.env.MERGE_TRAIN_TOKEN;
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim();
}

function resolveAppId(flags, { required = true } = {}) {
  const appId = flags.appId ?? Number.parseInt(process.env.MERGE_TRAIN_APP_ID || '', 10);
  if (Number.isInteger(appId) && appId > 0) return appId;
  if (!required) return null;
  throw new Error('Trusted App id is required: pass --app-id <id> or set MERGE_TRAIN_APP_ID');
}

/** Real GitHub-backed implementation of the API surface enable/rollback/printStatus need. */
export function buildGithubApi(token, owner, repo) {
  return {
    async getClassicProtection() {
      try {
        return (await request(token, `/repos/${owner}/${repo}/branches/main/protection`)).data;
      } catch (error) {
        if (error.status === 404) return null;
        throw error;
      }
    },
    async putClassicProtection(body) {
      await request(token, `/repos/${owner}/${repo}/branches/main/protection`, {
        method: 'PUT',
        body,
      });
    },
    async getRulesets() {
      // includes_parents intentionally false: this repo (nalfeo/Crawler) is
      // owned by a personal GitHub *User* account (verified via
      // `gh api repos/nalfeo/Crawler --jq .owner.type` => "User"), and
      // organization/enterprise-level rulesets structurally cannot exist for
      // repos under a personal account -- there is no parent ruleset scope
      // to inherit from today. Revisit (switch to includes_parents=true and
      // teach findRulesetByName to distinguish repo-owned vs. inherited
      // rulesets before mutating) if this repository is ever transferred
      // into an organization.
      //
      // Paginated (100/page) via the shared paginate() helper -- a single
      // un-paginated page would let findRulesetByName() miss an
      // already-existing "Merge Train Required Checks" ruleset once the repo
      // accumulates more than one page of rulesets, causing enable() to
      // create a duplicate instead of updating the existing one.
      return paginate(token, `/repos/${owner}/${repo}/rulesets?includes_parents=false`);
    },
    async getRuleset(id) {
      return (await request(token, `/repos/${owner}/${repo}/rulesets/${id}`)).data;
    },
    async createRuleset(body) {
      return (await request(token, `/repos/${owner}/${repo}/rulesets`, { method: 'POST', body }))
        .data;
    },
    async updateRuleset(id, body) {
      return (
        await request(token, `/repos/${owner}/${repo}/rulesets/${id}`, { method: 'PUT', body })
      ).data;
    },
    async getMergeTrainEnabled() {
      try {
        const response = await request(
          token,
          `/repos/${owner}/${repo}/actions/variables/MERGE_TRAIN_ENABLED`,
        );
        return response.data.value === 'true';
      } catch (error) {
        if (error.status === 404) return false;
        throw error;
      }
    },
  };
}

export async function printStatus({ api, appId, log = () => {} }) {
  const [protection, rulesetSummaries] = await Promise.all([
    api.getClassicProtection(),
    api.getRulesets(),
  ]);
  const rulesetSummary = findRulesetByName(rulesetSummaries);
  // Hydrate to the FULL ruleset detail (`GET .../rulesets/{id}`) before
  // validating anything. `getRulesets()` calls the LIST endpoint
  // (`GET .../rulesets`), which GitHub documents as returning summary objects
  // only -- `id`/`name`/`target`/`enforcement`/etc, but NOT `conditions`,
  // `rules`, or `bypass_actors`. Validating those fields straight off the
  // list-summary object makes every live, correctly-configured ruleset look
  // completely broken (empty ref scope, no required status checks, no
  // bypass actor) regardless of its real state. This exact bug caused a live
  // false-failure incident on 2026-07-15: `enable` created ruleset 19000576
  // correctly (verified moments later via the detail endpoint), but this
  // function's postcondition read validated the un-hydrated list-summary
  // object, reported the ruleset as empty/missing, failed the postcondition,
  // and triggered an automatic rollback of a config that was actually
  // correct. `enable()`'s OWN internal postcondition check (right after
  // create/update) already hydrated correctly via a direct `getRuleset(id)`
  // call -- only this shared status path had the bug, and since both
  // `enable()`/`rollback()` delegate their final postcondition to this
  // function, they inherited it too.
  const ruleset = rulesetSummary ? await api.getRuleset(rulesetSummary.id) : null;
  const trainEnabled = await api.getMergeTrainEnabled();
  // `problems` MUST be validated against a trusted, independently-supplied App
  // id (--app-id / MERGE_TRAIN_APP_ID) -- never against an id inferred from
  // the very ruleset being validated. Inferring the "expected" id from the
  // live bypass actor and then comparing that live bypass actor against it is
  // circular: a ruleset drifted to point at ANY single Integration actor
  // (including a wrong/compromised one) would trivially report zero problems.
  // Inference (`inferTrainAppId`) is still exposed below as `bypassActorId`
  // for read-only display / as rollback's preferred (but not required, see
  // buildRulesetDisablePayload) bypass-actor-preserving source, but never
  // feeds `problems`.
  const problems = appId
    ? rulesetProblems(ruleset, { trainAppId: appId })
    : ruleset
      ? [
          'trusted App id not supplied (--app-id or MERGE_TRAIN_APP_ID); cannot validate the ' +
            'ruleset bypass actor against a trusted identity -- inferring "expected" from the ' +
            "ruleset's own live bypass actor would trivially match any single actor, including a " +
            'wrong or compromised one, so this reports unknown rather than a false "no problems"',
        ]
      : ['ruleset does not exist'];
  // A 404 on classic protection (the resource itself does not exist) is a
  // materially different, more severe state than "required_status_checks is
  // disabled": it also means conversation-resolution, force-push/deletion
  // restrictions, and admin enforcement are entirely absent. Treating null
  // the same as "cleanly migrated" here let `enable()`/`rollback()`'s shared
  // postcondition check (which reuses this report) silently pass even if
  // classic protection vanished entirely between the mutation and this read
  // -- see classicProtectionMissing()'s doc comment. `missing` is reported
  // explicitly so both the read-only `status` command and the write-path
  // postcondition checks can fail closed on it instead of just inferring a
  // false "disabled: true" from a 404.
  const classicMissing = classicProtectionMissing(protection);
  const report = {
    mergeTrainEnabled: trainEnabled,
    classic: {
      missing: classicMissing,
      requiredStatusChecksDisabled: classicStatusChecksDisabled(protection),
      requiredStatusChecksRestored: classicStatusChecksRestored(protection),
      requiredStatusChecks: protection?.required_status_checks || null,
    },
    ruleset: {
      exists: Boolean(ruleset),
      id: ruleset?.id,
      enforcement: ruleset?.enforcement,
      // Informational only -- read-only display of who the live bypass actor
      // currently is. Never used to validate `problems` (see above).
      bypassActorId: inferTrainAppId(ruleset),
      // Always computed (even when the ruleset is missing -- reports
      // "ruleset does not exist" in that case) so enable()/rollback()
      // postcondition checks can rely on `problems.length === 0` alone rather
      // than also having to remember to check `exists` separately.
      problems,
    },
  };
  log(`${JSON.stringify(report, null, 2)}\n`);
  return report;
}

export async function enable({ api, appId, log = () => {} }) {
  // Read and validate the live classic protection FIRST -- before ANY
  // mutation, including ruleset creation -- so an unknown/drifted classic
  // shape (or a missing classic-protection resource entirely) aborts before
  // the ruleset is ever created/activated. Validating this only after
  // creating the ruleset (as an earlier version of this function did) would
  // leave `main` behind an ACTIVE ruleset requiring the `merge-train` context
  // on abort, while `MERGE_TRAIN_ENABLED` is still false and nothing posts
  // that check -- permanently blocking every ordinary merge into `main`
  // until a human manually disables the half-applied ruleset. Reading here
  // is safe to do before the ruleset write because it is read-only; the
  // actual WRITE ordering below (ruleset first, then classic) is preserved
  // for the same fail-closed reason described there.
  const initialProtection = await api.getClassicProtection();
  assertClassicProtectionExists(initialProtection);
  if (!classicStatusChecksDisabled(initialProtection)) {
    assertKnownClassicStatusChecksShape(initialProtection);
  }

  // Create/verify the ruleset FIRST, and only disable classic protection
  // once the ruleset postcondition is confirmed live. Reversing this order
  // (disable classic, then create the ruleset) would leave a window where
  // NEITHER mechanism enforces `ci` on main if ruleset creation fails
  // partway -- the same fail-closed invariant rollback() already applies in
  // its own direction.
  const rulesets = await api.getRulesets();
  const existing = findRulesetByName(rulesets);
  const rulesetPayload = buildRulesetPayload({ trainAppId: appId });
  let rulesetId;
  if (existing) {
    await api.updateRuleset(existing.id, rulesetPayload);
    rulesetId = existing.id;
    log(`updated ruleset "${RULESET_NAME}" (id ${existing.id})\n`);
  } else {
    const created = await api.createRuleset(rulesetPayload);
    rulesetId = created.id;
    log(`created ruleset "${RULESET_NAME}" (id ${created.id})\n`);
  }

  const liveRuleset = await api.getRuleset(rulesetId);
  const rulesetProblemsFound = rulesetProblems(liveRuleset, { trainAppId: appId });
  if (rulesetProblemsFound.length > 0) {
    throw new Error(
      `enable aborted before touching classic protection: ruleset postcondition failed: ` +
        `${JSON.stringify(rulesetProblemsFound)}`,
    );
  }

  // Re-fetch (rather than reusing `initialProtection`) in case classic
  // protection changed between the pre-flight read above and this write --
  // re-validate defensively for the same reason.
  const protection = await api.getClassicProtection();
  assertClassicProtectionExists(protection);
  if (!classicStatusChecksDisabled(protection)) {
    assertKnownClassicStatusChecksShape(protection);
    const payload = buildClassicProtectionPayload(protection, { requiredStatusChecks: null });
    await api.putClassicProtection(payload);
    log('disabled classic required_status_checks\n');
  } else {
    log('classic required_status_checks already disabled\n');
  }

  const report = await printStatus({ api, appId, log });
  const problems = report.ruleset.problems || [];
  // `classic.missing` is checked explicitly rather than folded into
  // `requiredStatusChecksDisabled` -- a 404 must never be silently accepted
  // as "cleanly disabled" (see printStatus's classicMissing comment).
  if (
    report.classic.missing ||
    !report.classic.requiredStatusChecksDisabled ||
    !report.ruleset.exists ||
    problems.length > 0
  ) {
    throw new Error(
      `enable postcondition failed: classicMissing=${report.classic.missing} ` +
        `classicDisabled=${report.classic.requiredStatusChecksDisabled} ` +
        `rulesetExists=${report.ruleset.exists} problems=${JSON.stringify(problems)}`,
    );
  }
  log('enable postcondition verified: classic disabled, ruleset live with App bypass\n');
  return report;
}

export async function rollback({ api, appId, force, log = () => {} }) {
  const trainEnabled = await api.getMergeTrainEnabled();
  if (trainEnabled && !force) {
    throw new Error(
      'MERGE_TRAIN_ENABLED is true. Disable it first (gh variable set MERGE_TRAIN_ENABLED ' +
        '--repo <owner>/<repo> --body false) so nothing publishes the merge-train check while ' +
        'protection is being rolled back. Pass --force to override.',
    );
  }

  // Restore classic ci-required protection BEFORE touching the ruleset so
  // there is never a window where neither classic protection nor the
  // ruleset enforces `ci` on main.
  const protection = await api.getClassicProtection();
  assertClassicProtectionExists(protection);
  if (!classicStatusChecksRestored(protection)) {
    // Same fail-closed guard enable() applies before *disabling* classic
    // required_status_checks: if an operator manually strengthened classic
    // protection (e.g. added a second required context) while the ruleset
    // was live, rollback must not silently discard that drift by blindly
    // overwriting it with the legacy ci-only shape.
    assertKnownClassicStatusChecksShape(protection);
    const payload = buildClassicProtectionPayload(protection, {
      requiredStatusChecks: legacyRequiredStatusChecks(),
    });
    await api.putClassicProtection(payload);
    log('restored classic required_status_checks (ci, strict)\n');
  } else {
    log('classic required_status_checks already restored\n');
  }

  const rulesets = await api.getRulesets();
  const existing = findRulesetByName(rulesets);
  if (existing && existing.enforcement === 'active') {
    const full = await api.getRuleset(existing.id);
    // Pass the independently-supplied `appId` (--app-id/MERGE_TRAIN_APP_ID)
    // as a repair fallback so disabling a ruleset that lost/never had its
    // Integration bypass actor (partial `enable()`, manual tampering) still
    // succeeds -- see buildRulesetDisablePayload for the recovery rationale.
    //
    // buildRulesetDisablePayload always preserves ANY EXISTING bypass actor
    // verbatim (it is inert once enforcement=disabled), so a drifted/wrong
    // one is carried forward silently unless flagged here. Surface it as an
    // operator-visible warning rather than normalizing it away: normalizing
    // would mean this read-then-write rollback path starts making a policy
    // decision about "the right" bypass actor during an incident response,
    // which is exactly the kind of surprise mutation rollback should avoid.
    //
    // Checked against `hasLiveActors` (any bypass_actors entry), not just
    // `inferTrainAppId()`'s Integration-typed result: `inferTrainAppId`
    // returns null both when there are zero bypass actors (nothing to warn
    // about -- buildRulesetDisablePayload will repair via trainAppId) AND
    // when a live actor exists but isn't type 'Integration' (e.g. tampered
    // into a 'RepositoryRole' or 'Team' actor) -- the latter IS drift that
    // still gets preserved verbatim and deserves the same warning (raised in
    // issue #1151's multi-model review).
    const liveBypassId = inferTrainAppId(full);
    const hasLiveActors = Boolean(full.bypass_actors && full.bypass_actors.length > 0);
    if (appId && hasLiveActors && liveBypassId !== appId) {
      log(
        `WARNING: ruleset "${RULESET_NAME}" (id ${existing.id}) bypass actor is ` +
          `${liveBypassId ?? JSON.stringify(full.bypass_actors)}, which does not match the ` +
          `supplied trusted --app-id ${appId}. Disabling makes this inert, but the drifted actor ` +
          'is preserved as-is (not normalized) -- investigate before the next enable.\n',
      );
    }
    await api.updateRuleset(existing.id, buildRulesetDisablePayload(full, { trainAppId: appId }));
    log(`disabled ruleset "${RULESET_NAME}" (id ${existing.id})\n`);
  } else if (existing) {
    log(`ruleset "${RULESET_NAME}" already disabled\n`);
  } else {
    log(`ruleset "${RULESET_NAME}" does not exist; nothing to disable\n`);
  }

  const report = await printStatus({ api, appId, log });
  const rulesetOk = rulesetDisabled(report.ruleset);
  if (report.classic.missing || !report.classic.requiredStatusChecksRestored || !rulesetOk) {
    throw new Error(
      `rollback postcondition failed: classicMissing=${report.classic.missing} ` +
        `classicRestored=${report.classic.requiredStatusChecksRestored} ` +
        `rulesetEnforcement=${report.ruleset.enforcement}`,
    );
  }
  log('rollback postcondition verified: legacy classic ci restored, ruleset inactive\n');
  return report;
}

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const repoFull = resolveRepo(flags);
  const [owner, repo] = repoFull.split('/');
  if (!owner || !repo) throw new Error(`Invalid repo "${repoFull}", expected owner/repo`);
  const token = resolveToken();
  const api = buildGithubApi(token, owner, repo);
  const log = (message) => process.stdout.write(message);

  if (command === 'status') {
    await printStatus({ api, appId: resolveAppId(flags, { required: false }), log });
    return;
  }
  if (command === 'enable') {
    await enable({ api, appId: resolveAppId(flags), log });
    return;
  }
  if (command === 'rollback') {
    await rollback({
      api,
      appId: resolveAppId(flags, { required: false }),
      force: flags.force,
      log,
    });
    return;
  }
  throw new Error(`Unknown command "${command}". Expected: status | enable | rollback`);
}

const isMain = import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}`;
if (isMain || process.argv[1]?.endsWith('protection.mjs')) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

export { main };
