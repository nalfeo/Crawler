import {
  GITHUB_ACTIONS_LOGIN,
  isCopilotLogin,
  runIssueIntake,
} from '../ci-recovery/issue-intake-lib.mjs';
import { graphql, paginate, request } from '../ci-recovery/github.mjs';
import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';

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

export async function runNightlyAgentIssue({
  githubToken,
  intakeToken,
  repository,
  issueTitle,
  issueLabels,
  buildIssueBodyFn,
  requestFn = request,
  paginateFn = paginate,
  graphqlFn = graphql,
  intakeFn = runIssueIntake,
}) {
  requireToken(githubToken, 'GITHUB_TOKEN');
  requireToken(intakeToken, 'CRAWLER_CI_PAT');
  if (!issueTitle) throw new Error('issueTitle is required');
  if (!Array.isArray(issueLabels)) throw new Error('issueLabels must be an array');
  if (typeof buildIssueBodyFn !== 'function') {
    throw new Error('buildIssueBodyFn must be a function');
  }
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
