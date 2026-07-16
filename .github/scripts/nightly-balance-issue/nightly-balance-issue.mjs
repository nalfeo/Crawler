import { runIssueIntake } from '../ci-recovery/issue-intake-lib.mjs';
import { graphql, paginate, request } from '../ci-recovery/github.mjs';
import { HUMAN_APPROVAL_LABEL } from '../merge-train/human-approval.mjs';

export const ISSUE_TITLE = 'balance: telemetry-driven nightly improvement sweep';
export const ISSUE_LABELS = Object.freeze([
  'bug',
  'automation',
  'telemetry',
  'simulation',
  'ai',
  HUMAN_APPROVAL_LABEL,
]);

export const ISSUE_BODY = `## Objective
Examine eligible current telemetry, identify and rank up to 3 evidence-backed game-balance improvements, evaluate each independently with canonical sweeps, and ship only treatments supported by comparable aggregate evidence. Zero eligible ideas is valid and produces no implementation PR.

## Baseline eligibility — hard gate
- Latest successful current-main \`weapon-sweep.yml\` with all six FINAL \`weapon-sweep-<weapon>\` aggregate artifacts and 100 seeds/weapon only.
- Record run ID, UTC timestamp, exact head SHA, seed range/count, max frames/time budget, weapon list, every behavior/config flag.
- Never use individual/selected shards, partial artifacts, local smoke, hand-picked seeds, or mixed runs.
- Shipped/default runtime configuration only for shipped changes. Default-off/experimental flags (e.g. \`weapon_personas=true\`) may only support explicitly experiment-scoped work.
- Prove baseline SHA still represents current main; gameplay commits after it require fresh canonical GitHub Actions sweep. Missing/unavailable artifacts => stop, no implementation/PR.
- No new eligible aggregate run since prior analysis => stop duplicate work.
- State releases/tags and real-player telemetry honestly; never call headless data release/player telemetry or invent lookback.

## Candidate eligibility — hard gate
Propose UP TO 3, including zero; never fill quota. For each candidate at exact baseline SHA require: exact measured aggregate fields/values; telemetry-backed causal attribution; real Floor-1 production reachability traced from headless/simulation entry through enabling config; proof feature/entity/mode/spawn table/flag was enabled in baseline; named observable canonical metric. Registry/export/lab/test presence, empty config, disabled flags, dormant definitions, unreachable code are ineligible. Never claim enemy/room/encounter/attack/damage source unless artifact records it. Unknown/unproven => reject before ranking; missing attribution => telemetry/investigation, not tuning. Separate facts, hypotheses, source inspection.

## Evaluation contract — hard gate
One change at a time; identical seeds/weapons/flags/limits; >10 runs via GitHub workflow dispatch; local smoke never accepts/rejects; never bundle unmeasured ideas or infer marginal contribution from combined treatment; never substitute 10-seed indicative results; max 3 attempts/candidate; no named-seed tuning; inability to run independent canonical sweep => no implementation/PR; accept/reject before next; final accepted combination gets fresh canonical aggregate sweep.

## Durable ledger
Max 9 rows. Per row: rank/name, measured symptom, causal evidence, production path, enabling config/flag, hypothesis, exact change, baseline/post metrics, run/artifact URLs, verdict, accepted/rejected/blocked rationale. Keep rejected/blocked visible.

## Mandatory human approval gate
Gameplay PR contains \`Closes #<this issue number>\`, labels \`human-approval-required\` + \`merge-train-blocked\`, ready not draft, no \`merge-train\`/auto-merge/merge. Only exact standalone trimmed owner \`nalfeo\` comment \`APPROVED FOR CHECK-IN\` unlocks. Green CI/reviews/quoted text/substrings/other authors do not count. Bad final evidence => close/abandon.

## Acceptance evidence
Up to 3 eligible ideas (zero allowed/no PR), <=3 attempts each, complete ledger, comparable aggregate baseline/post artifacts, final judge, explicit approval status, normal verification/review/harness/handoff/determinism.

@copilot Please execute this issue end-to-end, but obey every hard evidence gate and the mandatory human approval gate above.`;

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

export async function runNightlyBalanceIssue({
  githubToken,
  intakeToken,
  repository,
  requestFn = request,
  paginateFn = paginate,
  graphqlFn = graphql,
  intakeFn = runIssueIntake,
}) {
  requireToken(githubToken, 'GITHUB_TOKEN');
  requireToken(intakeToken, 'CRAWLER_CI_PAT');
  const { owner, repo } = parseRepository(repository);

  const openIssues = await paginateFn(githubToken, `/repos/${owner}/${repo}/issues?state=open`);
  const existing = openIssues.find(
    (candidate) => !candidate.pull_request && candidate.title === ISSUE_TITLE,
  );
  if (existing) {
    return { status: 'existing', issue: existing };
  }

  await ensureHumanApprovalLabel({ requestFn, githubToken, owner, repo });
  const created = await requestFn(githubToken, `/repos/${owner}/${repo}/issues`, {
    method: 'POST',
    body: {
      title: ISSUE_TITLE,
      body: ISSUE_BODY,
      labels: ISSUE_LABELS,
    },
  });
  const issue = created.data;
  if (!Number.isInteger(issue?.number) || !issue?.node_id) {
    throw new Error('GitHub issue creation response omitted number or node_id');
  }

  let intake;
  try {
    intake = await intakeFn({
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
        `Issue intake failed for #${issue.number}: ${intakeError.message}; closing the issue also failed: ${rollbackError.message}`,
        { cause: intakeError },
      );
    }
    throw intakeError;
  }

  return { status: 'created', issue, intake };
}
