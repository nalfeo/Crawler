import { graphql, paginate, request } from './github.mjs';
import { TRUSTED_ASSOCIATIONS, TRUSTED_BOT_LOGINS } from './state.mjs';

const token = process.env.CRAWLER_CI_PAT || '';
const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const eventPath = process.env.GITHUB_EVENT_PATH;
const issueOwner = String(process.env.ISSUE_OWNER || 'nalfeo').toLowerCase();
const marker = '<!-- crawler-issue-intake:v1 -->';
const copilotMention = '@copilot';

if (!token || !owner || !repo || !eventPath) {
  throw new Error('Missing CRAWLER_CI_PAT, repository, or event payload');
}

const payload = JSON.parse(await (await import('node:fs/promises')).readFile(eventPath, 'utf8'));
const issue = payload.issue;

if (!issue || issue.pull_request) {
  process.stdout.write('skip: event has no eligible issue payload\n');
  process.exit(0);
}

if (String(issue.user?.login || '').toLowerCase() !== issueOwner) {
  process.stdout.write(`skip: opener @${issue.user?.login || 'unknown'} != @${issueOwner}\n`);
  process.exit(0);
}

const actors = await graphql(
  token,
  `
    query ($owner: String!, $repo: String!) {
      repository(owner: $owner, name: $repo) {
        suggestedActors(capabilities: [CAN_BE_ASSIGNED], first: 100) {
          nodes {
            login
            __typename
          }
        }
      }
    }
  `,
  { owner, repo },
);

const copilotLogin = (actors.repository?.suggestedActors?.nodes || []).find((actor) => {
  const login = String(actor.login || '').toLowerCase();
  return login === 'copilot-swe-agent' || login === 'copilot';
})?.login;

if (!copilotLogin) {
  throw new Error('CRAWLER_CI_PAT cannot discover an assignable Copilot actor');
}

function isTrustedMarkerComment(comment) {
  return (
    String(comment.body || '').includes(marker) &&
    (TRUSTED_ASSOCIATIONS.has(String(comment.author_association || '').toUpperCase()) ||
      TRUSTED_BOT_LOGINS.has(String(comment.user?.login || '').toLowerCase()))
  );
}

const comments = await paginate(token, `/repos/${owner}/${repo}/issues/${issue.number}/comments`);
const existingKickoff = comments.find(isTrustedMarkerComment);
const kickoffBody = [
  marker,
  copilotMention,
  '',
  "Please handle this issue under the repository's normal development rules with no shortcuts:",
  '- Follow `AGENTS.md` and `.github/copilot-instructions.md` exactly.',
  '- Keep all required verification/review-harness/ledger steps for code-touching work.',
  '- Do not weaken gates, policy checks, or explicit human requirements to get green.',
].join('\n');

if (existingKickoff) {
  if (String(existingKickoff.body || '') !== kickoffBody) {
    await request(token, `/repos/${owner}/${repo}/issues/comments/${existingKickoff.id}`, {
      method: 'PATCH',
      body: { body: kickoffBody },
    });
  }
} else {
  await request(token, `/repos/${owner}/${repo}/issues/${issue.number}/comments`, {
    method: 'POST',
    body: { body: kickoffBody },
  });
}

await request(token, `/repos/${owner}/${repo}/issues/${issue.number}/assignees`, {
  method: 'POST',
  body: { assignees: [copilotLogin] },
});

const assignedIssue = (
  await request(token, `/repos/${owner}/${repo}/issues/${issue.number}`, {
    method: 'GET',
  })
).data;
const assignedLogins = (assignedIssue.assignees || []).map((assignee) =>
  String(assignee.login || '').toLowerCase(),
);
if (!assignedLogins.includes(String(copilotLogin).toLowerCase())) {
  throw new Error(`Copilot assignment did not persist on issue #${issue.number}`);
}

process.stdout.write(
  `intake-complete issue=#${issue.number} opener=@${issue.user?.login} assignee=@${copilotLogin} comment=${existingKickoff ? 'existing' : 'posted'}\n`,
);
