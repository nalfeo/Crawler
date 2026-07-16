import { runIssueIntake } from '../ci-recovery/issue-intake-lib.mjs';
import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';

export const ISSUE_TITLE = 'balance: telemetry-driven nightly improvement sweep';

export const APPROVAL_LABEL_METADATA = Object.freeze({
  name: HUMAN_APPROVAL_LABEL,
  color: 'B60205',
  description: 'Requires explicit repository-owner approval before merge automation',
});

export const ISSUE_LABELS = Object.freeze([
  'bug',
  'automation',
  'telemetry',
  'simulation',
  'ai',
  HUMAN_APPROVAL_LABEL,
]);

export const ISSUE_BODY = [
  '## Objective',
  'Examine eligible current telemetry, identify and rank up to 3 evidence-backed game-balance improvements, evaluate each independently with canonical sweeps, and ship only treatments supported by comparable aggregate evidence. Zero eligible ideas is a valid outcome and must produce no implementation PR.',
  '',
  '## Baseline eligibility — hard gate',
  '- Use only latest successful `weapon-sweep.yml` run on current `main` containing all six FINAL aggregate artifacts named `weapon-sweep-<weapon>`, 100 seeds per weapon.',
  '- Record run ID, UTC timestamp, exact head SHA, seed range/count, max frames/time budget, weapon list, and all behavior/config flags.',
  '- Never use individual/selected shards, partial artifacts, local smoke runs, hand-picked seeds, or mixed runs as baseline.',
  '- Analyze shipped/default runtime config. Default-off/experimental flags such as `weapon_personas=true` cannot justify shipped-game balance changes; an experiment-scoped run may only support explicitly experiment-scoped issue.',
  '- Verify baseline SHA still represents current main. Gameplay-affecting commits after it require fresh canonical GitHub Actions sweep; inability to dispatch/complete/download required artifacts => stop without implementation/PR.',
  '- No new eligible aggregate run since prior completed nightly analysis => stop without duplicate work.',
  '- State whether releases/tags and real-player telemetry exist. Never call headless simulations release/player telemetry or invent historical lookback.',
  '',
  '## Candidate eligibility — hard gate',
  'Propose UP TO 3 ranked ideas including zero; never fill a quota. Each at exact baseline SHA must prove exact aggregate fields/values measured symptom; causal telemetry attribution (timing/correlation/source plausibility are hypotheses); real Floor-1 headless/simulation production runtime reachability through enabling config; enabled-in-baseline feature/entity/mode/spawn table/flag; observable canonical metric expected to move. Registry entries, exports, labs/tests, empty config tables, disabled flags, dormant definitions, unreachable branches are ineligible. Never claim enemy/room/encounter/attack/damage source unless artifacts record it. Unknown/unproven rejects before ranking; missing attribution means telemetry/investigation, not tuning. Separate facts, hypotheses, source inspection.',
  '',
  '## Evaluation contract — hard gate',
  '- Evaluate each candidate independently, one code/config change at a time, identical seeds/weapons/flags/limits.',
  '- >10 runs via GitHub Actions dispatch; local/session is smoke only, cannot accept/reject.',
  '- Never bundle unmeasured ideas, infer marginal contribution from combined treatment, or substitute 10-seed indicative results.',
  '- Max 3 attempts per candidate; never tune around named seeds.',
  '- If independent canonical sweeps cannot run, no implementation/PR.',
  '- Accept/reject one before next; final accepted combination gets fresh canonical aggregate sweep.',
  '',
  '## Durable ledger',
  'Max 9 attempt rows. Each: rank/name, measured symptom, causal evidence, production runtime path, enabling config/flag, hypothesis, exact change, baseline/post metrics, sweep run/artifact URLs, verdict, accepted/rejected/blocked rationale. Rejected/blocked remain.',
  '',
  '## Mandatory human approval gate',
  'Gameplay PR contains `Closes #<this issue number>`, labels `human-approval-required` and `merge-train-blocked`, ready not draft; no merge-train, auto-merge, or merge; only exact standalone trimmed comment `APPROVED FOR CHECK-IN` by owner `nalfeo` unlocks; green CI/reviews/quoted text/substrings/others do not count; bad final treatment means close/abandon.',
  '',
  '## Acceptance evidence',
  'Up to 3 ranked eligible ideas (zero allowed/no PR), <=3 attempts each, complete ledger, aggregate comparable baseline/post artifacts, final judge, explicit approval status. Preserve normal verification/review-harness/ledger/handoff/determinism.',
  '',
  '@copilot Please execute this issue end-to-end, but obey every hard evidence gate and the mandatory human approval gate above.',
].join('\n');

