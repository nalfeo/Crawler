import { TRUSTED_ASSOCIATIONS, TRUSTED_BOT_LOGINS } from './state.mjs';

export const ISSUE_INTAKE_MARKER = '<!-- crawler-issue-intake:v1 -->';

export const ISSUE_INTAKE_BODY = [
  ISSUE_INTAKE_MARKER,
  '@copilot',
  '',
  "Please handle this issue under the repository's normal development rules with no shortcuts:",
  '- Follow `AGENTS.md` and `.github/copilot-instructions.md` exactly.',
  '- Keep all required verification/review-harness/ledger steps for code-touching work.',
  '- Do not weaken gates, policy checks, or explicit human requirements to get green.',
].join('\n');

function isTrustedMarkerComment(comment) {
  return (
    String(comment.body || '').includes(ISSUE_INTAKE_MARKER) &&
    (TRUSTED_ASSOCIATIONS.has(String(comment.author_association || '').toUpperCase()) ||
      TRUSTED_BOT_LOGINS.has(String(comment.user?.login || '').toLowerCase()))
  );
}

export async function runIssueIntake({ graphql, paginate, request, token, owner, repo, issue }) {
  const actors = await graphql(
    token,
    `
      query ($owner: String!, $repo: String!) {
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
        }
      }
    `,
    { owner, repo },
  );

  const copilot = (actors.repository?.suggestedActors?.nodes || []).find((actor) => {
    const login = String(actor.login || '').toLowerCase();
    return login === 'copilot-swe-agent' || login === 'copilot';
  });

  if (!copilot?.id) {
    throw new Error('CRAWLER_CI_PAT cannot discover an assignable Copilot actor');
  }

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
    { assignableId: issue.node_id, actorIds: [copilot.id] },
  );

  const assignedLogins =
    assignment.replaceActorsForAssignable?.assignable?.assignees?.nodes?.map((assignee) =>
      String(assignee.login || '').toLowerCase(),
    ) || [];
  if (!assignedLogins.includes(String(copilot.login).toLowerCase())) {
    throw new Error(`Copilot assignment did not persist on issue #${issue.number}`);
  }

  const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${issue.number}/comments`);
  const existingKickoff = comments.find(isTrustedMarkerComment);

  if (existingKickoff) {
    if (String(existingKickoff.body || '') !== ISSUE_INTAKE_BODY) {
      await request(token, `/repos/${owner}/${repo}/issues/comments/${existingKickoff.id}`, {
        method: 'PATCH',
        body: { body: ISSUE_INTAKE_BODY },
      });
    }
  } else {
    await request(token, `/repos/${owner}/${repo}/issues/${issue.number}/comments`, {
      method: 'POST',
      body: { body: ISSUE_INTAKE_BODY },
    });
  }

  return {
    assignee: copilot.login,
    comment: existingKickoff ? 'existing' : 'posted',
  };
}
