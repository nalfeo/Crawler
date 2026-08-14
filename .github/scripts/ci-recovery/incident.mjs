import { graphql, paginate, request } from './github.mjs';
import { CI_INCIDENT_MARKER } from './markers.mjs';
import {
  hasTrustedTrainPromotionCheck,
  isTrustedTrainPromotionCheck,
  requiresAdminIntervention,
  shouldSkipRepoIncidentWorkflowRun,
} from './state.mjs';
import { parseEnabledFlag } from '../merge-train/state.mjs';

const token = process.env.CRAWLER_CI_PAT || '';
const repository = process.env.GITHUB_REPOSITORY || '';
const [owner, repo] = repository.split('/');
const eventPath = process.env.GITHUB_EVENT_PATH;
// The same trust gate `ci.yml` uses for merge-train promotion evidence: a
// check named "merge-train" is only real provenance when it was created by
// the trusted repository App and its external_id is a fingerprint-shaped
// SHA-256 hex digest. Without both checks, anyone able to post a check-run
// named "merge-train" (a compromised token, a different app install, a
// spoofed run) could inject arbitrary text into an incident issue body that
// @copilot is asked to act on.
const trustedAppId = Number.parseInt(process.env.MERGE_TRAIN_APP_ID || '', 10);
// Exact-match rollout flag, same semantics as ci.yml/security-review.yml's
// `vars.MERGE_TRAIN_ENABLED == 'true'` shortcut gate. Defaults to false (via
// parseEnabledFlag) when unset, so an unconfigured or rolled-back repository
// never misclassifies a genuine full-CI run as a merge-train fast path.
const mergeTrainEnabled = parseEnabledFlag(process.env.MERGE_TRAIN_ENABLED);

if (!token || !owner || !repo || !eventPath) {
  throw new Error('Missing CRAWLER_CI_PAT, repository, or event payload');
}

const payload = JSON.parse(await (await import('node:fs/promises')).readFile(eventPath, 'utf8'));
const run = payload.workflow_run;
if (!run) {
  throw new Error('Repository incident routing requires a workflow_run event');
}
if (shouldSkipRepoIncidentWorkflowRun(run)) {
  process.stdout.write(
    `skip workflow=${run.name} event=${run.event} pull_requests=${Array.isArray(run.pull_requests) ? run.pull_requests.length : 0}\n`,
  );
  process.exit(0);
}

const label = 'ci-incident';
const adminInterventionLabel = 'admin-intervention-required';
const title = `CI incident: ${run.name}`;
const openIssues = await paginate(
  token,
  `/repos/${owner}/${repo}/issues?state=open&labels=${encodeURIComponent(label)}`,
);
const existing = openIssues.find(
  (issue) => !issue.pull_request && String(issue.title).toLowerCase() === title.toLowerCase(),
);

// Fetched once and reused below both to decide whether a "success" push run
// is real full-CI evidence and to surface merge-train promotion provenance
// in the incident body on failure.
const headCheckRuns = run.head_sha
  ? (
      await request(
        token,
        `/repos/${owner}/${repo}/commits/${encodeURIComponent(run.head_sha)}/check-runs?per_page=100`,
        { headers: { Accept: 'application/vnd.github+json' } },
      )
    ).data.check_runs || []
  : [];

// A push-triggered CI run whose head carries an attested successful
// merge-train check took the docs_only fast path (heavy suite skipped). Its
// own green conclusion is therefore not evidence that a real, already-open
// incident's root cause (an earlier full-CI failure) is fixed — it must not
// auto-close the incident. Genuine push failures still route normally
// below regardless of any promotion attestation.
//
// Require the exact rollout flag too: after a flag-off rollback, a SHA can
// still carry an old trusted `merge-train` check (check-runs persist
// forever). A later genuine full-CI rerun on that same SHA must not be
// misclassified as a fast-path shortcut just because that stale check is
// still present, or a real successful full run could never auto-close the
// incident. `mergeTrainEnabled` uses the same exact-match parsing as the
// `ci.yml`/`security-review.yml` shortcut gates.
const isTrainFastPathSuccess =
  mergeTrainEnabled &&
  run.event === 'push' &&
  run.name === 'CI' &&
  hasTrustedTrainPromotionCheck(headCheckRuns, trustedAppId);

async function deployRunActuallyReleased() {
  if (run.name !== 'Deploy to GitHub Pages') {
    return true;
  }
  if (!run.id) {
    process.stdout.write(
      `skip auto-close workflow=${run.name} reason=missing-run-id (cannot prove deploy job succeeded)\n`,
    );
    return false;
  }
  const jobs =
    (
      await request(
        token,
        `/repos/${owner}/${repo}/actions/runs/${encodeURIComponent(run.id)}/jobs?per_page=100`,
        { headers: { Accept: 'application/vnd.github+json' } },
      )
    ).data.jobs || [];
  const deployJob = jobs.find((job) => job.name === 'deploy');
  const deploymentStepSucceeded = deployJob?.steps?.some(
    (step) =>
      ['Deploy to GitHub Pages', 'Deploy to GitHub Pages (retry)'].includes(step.name) &&
      step.conclusion === 'success',
  );
  if (deployJob?.conclusion === 'success' && deploymentStepSucceeded) {
    return true;
  }
  process.stdout.write(
    `skip auto-close workflow=${run.name} reason=pages-deploy-not-success job-conclusion=${deployJob?.conclusion || 'missing'} deployment-step-succeeded=${deploymentStepSucceeded || false}\n`,
  );
  return false;
}

