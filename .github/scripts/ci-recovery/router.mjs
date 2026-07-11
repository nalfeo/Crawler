import { paginate, request } from './github.mjs';

const token = process.env.GITHUB_TOKEN;
const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const eventName = process.env.GITHUB_EVENT_NAME || '';
const eventPath = process.env.GITHUB_EVENT_PATH;
const trigger = process.env.RECOVERY_TRIGGER || eventName;

if (!token || !owner || !repo || !eventPath) {
  throw new Error('Missing GITHUB_TOKEN, GITHUB_REPOSITORY, or GITHUB_EVENT_PATH');
}

const payload = JSON.parse(await (await import('node:fs/promises')).readFile(eventPath, 'utf8'));
const numbers = new Set();

function add(value) {
  const number = Number.parseInt(String(value ?? ''), 10);
  if (Number.isInteger(number) && number > 0) {
    numbers.add(number);
  }
}

add(payload.pull_request?.number);
add(payload.issue?.pull_request ? payload.issue.number : null);
for (const pullRequest of payload.workflow_run?.pull_requests || []) {
  add(pullRequest.number);
}

if (eventName === 'schedule' || eventName === 'workflow_dispatch') {
  const pulls = await paginate(
    token,
    `/repos/${owner}/${repo}/pulls?state=open&base=main&sort=updated&direction=desc`,
  );
  for (const pullRequest of pulls) {
    if (
      !pullRequest.draft &&
      pullRequest.head?.repo?.full_name?.toLowerCase() === repository.toLowerCase()
    ) {
      add(pullRequest.number);
    }
  }
}

for (const prNumber of [...numbers].sort((left, right) => left - right)) {
  await request(token, `/repos/${owner}/${repo}/actions/workflows/ci-recovery.yml/dispatches`, {
    method: 'POST',
    body: {
      ref: payload.repository?.default_branch || 'main',
      inputs: {
        operation: 'reconcile',
        pr_number: String(prNumber),
        trigger,
        lease_id: '',
      },
    },
  });
  process.stdout.write(`dispatched pr=#${prNumber} trigger=${trigger}\n`);
}

if (numbers.size === 0) {
  process.stdout.write(`no eligible PR found for ${eventName}\n`);
}
