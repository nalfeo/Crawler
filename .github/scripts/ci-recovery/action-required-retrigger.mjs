import { execFileSync } from 'node:child_process';

const REQUIRED_WORKFLOW_PATHS = new Set([
  '.github/workflows/ci.yml',
  '.github/workflows/security-review.yml',
]);

const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const runId = process.env.PARKED_RUN_ID || '';
const defaultBranch = process.env.DEFAULT_BRANCH || 'main';
const githubToken = process.env.GITHUB_TOKEN || '';
const retriggerToken = process.env.CRAWLER_CI_PAT || '';
const dryRun = process.env.ACTION_REQUIRED_RETRIGGER_DRY_RUN === 'true';

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

export function classifyParkedRun({
  run,
  pull,
  latestRun,
  repository: expectedRepository = repository,
}) {
  if (run?.conclusion !== 'action_required') return 'run-not-action-required';
  if (run?.event !== 'pull_request') return `event=${run?.event}`;
  if (!REQUIRED_WORKFLOW_PATHS.has(normalize(run?.path))) return 'workflow-not-required';
  if (!pull || pull.state !== 'open') return 'pr-not-open';
  if (normalize(pull.head?.repo?.full_name) !== normalize(expectedRepository)) return 'fork';
  if (normalize(pull.head?.sha) !== normalize(run.head_sha)) return 'head-moved';
  if (!latestRun) return 'latest-run-missing';
  if (Number(latestRun.id) !== Number(run.id)) return 'stale-run';
  return null;
}

async function request(token, path) {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'crawler-action-required-retrigger',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub GET ${path} failed (${response.status}): ${await response.text()}`);
  }
  return response.json();
}

function git(args, options = {}) {
  execFileSync('git', args, { stdio: 'inherit', ...options });
}

function pushEmptyCommit(pull) {
  const branch = pull.head.ref;
  const localBranch = `retrigger-${pull.number}`;
  const remote = `https://x-access-token:${retriggerToken}@github.com/${owner}/${repo}.git`;
  git(['config', 'user.name', 'crawler-ci-recovery']);
  git(['config', 'user.email', 'crawler-ci-recovery@users.noreply.github.com']);
  git(['remote', 'set-url', 'origin', remote], { stdio: 'ignore' });
  git(['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
  git(['checkout', '-B', localBranch, `refs/remotes/origin/${branch}`]);
  git([
    'commit',
    '--allow-empty',
    '-m',
    `chore(ci): retrigger parked checks for PR #${pull.number}`,
  ]);
  git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
}

async function main() {
  if (!owner || !repo || !runId || !githubToken || !retriggerToken) {
    throw new Error('Missing repository, parked run id, GITHUB_TOKEN, or CRAWLER_CI_PAT');
  }

  const run = await request(githubToken, `/repos/${owner}/${repo}/actions/runs/${runId}`);
  const linkedPr = run.pull_requests?.[0];
  if (!linkedPr?.number) {
    process.stdout.write(`skip run=${runId} reason=no-linked-pr\n`);
    return;
  }
  const pull = await request(githubToken, `/repos/${owner}/${repo}/pulls/${linkedPr.number}`);
  const runs = await request(
    githubToken,
    `/repos/${owner}/${repo}/actions/runs?head_sha=${encodeURIComponent(run.head_sha)}&event=pull_request&per_page=100`,
  );
  const latestRun = (runs.workflow_runs || [])
    .filter((candidate) => normalize(candidate.path) === normalize(run.path))
    .sort((left, right) => Number(right.id) - Number(left.id))[0];

  const rejection = classifyParkedRun({ run, pull, latestRun, repository });
  if (rejection) {
    process.stdout.write(`skip run=${runId} pr=#${linkedPr.number} reason=${rejection}\n`);
    return;
  }
  if (pull.base.ref !== defaultBranch) {
    process.stdout.write(`skip run=${runId} pr=#${pull.number} reason=base=${pull.base.ref}\n`);
    return;
  }
  if (dryRun) {
    process.stdout.write(`dry-run retrigger pr=#${pull.number} branch=${pull.head.ref}\n`);
    return;
  }

  pushEmptyCommit(pull);
  process.stdout.write(`retriggered pr=#${pull.number} run=${runId} branch=${pull.head.ref}\n`);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  await main();
}
