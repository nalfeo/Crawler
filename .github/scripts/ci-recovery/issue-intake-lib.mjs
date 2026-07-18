import { TRUSTED_ASSOCIATIONS, TRUSTED_BOT_LOGINS } from './state.mjs';

export const ISSUE_INTAKE_MARKER = '<!-- crawler-issue-intake:v1 -->';
export const GITHUB_ACTIONS_LOGIN = 'github-actions[bot]';
const COPILOT_OPENER_LOGINS = new Set([
  'copilot',
  'copilot[bot]',
  'app/copilot',
  'copilot-swe-agent',
  'copilot-swe-agent[bot]',
  'app/copilot-swe-agent',
]);

// Exported so callers (e.g. nightly-balance-issue.mjs) can recognize a completed
// Copilot assignment as durable proof of finished intake without duplicating this
// login list.
export function isCopilotLogin(login) {
  return COPILOT_OPENER_LOGINS.has(String(login || '').toLowerCase());
}

export const ISSUE_INTAKE_BODY = [
  ISSUE_INTAKE_MARKER,
  '@copilot',
  '',
  "Please handle this issue under the repository's normal development rules with no shortcuts:",
  '- Follow `AGENTS.md` and `.github/copilot-instructions.md` exactly.',
  '- Keep all required verification/review-harness/ledger steps for code-touching work.',
  '- Do not weaken gates, policy checks, or explicit human requirements to get green.',
  '',
  '**Before writing any code**, post a detailed plan comment on this issue that covers:',
  '- High-level design and approach for the work.',
  '- Key decisions made (e.g. which systems, skills, or libraries are involved; alternatives considered).',
  '- A checklist of the concrete steps you will take.',
  '',
  'Post this plan comment on the issue itself so the maintainer can review it before you open a PR.',
  'Then, when you open the PR, include the same high-level summary in the PR description.',
].join('\n');

export function issueIntakeEligibility(issue, maintainerLogin = 'nalfeo') {
  if (!issue || issue.pull_request) {
    return { eligible: false, reason: 'event has no eligible issue payload' };
  }

  const opener = String(issue.user?.login || '').toLowerCase();
  const maintainer = String(maintainerLogin || '').toLowerCase();
  const trustedOpener =
    opener === maintainer || opener === GITHUB_ACTIONS_LOGIN || isCopilotLogin(opener);

  if (!trustedOpener) {
    return { eligible: false, reason: `opener @${opener || 'unknown'} is not trusted` };
  }

  const labels = (issue.labels || []).map((label) => String(label.name || '').toLowerCase());
  if (labels.includes('automation') && opener !== GITHUB_ACTIONS_LOGIN) {
    return {
      eligible: false,
      reason: `issue #${issue.number} has automation label and was not opened by GitHub Actions`,
    };
  }

  return { eligible: true, reason: 'trusted issue opener' };
}

export async function getCopilotIssueAssignmentContext({
  graphql,
  token,
  owner,
  repo,
  issueNumber,
}) {
  const actors = await graphql(
    token,
    `
      query ($owner: String!, $repo: String!, $issueNumber: Int!) {
        repository(owner: $owner, name: $repo) {
          suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
            nodes {
              login
              __typename
              ... on Bot {
                id
              }
              ... on User {
                id
              }
            }
          }
          issue(number: $issueNumber) {
            id
            state
            assignees(first: 50) {
              nodes {
                id
                login
              }
            }
          }
        }
      }
    `,
    { owner, repo, issueNumber },
  );

  const copilot = (actors.repository?.suggestedActors?.nodes || []).find((actor) => {
    return isCopilotLogin(actor.login);
  });

  if (!copilot?.id) {
    throw new Error('CRAWLER_CI_PAT cannot discover an assignable Copilot actor');
  }

  const issueData = actors.repository?.issue;
  if (!issueData?.id) {
    throw new Error(`Issue #${issueNumber} could not be loaded for assignment`);
  }

  return {
    copilot,
    issueId: issueData.id,
    issueState: issueData.state,
    assignees: issueData.assignees?.nodes || [],
  };
}

