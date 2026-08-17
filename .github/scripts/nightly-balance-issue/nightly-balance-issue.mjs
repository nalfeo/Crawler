import {
  GITHUB_ACTIONS_LOGIN,
  isCopilotLogin,
  runIssueIntake,
} from '../ci-recovery/issue-intake-lib.mjs';
import { graphql, paginate, request } from '../ci-recovery/github.mjs';
import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';

export const ISSUE_TITLE = 'balance: telemetry-driven nightly improvement sweep';
export const ISSUE_LABELS = Object.freeze([
  'bug',
  'automation',
  'telemetry',
  'simulation',
  'ai',
  HUMAN_APPROVAL_LABEL,
]);

export const FINAL_AGGREGATE_ARTIFACTS = Object.freeze([
  'weapon-sweep-sword',
  'weapon-sweep-bow',
  'weapon-sweep-baseball-bat',
  'weapon-sweep-pistol',
  'weapon-sweep-throwing-knife',
  'weapon-sweep-fireball',
]);

export function buildFinalAggregateArtifactClause() {
  return `all six FINAL aggregate artifacts (\`${FINAL_AGGREGATE_ARTIFACTS.join('`, `')}\`) and 100 seeds/weapon only`;
}

export function buildIssueBody(issueNumber = '<this issue number>') {
  return `## Objective
Examine eligible current telemetry, identify and rank up to 3 evidence-backed game-balance improvements, evaluate each independently with canonical sweeps, and ship only treatments supported by comparable aggregate evidence. Zero eligible ideas is valid and produces no implementation PR.

## Baseline eligibility — hard gate
- Latest successful current-main \`weapon-sweep.yml\` with ${buildFinalAggregateArtifactClause()}.
- Record run ID, UTC timestamp, exact head SHA, seed range/count, max frames/time budget, weapon list, every behavior/config flag.
- Never use individual/selected shards, partial artifacts, local smoke, hand-picked seeds, or mixed runs.
- Shipped/default runtime configuration only for shipped changes. Default-off/experimental flags may only support explicitly experiment-scoped work.
- Prove baseline SHA still represents current main; gameplay commits after it require fresh canonical GitHub Actions sweep. Missing/unavailable artifacts => stop, no implementation/PR.
- No new eligible aggregate run since prior analysis => stop duplicate work.
- State releases/tags and real-player telemetry honestly; never call headless data release/player telemetry or invent lookback.

## Candidate eligibility — hard gate
Propose UP TO 3, including zero; never fill quota. For each candidate at exact baseline SHA require: exact measured aggregate fields/values; telemetry-backed causal attribution; real Floor-1 production reachability traced from headless/simulation entry through enabling config; proof feature/entity/mode/spawn table/flag was enabled in baseline; named observable canonical metric. Registry/export/lab/test presence, empty config, disabled flags, dormant definitions, unreachable code are ineligible. Never claim enemy/room/encounter/attack/damage source unless artifact records it. Unknown/unproven => reject before ranking; missing attribution => telemetry/investigation, not tuning. Separate facts, hypotheses, source inspection.

## Evaluation contract — hard gate
One change at a time; identical seeds/weapons/flags/limits; >10 runs via GitHub workflow dispatch; local smoke never accepts/rejects; never bundle unmeasured ideas or infer marginal contribution from combined treatment; never substitute 10-seed indicative results; max 3 attempts/candidate; no named-seed tuning; inability to run independent canonical sweep => no implementation/PR; accept/reject before next; final accepted combination gets fresh canonical aggregate sweep.

## Durable ledger
Max 9 rows. Per row: rank/name, measured symptom, causal evidence, production path, enabling config/flag, hypothesis, exact change, baseline/post metrics, run/artifact URLs, verdict, accepted/rejected/blocked rationale. Keep rejected/blocked visible.

## Mandatory human approval gate
Gameplay PR contains \`Closes #${issueNumber}\`, labels \`human-approval-required\` + \`merge-train-blocked\`, ready not draft, no \`merge-train\`/auto-merge/merge. Only an approving GitHub review from owner \`nalfeo\`, or their exact standalone trimmed comment \`APPROVED FOR CHECK-IN\`, unlocks. Green CI/quoted text/substrings/reviews or comments from other authors do not count. Bad final evidence => close/abandon.

## Acceptance evidence
Up to 3 eligible ideas (zero allowed/no PR), <=3 attempts each, complete ledger, comparable aggregate baseline/post artifacts, final judge, explicit approval status, normal verification/review/harness/handoff/determinism.

## Terminal no-PR closure — hard gate
This issue stays open only while work is in progress; a later nightly run no-ops while it is open. Every terminal outcome that produces no implementation PR — zero eligible candidates, stale/duplicate baseline, missing/unavailable artifacts, failed evaluation contract, or any other stop condition above — is not complete until you post a final rationale/ledger comment summarizing the decision and evidence, then close this issue. Leaving this issue open after a no-PR conclusion blocks every future nightly run from filing a fresh issue against newer telemetry, so closure is mandatory, not optional, for every no-PR path.

@copilot Please execute this issue end-to-end, but obey every hard evidence gate and the mandatory human approval gate above.`;
}

