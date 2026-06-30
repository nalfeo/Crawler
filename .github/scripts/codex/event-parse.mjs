import { appendFileSync } from 'node:fs';
import {
  evaluateRepairComplexity,
  getEnv,
  getRepairBudgets,
  githubPaginate,
  githubRequest,
  parseStatusStateFromBody,
  readJsonFile,
} from './utils.mjs';

const eventName = getEnv('GITHUB_EVENT_NAME', '');
const eventPath = getEnv('GITHUB_EVENT_PATH', '');
const repository = getEnv('GITHUB_REPOSITORY', '');
const outputPath = getEnv('GITHUB_OUTPUT', '');
const [owner, repo] = repository.split('/');
const maxAutoAttempts = Number.parseInt(getEnv('CODEX_MAX_AUTO_ATTEMPTS', '5'), 10);
const maxAutoFailureStreak = Number.parseInt(getEnv('CODEX_MAX_AUTO_FAILURE_STREAK', '2'), 10);

if (!eventPath || !owner || !repo || !outputPath) {
  throw new Error('Missing required GitHub Actions environment context');
}

const payload = readJsonFile(eventPath);

function setOutput(name, value) {
  appendFileSync(outputPath, `${name}=${String(value ?? '')}\n`);
}

function normalizeCommand(body) {
  const text = String(body || '').trim();
  if (!text.startsWith('/codex')) {
    return { recognized: false, command: '' };
  }

  if (/^\/codex\s+fix\s*$/i.test(text)) {
    return { recognized: true, command: '/codex fix', mode: 'full' };
  }
  if (/^\/codex\s+fix\s+ci\s*$/i.test(text)) {
    return { recognized: true, command: '/codex fix ci', mode: 'ci' };
  }
  if (/^\/codex\s+address\s+comments\s*$/i.test(text)) {
    return { recognized: true, command: '/codex address comments', mode: 'comments' };
  }
  if (/^\/codex\s+resolve\s+conflicts\s*$/i.test(text)) {
    return { recognized: true, command: '/codex resolve conflicts', mode: 'conflicts' };
  }

  return { recognized: false, command: text };
}

async function fetchPr(prNumber) {
  return githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`);
}

async function fetchHeadCommitMessage(sha) {
  const commit = await githubRequest(`/repos/${owner}/${repo}/commits/${sha}`);
  return String(commit?.commit?.message || '').trim();
}

async function fetchCodexStatusState(prNumber) {
  const comments = await githubPaginate(
    `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
  );
  const codexStatus = comments.find(
    (comment) =>
      (comment.user?.login || '').toLowerCase() === 'github-actions[bot]' &&
      String(comment.body || '').includes('<!-- codex-repair-status -->'),
  );
  if (!codexStatus) {
    return null;
  }

  return parseStatusStateFromBody(codexStatus.body);
}

function shouldStopAuto(state) {
  if (!state) {
    return false;
  }

  const autoAttempts = Number(state.autoAttempts || 0);
  const autoFailureStreak = Number(state.autoFailureStreak || 0);

  return autoAttempts >= maxAutoAttempts || autoFailureStreak >= maxAutoFailureStreak;
}

function parseDispatchInputs() {
  const inputs = payload.inputs || {};
  const prNumber = Number.parseInt(String(inputs.pr_number || ''), 10);
  if (!Number.isFinite(prNumber)) {
    return null;
  }
  return {
    pr_number: prNumber,
    trigger: String(inputs.trigger || 'workflow_dispatch'),
    command: String(inputs.command || ''),
    mode: String(inputs.mode || 'auto'),
    explicit: String(inputs.explicit || 'false').toLowerCase() === 'true',
  };
}

const actorLogin = (payload.sender?.login || '').toLowerCase();
if (actorLogin === 'github-actions[bot]' && eventName !== 'workflow_dispatch') {
  setOutput('should_run', 'false');
  setOutput('skip_reason', 'event from github-actions[bot]');
  process.exit(0);
}

let pr;
let trigger = eventName;
let command = '';
let mode = 'auto';
let explicit = false;
let dispatchRequired = false;