export function buildIssueActorIds({ assignees, copilotActorId, includeCopilot }) {
  const actorIds = (assignees || [])
    .filter((assignee) => includeCopilot || !isCopilotLogin(assignee?.login))
    .map((assignee) => assignee.id)
    .filter(Boolean);
  if (includeCopilot) {
    actorIds.push(copilotActorId);
  }
  return [...new Set(actorIds)];
}

export async function replaceIssueAssignees({ graphql, token, assignableId, actorIds }) {
  const assignment = await graphql(
    token,
    `
      mutation ($assignableId: ID!, $actorIds: [ID!]!) {
        replaceActorsForAssignable(input: { assignableId: $assignableId, actorIds: $actorIds }) {
          assignable {
            ... on Issue {
              assignees(first: 20) {
                nodes {
                  login
                }
              }
            }
          }
        }
      }
    `,
    { assignableId, actorIds },
  );
  return (
    assignment.replaceActorsForAssignable?.assignable?.assignees?.nodes?.map((assignee) =>
      String(assignee.login || '').toLowerCase(),
    ) || []
  );
}

function isTrustedMarkerComment(comment) {
  return (
    String(comment.body || '').includes(ISSUE_INTAKE_MARKER) &&
    (TRUSTED_ASSOCIATIONS.has(String(comment.author_association || '').toUpperCase()) ||
      TRUSTED_BOT_LOGINS.has(String(comment.user?.login || '').toLowerCase()))
  );
}

async function deleteCommentIfCreated(request, token, owner, repo, commentId) {
  if (typeof commentId === 'number' && commentId > 0) {
    await request(token, `/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      method: 'DELETE',
    });
  }
}

export async function runIssueIntake({ graphql, paginate, request, token, owner, repo, issue }) {
  const assignmentContext = await getCopilotIssueAssignmentContext({
    graphql,
    token,
    owner,
    repo,
    issueNumber: issue.number,
  });
  const actorIds = buildIssueActorIds({
    assignees: assignmentContext.assignees,
    copilotActorId: assignmentContext.copilot.id,
    includeCopilot: true,
  });

  // Post the kickoff comment BEFORE assigning Copilot so the instructions are present
  // when the agent session starts. Clean up the new comment if assignment fails.
  const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${issue.number}/comments`);
  const existingKickoff = comments.find(isTrustedMarkerComment);

  let newCommentId = null;
  if (existingKickoff) {
    if (String(existingKickoff.body || '') !== ISSUE_INTAKE_BODY) {
      await request(token, `/repos/${owner}/${repo}/issues/comments/${existingKickoff.id}`, {
        method: 'PATCH',
        body: { body: ISSUE_INTAKE_BODY },
      });
    }
  } else {
    const created = await request(
      token,
      `/repos/${owner}/${repo}/issues/${issue.number}/comments`,
      {
        method: 'POST',
        body: { body: ISSUE_INTAKE_BODY },
      },
    );
    newCommentId = typeof created?.data?.id === 'number' ? created.data.id : null;
  }

  let assignment;
  try {
    assignment = await replaceIssueAssignees({
      graphql,
      token,
      assignableId: issue.node_id,
      actorIds,
    });
  } catch (err) {
    await deleteCommentIfCreated(request, token, owner, repo, newCommentId);
    throw err;
  }

  const assignedLogins = assignment;
  if (!assignedLogins.some(isCopilotLogin)) {
    await deleteCommentIfCreated(request, token, owner, repo, newCommentId);
    throw new Error(`Copilot assignment did not persist on issue #${issue.number}`);
  }

  return {
    assignee: assignmentContext.copilot.login,
    comment: existingKickoff ? 'existing' : 'posted',
  };
}