export const ISSUE_BODY = buildIssueBody();

function parseRepository(repository) {
  const parts = String(repository || '').split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error('GITHUB_REPOSITORY must be in owner/repo form');
  }
  return { owner: parts[0], repo: parts[1] };
}

function requireToken(value, name) {
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
}

function getErrorMessage(error) {
  return error?.message ?? String(error);
}

async function ensureHumanApprovalLabel({ requestFn, githubToken, owner, repo }) {
  const labelPath = `/repos/${owner}/${repo}/labels/${encodeURIComponent(HUMAN_APPROVAL_LABEL)}`;
  try {
    await requestFn(githubToken, labelPath);
  } catch (error) {
    if (error?.status !== 404) throw error;
    await requestFn(githubToken, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: {
        name: HUMAN_APPROVAL_LABEL,
        color: 'b60205',
        description: 'Requires explicit repository-owner approval before merge automation',
      },
    });
  }
}

async function closeCreatedIssue({ requestFn, githubToken, owner, repo, issueNumber }) {
  await requestFn(githubToken, `/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: { state: 'closed', state_reason: 'not_planned' },
  });
}

async function updateCreatedIssueBody({
  requestFn,
  githubToken,
  owner,
  repo,
  issueNumber,
  buildIssueBodyFn,
}) {
  await requestFn(githubToken, `/repos/${owner}/${repo}/issues/${issueNumber}`, {
    method: 'PATCH',
    body: { body: buildIssueBodyFn(issueNumber) },
  });
}

// An exact-title open issue is only safe to resume-intake or rollback-close when this
// automation actually created it: opened by GITHUB_TOKEN's github-actions[bot] identity
// and carrying the `automation` label this script always applies. Anything else (e.g. a
// human-filed issue that happens to reuse the title) must be left alone.
function isAutomationOwnedIssue(issue) {
  const opener = String(issue?.user?.login || '').toLowerCase();
  if (opener !== GITHUB_ACTIONS_LOGIN) return false;
  const labels = (issue?.labels || []).map((label) =>
    String(typeof label === 'string' ? label : label?.name || '').toLowerCase(),
  );
  return labels.includes('automation');
}

// runIssueIntake only returns successfully after replaceActorsForAssignable confirms a
// Copilot login among the issue's assignees, so a Copilot assignee on the issue is
// durable, deterministic proof that intake previously completed. GitHub's list-issues
// response (already fetched via paginateFn) includes `assignees`, so this needs no
// extra API call.
function hasCompletedIntakeProof(issue) {
  const assignees = Array.isArray(issue?.assignees) ? issue.assignees : [];
  return assignees.some((assignee) => isCopilotLogin(assignee?.login));
}

async function intakeWithRollback({
  intakeFn,
  graphqlFn,
  paginateFn,
  requestFn,
  intakeToken,
  githubToken,
  owner,
  repo,
  issue,
}) {
  try {
    return await intakeFn({
      graphql: graphqlFn,
      paginate: paginateFn,
      request: requestFn,
      token: intakeToken,
      owner,
      repo,
      issue,
    });
  } catch (intakeError) {
    try {
      await closeCreatedIssue({
        requestFn,
        githubToken,
        owner,
        repo,
        issueNumber: issue.number,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [intakeError, rollbackError],
        `Issue intake failed for #${issue.number}: ${getErrorMessage(intakeError)}; closing the issue also failed: ${getErrorMessage(rollbackError)}`,
        { cause: intakeError },
      );
    }
    throw intakeError;
  }
}

