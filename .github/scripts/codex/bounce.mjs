import { evaluateRepairComplexity, getEnv, getRepairBudgets, githubRequest } from './utils.mjs';

const repository = getEnv('GITHUB_REPOSITORY', '');
const [owner, repo] = repository.split('/');
const prNumber = Number.parseInt(getEnv('PR_NUMBER', ''), 10);
const bounceReason = getEnv('BOUNCE_REASON', '');
const label = getEnv('CODEX_BOUNCE_LABEL', 'auto-heal-bounced');
const assignToken = getEnv('CODEX_ASSIGN_TOKEN', '');
const runUrl = `${getEnv('GITHUB_SERVER_URL', 'https://github.com')}/${repository}/actions/runs/${getEnv('GITHUB_RUN_ID', '')}`;
const COMMENT_MARKER = '<!-- codex-bounce -->';

if (!owner || !repo || !Number.isFinite(prNumber)) {
  throw new Error('Missing repository/pr context for bounce');
}

async function ensureLabelExists() {
  try {
    await githubRequest(`/repos/${owner}/${repo}/labels/${encodeURIComponent(label)}`);
    return;
  } catch {
    // Label does not exist yet; create it below.
  }
  try {
    await githubRequest(`/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: {
        name: label,
        color: 'B60205',
        description: 'Auto-healer bounced this PR to a human (too large/complex for cost cap).',
      },
    });
  } catch {
    // Best-effort: another run may have created it concurrently.
  }
}

async function addLabel() {
  try {
    await ensureLabelExists();
    await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
      method: 'POST',
      body: { labels: [label] },
    });
    return true;
  } catch {
    return false;
  }
}

async function assignCopilot() {
  const copilotLogin = 'copilot-swe-agent';

  // Use the simple REST assignees endpoint with the (App or PAT) assign token —
  // the same approach proven in coverage-gap-copilot.yml. The default Actions
  // GITHUB_TOKEN is a bot identity GitHub ignores for the Copilot trigger, so a
  // user-acting token (GitHub App installation token, or a PAT) is required.
  try {
    await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/assignees`, {
      method: 'POST',
      body: { assignees: [copilotLogin] },
      token: assignToken || undefined,
    });
  } catch (error) {
    return { assigned: false, reason: `assignment failed: ${error.message}` };
  }

  // addAssignees silently drops logins that aren't assignable for the token, so
  // confirm Copilot actually stuck before reporting success.
  try {
    const issue = await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}`, {
      token: assignToken || undefined,
    });
    const assigned = (issue.assignees || []).some(
      (actor) => (actor.login || '').toLowerCase() === copilotLogin,
    );
    if (assigned) {
      return { assigned: true, reason: '' };
    }
    return {
      assigned: false,
      reason: assignToken
        ? 'Copilot was not accepted as an assignee (the assign token may lack Copilot rights)'
        : 'no assign token available — the default Actions token cannot assign the Copilot coding agent',
    };
  } catch (error) {
    return { assigned: false, reason: `assignment check failed: ${error.message}` };
  }
}

async function upsertComment(body) {
  const comments = await githubRequest(
    `/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`,
  );
  const existing = comments.find(
    (comment) =>
      (comment.user?.login || '').toLowerCase() === 'github-actions[bot]' &&
      String(comment.body || '').includes(COMMENT_MARKER),
  );

  if (existing) {
    await githubRequest(`/repos/${owner}/${repo}/issues/comments/${existing.id}`, {
      method: 'PATCH',
      body: { body },
    });
  } else {
    await githubRequest(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: { body },
    });
  }
}

const pr = await githubRequest(`/repos/${owner}/${repo}/pulls/${prNumber}`);

let failingChecks = 0;
try {
  const checkRuns = await githubRequest(
    `/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
  );
  failingChecks = (checkRuns?.check_runs || []).filter(
    (check) => check.conclusion === 'failure',
  ).length;
} catch {
  // best-effort: leave failingChecks at its default of 0
}

const budgets = getRepairBudgets();
const complexity = evaluateRepairComplexity(
  {
    changedFiles: pr.changed_files,
    additions: pr.additions,
    deletions: pr.deletions,
    failingChecks,
  },
  budgets,
);

const reasons =
  complexity.reasons.length > 0 ? complexity.reasons : bounceReason ? [bounceReason] : [];

const labelAdded = await addLabel();
const assignResult = await assignCopilot();

const nextSteps = assignResult.assigned
  ? '- ✅ Assigned **@Copilot** (coding agent) to take over this PR.'
  : `- ⚠️ Could not auto-assign Copilot (${assignResult.reason}). Please assign the Copilot coding agent manually.`;

const body = [
  COMMENT_MARKER,
  '## 🪃 Auto-heal bounced to a human',
  '',
  'This PR is **too large/complex for the cost-capped auto-healer**, so the repair model was **not** run (zero tokens spent). Handing off to GitHub Copilot.',
  '',
  '**Why it was bounced:**',
  ...(reasons.length > 0
    ? reasons.map((reason) => `- ${reason}`)
    : ['- Exceeded auto-heal complexity budget.']),
  '',
  '**Measured vs budget (auto runs only):**',
  `- Changed files: ${complexity.metrics.changedFiles} (budget ${budgets.maxChangedFiles})`,
  `- Changed lines: ${complexity.metrics.diffLines} (budget ${budgets.maxDiffLines})`,
  `- Failing checks: ${complexity.metrics.failingChecks} (budget ${budgets.maxFailingChecks})`,
  '',
  '**Handoff:**',
  nextSteps,
  `- ${labelAdded ? `Labeled \`${label}\`.` : `Could not apply \`${label}\` label.`}`,
  '- To force the auto-healer anyway, re-dispatch the runner with `explicit=true`, or comment `/codex fix`.',
  '- Tune budgets via the `CODEX_BOUNCE_MAX_CHANGED_FILES`, `CODEX_BOUNCE_MAX_DIFF_LINES`, `CODEX_BOUNCE_MAX_FAILING_CHECKS` repo variables (or set `CODEX_BOUNCE_ENABLED=false` to disable).',
  '',
  `Run: ${runUrl}`,
  '',
].join('\n');

await upsertComment(body);

process.stdout.write(
  `bounced pr=#${prNumber} files=${complexity.metrics.changedFiles} lines=${complexity.metrics.diffLines} failing=${complexity.metrics.failingChecks} copilot_assigned=${assignResult.assigned} label_added=${labelAdded}\n`,
);