function readConfiguration(env) {
  const repository = String(env.GITHUB_REPOSITORY || '');
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    throw new Error('GITHUB_REPOSITORY must be in owner/repo form');
  }

  const githubToken = String(env.GITHUB_TOKEN || '');
  const intakeToken = String(env.CRAWLER_CI_PAT || '');
  if (!githubToken || !intakeToken) {
    throw new Error('Missing GITHUB_TOKEN or CRAWLER_CI_PAT');
  }

  return {
    owner: parts[0],
    repo: parts[1],
    githubToken,
    intakeToken,
  };
}

function exactOpenIssue(issues) {
  return issues.find((issue) => !issue.pull_request && issue.title === ISSUE_TITLE);
}

async function closeIssue(request, token, owner, repo, number) {
  await request(token, `/repos/${owner}/${repo}/issues/${number}`, {
    method: 'PATCH',
    body: { state: 'closed', state_reason: 'not_planned' },
  });
}

export async function fileNightlyBalanceIssue({
  env = process.env,
  request,
  paginate,
  graphql,
  runIssueIntakeFn = runIssueIntake,
  reportError = (message) => process.stderr.write(`${message}\n`),
}) {
  const { owner, repo, githubToken, intakeToken } = readConfiguration(env);
  const issuesPath = `/repos/${owner}/${repo}/issues?state=open`;
  const openIssues = await paginate(githubToken, issuesPath);
  const existing = exactOpenIssue(openIssues);
  if (existing) {
    return { status: 'existing', issueNumber: existing.number };
  }

  const labels = await paginate(githubToken, `/repos/${owner}/${repo}/labels`);
  if (!labels.some((label) => label.name === HUMAN_APPROVAL_LABEL)) {
    try {
      await request(githubToken, `/repos/${owner}/${repo}/labels`, {
        method: 'POST',
        body: APPROVAL_LABEL_METADATA,
      });
    } catch (error) {
      if (error.status !== 422) {
        throw error;
      }
    }
  }

  const issue = (
    await request(githubToken, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: {
        title: ISSUE_TITLE,
        body: ISSUE_BODY,
        labels: ISSUE_LABELS,
      },
    })
  ).data;

  if (!Number.isInteger(issue?.number) || !issue?.node_id) {
    throw new Error('GitHub did not return a valid created issue');
  }

  const postCreateIssues = await paginate(githubToken, issuesPath);
  const canonicalIssue = postCreateIssues
    .filter((candidate) => !candidate.pull_request && candidate.title === ISSUE_TITLE)
    .sort((left, right) => left.number - right.number)[0];
  if (canonicalIssue && canonicalIssue.number !== issue.number) {
    await closeIssue(request, githubToken, owner, repo, issue.number);
    return { status: 'race-duplicate-closed', issueNumber: canonicalIssue.number };
  }

  try {
    const intake = await runIssueIntakeFn({
      graphql,
      paginate,
      request,
      token: intakeToken,
      owner,
      repo,
      issue,
    });
    return { status: 'created', issueNumber: issue.number, intake };
  } catch (intakeError) {
    try {
      await closeIssue(request, githubToken, owner, repo, issue.number);
    } catch (cleanupError) {
      if (intakeError && typeof intakeError === 'object') {
        intakeError.cleanupError = cleanupError;
      }
      reportError(
        `Failed to close issue #${issue.number} after intake failure: ${cleanupError.message}`,
      );
    }
    throw intakeError;
  }
}