if (eventName === 'workflow_dispatch') {
  const inputs = parseDispatchInputs();
  if (!inputs) {
    setOutput('should_run', 'false');
    setOutput('skip_reason', 'workflow_dispatch inputs.pr_number missing');
    process.exit(0);
  }
  pr = await fetchPr(inputs.pr_number);
  trigger = inputs.trigger;
  command = inputs.command;
  mode = inputs.mode;
  explicit = inputs.explicit;
} else if (eventName === 'issue_comment') {
  if (!payload.issue?.pull_request?.url) {
    setOutput('should_run', 'false');
    setOutput('skip_reason', 'issue_comment is not on a pull request');
    process.exit(0);
  }

  const parsed = normalizeCommand(payload.comment?.body);
  if (!parsed.recognized) {
    setOutput('should_run', 'false');
    setOutput('skip_reason', 'comment is not a supported /codex command');
    process.exit(0);
  }

  command = parsed.command;
  mode = parsed.mode;
  explicit = true;
  trigger = 'issue_comment_command';
  dispatchRequired = true;
  pr = await fetchPr(payload.issue.number);
} else if (eventName === 'pull_request') {
  pr = payload.pull_request;
  trigger = `pull_request_${payload.action || 'updated'}`;
} else if (eventName === 'pull_request_review') {
  pr = payload.pull_request;
  mode = 'comments';
  trigger = `pull_request_review_${payload.action || 'updated'}`;
  dispatchRequired = true;
} else if (eventName === 'pull_request_review_comment') {
  pr = payload.pull_request;
  mode = 'comments';
  trigger = `pull_request_review_comment_${payload.action || 'updated'}`;
  dispatchRequired = true;
} else if (eventName === 'workflow_run') {
  const workflowRun = payload.workflow_run;
  if (!workflowRun || workflowRun.conclusion !== 'failure') {
    setOutput('should_run', 'false');
    setOutput('skip_reason', 'workflow_run is not failed');
    process.exit(0);
  }
  const prRef = workflowRun.pull_requests?.[0];
  if (!prRef?.number) {
    setOutput('should_run', 'false');
    setOutput('skip_reason', 'failed workflow_run is not associated with a pull request');
    process.exit(0);
  }

  pr = await fetchPr(prRef.number);
  mode = 'ci';
  trigger = `workflow_run_failed:${workflowRun.name || 'unknown'}`;
  dispatchRequired = true;
} else {
  setOutput('should_run', 'false');
  setOutput('skip_reason', `unsupported event: ${eventName}`);
  process.exit(0);
}

if (!pr?.number) {
  setOutput('should_run', 'false');
  setOutput('skip_reason', 'unable to resolve pull request context');
  process.exit(0);
}

const headRepoFullName = pr.head?.repo?.full_name || '';
if (headRepoFullName.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
  setOutput('should_run', 'false');
  setOutput('skip_reason', 'pull request is from a fork; write automation disabled');
  process.exit(0);
}

if (pr.draft) {
  setOutput('should_run', 'false');
  setOutput('skip_reason', 'pull request is draft');
  process.exit(0);
}

const headSha = pr.head?.sha;
if (!headSha) {
  setOutput('should_run', 'false');
  setOutput('skip_reason', 'pull request head SHA not found');
  process.exit(0);
}

const commitMessage = await fetchHeadCommitMessage(headSha);
if (commitMessage.toLowerCase().startsWith('codex:')) {
  setOutput('should_run', 'false');
  setOutput('skip_reason', 'head commit already authored by codex automation');
  process.exit(0);
}

const state = await fetchCodexStatusState(pr.number);
if (!explicit && shouldStopAuto(state)) {
  setOutput('should_run', 'false');
  setOutput('skip_reason', 'auto-repair paused due to attempt/failure limits');
  process.exit(0);
}

if (!explicit) {
  const budgets = getRepairBudgets();
  if (budgets.enabled) {
    let failingChecks = 0;
    try {
      const checkRuns = await githubPaginate(
        `/repos/${owner}/${repo}/commits/${headSha}/check-runs?per_page=100`,
        { extract: (page) => page.check_runs },
      );
      failingChecks = checkRuns.filter((check) => check.conclusion === 'failure').length;
    } catch {
      // best-effort: leave failingChecks at its default of 0
    }

    const complexity = evaluateRepairComplexity(
      {
        changedFiles: pr.changed_files,
        additions: pr.additions,
        deletions: pr.deletions,
        failingChecks,
      },
      budgets,
    );

    if (complexity.tooComplex) {
      setOutput('should_run', 'false');
      setOutput('bounced', 'true');
      setOutput('bounce_reason', complexity.reasons.join('; '));
      setOutput('bounce_files', complexity.metrics.changedFiles);
      setOutput('bounce_lines', complexity.metrics.diffLines);
      setOutput('bounce_failing_checks', complexity.metrics.failingChecks);
      setOutput('bounce_budget_files', budgets.maxChangedFiles);
      setOutput('bounce_budget_lines', budgets.maxDiffLines);
      setOutput('bounce_budget_failing', budgets.maxFailingChecks);
      setOutput('skip_reason', `bounced to human: ${complexity.reasons.join('; ')}`);
      setOutput('pr_number', pr.number);
      setOutput('pr_branch', pr.head.ref || '');
      process.exit(0);
    }
  }
}

setOutput('should_run', 'true');
setOutput('skip_reason', '');
setOutput('bounced', 'false');
setOutput('dispatch_required', dispatchRequired ? 'true' : 'false');
setOutput('pr_number', pr.number);
setOutput('pr_branch', pr.head.ref || '');
setOutput('pr_sha', headSha);
setOutput('trigger', trigger);
setOutput('command', command);
setOutput('mode', mode);
setOutput('is_explicit_command', explicit ? 'true' : 'false');
setOutput('base_branch', pr.base?.ref || '');
