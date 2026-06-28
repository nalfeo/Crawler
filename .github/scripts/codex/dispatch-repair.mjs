import { getEnv, githubRequest } from './utils.mjs';

const repository = getEnv('GITHUB_REPOSITORY', '');
const [owner, repo] = repository.split('/');
const workflowFile = getEnv('WORKFLOW_FILE', 'codex-repair.yml');
const ref = getEnv('DISPATCH_REF', 'main');
const prNumber = getEnv('PR_NUMBER', '');
const trigger = getEnv('REPAIR_TRIGGER', 'unknown');
const mode = getEnv('REPAIR_MODE', 'auto');
const command = getEnv('REPAIR_COMMAND', '');
const explicit = getEnv('IS_EXPLICIT_COMMAND', 'false');

if (!owner || !repo || !prNumber) {
  throw new Error('Missing owner/repo/pr_number for workflow dispatch');
}

await githubRequest(`/repos/${owner}/${repo}/actions/workflows/${workflowFile}/dispatches`, {
  method: 'POST',
  body: {
    ref,
    inputs: {
      pr_number: String(prNumber),
      trigger,
      mode,
      command,
      explicit,
    },
  },
});

process.stdout.write(`Dispatched ${workflowFile} for PR #${prNumber}\n`);