if (run.conclusion === 'success') {
  if (isTrainFastPathSuccess) {
    process.stdout.write(
      `skip auto-close workflow=${run.name} reason=train-fast-path-success (docs_only shortcut is not full-CI evidence)\n`,
    );
    process.exit(0);
  }
  if (!(await deployRunActuallyReleased())) {
    process.exit(0);
  }
  if (existing) {
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: { state: 'closed', state_reason: 'completed' },
    });
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}/comments`, {
      method: 'POST',
      body: {
        body: `✅ Auto-closed after successful run ${run.html_url}.`,
      },
    });
    process.stdout.write(`closed incident issue=#${existing.number}\n`);
  }
  process.exit(0);
}

if (!['failure', 'timed_out', 'startup_failure', 'action_required'].includes(run.conclusion)) {
  process.stdout.write(`skip workflow=${run.name} conclusion=${run.conclusion}\n`);
  process.exit(0);
}

try {
  await request(token, `/repos/${owner}/${repo}/labels`, {
    method: 'POST',
    body: {
      name: label,
      color: 'b60205',
      description: 'Deduplicated repository-level CI incident',
    },
  });
} catch (error) {
  if (error.status !== 422) {
    throw error;
  }
}

// Identity comes from the immutable workflow path shared with
// action-required-retrigger.mjs, so both recovery paths agree on which runs
// automation can already retrigger without a human.
const needsAdminIntervention = requiresAdminIntervention(run);
if (needsAdminIntervention) {
  try {
    await request(token, `/repos/${owner}/${repo}/labels`, {
      method: 'POST',
      body: {
        name: adminInterventionLabel,
        color: 'b60205',
        description: 'Automation requires a human or repository-admin intervention',
      },
    });
  } catch (error) {
    if (error.status !== 422) throw error;
  }
}

const body = [
  CI_INCIDENT_MARKER,
  `# ${run.name} needs recovery`,
  '',
  `- Conclusion: \`${run.conclusion}\``,
  `- Branch: \`${run.head_branch || 'unknown'}\``,
  `- Head SHA: \`${run.head_sha || 'unknown'}\``,
  `- Run: ${run.html_url}`,
  `- Triggered by: @${run.actor?.login || 'unknown'}`,
  ...(() => {
    // Require the same completed+successful trust gate as
    // `isTrainFastPathSuccess`/`ci.yml`, not just name+App+fingerprint shape.
    // An in-progress or failed atomic push still produces a check-run named
    // "merge-train" from the trusted App with a valid fingerprint, but its
    // output does not describe a real promotion and must not be surfaced as
    // provenance for incident diagnosis.
    const promotion = (headCheckRuns || [])
      .filter((check) => isTrustedTrainPromotionCheck(check, trustedAppId))
      .sort((left, right) => right.id - left.id)[0];
    return promotion?.output?.summary
      ? ['', '## Merge-train promotion provenance', '', promotion.output.summary]
      : [];
  })(),
  '',
  ...(needsAdminIntervention
    ? [
        '## Required human/admin intervention',
        '',
        'This incident was raised because automation cannot safely recover without a human or repository-admin action.',
        'The fix must include a deterministic guard, automation change, or documented removal condition so the same intervention is not needed again.',
        '',
      ]
    : []),
  '@copilot Diagnose this repository-level failure, implement the smallest correct fix on a branch from `main`, run the required verification, open a non-draft PR, and arm squash auto-merge. Do not weaken a gate or explicit requirement.',
].join('\n');

let issue;
if (existing) {
  issue = (
    await request(token, `/repos/${owner}/${repo}/issues/${existing.number}`, {
      method: 'PATCH',
      body: {
        body,
        labels: [label, ...(needsAdminIntervention ? [adminInterventionLabel] : [])],
      },
    })
  ).data;
} else {
  issue = (
    await request(token, `/repos/${owner}/${repo}/issues`, {
      method: 'POST',
      body: {
        title,
        body,
        labels: [label, ...(needsAdminIntervention ? [adminInterventionLabel] : [])],
      },
    })
  ).data;
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
const copilot = (actors.repository?.suggestedActors?.nodes || []).find(
  (actor) =>
    String(actor.login || '').toLowerCase() === 'copilot-swe-agent' ||
    String(actor.login || '').toLowerCase() === 'copilot',
);
if (!copilot?.id) {
  throw new Error('CRAWLER_CI_PAT cannot discover an assignable Copilot actor');
}

await graphql(
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
process.stdout.write(`${existing ? 'updated' : 'created'} incident issue=#${issue.number}\n`);