export async function runNightlyBalanceIssue({
  githubToken,
  intakeToken,
  repository,
  issueTitle = ISSUE_TITLE,
  issueLabels = ISSUE_LABELS,
  buildIssueBodyFn = buildIssueBody,
  requestFn = request,
  paginateFn = paginate,
  graphqlFn = graphql,
  intakeFn = runIssueIntake,
}) {
  requireToken(githubToken, 'GITHUB_TOKEN');
  requireToken(intakeToken, 'CRAWLER_CI_PAT');
  const { owner, repo } = parseRepository(repository);

  const openIssues = await paginateFn(githubToken, `/repos/${owner}/${repo}/issues?state=open`);
  const existing = openIssues.find(
    (candidate) => !candidate.pull_request && candidate.title === issueTitle,
  );
  if (existing) {
    // Only an issue this automation created can safely be mutated; a foreign
    // exact-title issue is always left untouched (deterministic no-op).
    if (!isAutomationOwnedIssue(existing)) {
      return { status: 'existing', issue: existing };
    }

    await updateCreatedIssueBody({
      requestFn,
      githubToken,
      owner,
      repo,
      issueNumber: existing.number,
      buildIssueBodyFn,
    });

    if (hasCompletedIntakeProof(existing)) {
      return { status: 'existing', issue: existing };
    }

    // No completed-intake proof on our own issue means a prior run's intake and its
    // rollback close both failed (AggregateError path below), leaving an orphan. Resume
    // intake on the same issue rather than permanently no-op'ing on it forever.
    const intake = await intakeWithRollback({
      intakeFn,
      graphqlFn,
      paginateFn,
      requestFn,
      intakeToken,
      githubToken,
      owner,
      repo,
      issue: existing,
    });
    return { status: 'resumed', issue: existing, intake };
  }

  await ensureHumanApprovalLabel({ requestFn, githubToken, owner, repo });
  const created = await requestFn(githubToken, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: {
      title: issueTitle,
      body: buildIssueBodyFn(),
      labels: issueLabels,
    },
  });
  const issue = created.data;
  if (!Number.isInteger(issue?.number) || !issue?.node_id) {
    throw new Error('GitHub issue creation response omitted number or node_id');
  }

  try {
    await updateCreatedIssueBody({
      requestFn,
      githubToken,
      owner,
      repo,
      issueNumber: issue.number,
      buildIssueBodyFn,
    });
  } catch (updateError) {
    try {
      await closeCreatedIssue({
        requestFn,
        githubToken,
        owner,
        repo,
        issueNumber: issue.number,
      });
    } catch (rollbackError) {
      throw new AggregateError(
        [updateError, rollbackError],
        `Issue body update failed for #${issue.number}: ${getErrorMessage(updateError)}; closing the issue also failed: ${getErrorMessage(rollbackError)}`,
        { cause: updateError },
      );
    }
    throw updateError;
  }

  const intake = await intakeWithRollback({
    intakeFn,
    graphqlFn,
    paginateFn,
    requestFn,
    intakeToken,
    githubToken,
    owner,
    repo,
    issue,
  });

  return { status: 'created', issue, intake };
}
