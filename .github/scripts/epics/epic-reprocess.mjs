import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { EPIC_NODE_MARKER_PREFIX } from '../ci-recovery/markers.mjs';
import { graphql, paginate, request } from '../ci-recovery/github.mjs';
import {
  IssueClaimedByGoobersError,
  IssueNoLongerOpenError,
  intakeOpenedIssue,
  isCopilotLogin,
} from '../ci-recovery/issue-intake-lib.mjs';
import { BLOCKED_LABEL } from '../merge-train/state.mjs';

export function isManagedOpenEpicNode(issue) {
  return (
    String(issue?.state || '').toLowerCase() === 'open' &&
    String(issue?.body || '').includes(EPIC_NODE_MARKER_PREFIX)
  );
}

export function blockedIssueNumbers(issue) {
  return [
    ...new Set(
      [...String(issue?.body || '').matchAll(/^Blocked by (.+)$/gm)]
        .flatMap((match) => [...match[1].matchAll(/#(\d+)/g)])
        .map((match) => Number.parseInt(match[1], 10)),
    ),
  ];
}

async function openTextBlockers({ requestFn, token, owner, repo, issue }) {
  const blockers = [];
  for (const issueNumber of blockedIssueNumbers(issue)) {
    const response = await requestFn(token, `/repos/${owner}/${repo}/issues/${issueNumber}`);
    if (String(response.data?.state || '').toLowerCase() === 'open') {
      blockers.push(issueNumber);
    }
  }
  return blockers;
}

/**
 * Fetches every PR GitHub would close when this epic-node issue is resolved
 * (`Fixes #N` / `Closes #N` in a PR body), via the same
 * `closedByPullRequestsReferences` relation the issue-detail UI uses. Fully
 * paginated so a node with many superseding attempts never silently truncates
 * to a partial (and therefore possibly wrong) liveness verdict.
 */
export async function getLinkedPullRequests({ graphqlFn, token, owner, repo, issueNumber }) {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        issue(number: $number) {
          closedByPullRequestsReferences(first: 50, after: $cursor) {
            pageInfo { hasNextPage endCursor }
            nodes {
              number
              state
              labels(first: 100) { nodes { name } }
            }
          }
        }
      }
    }`;
  const pullRequests = [];
  let cursor = null;
  do {
    const data = await graphqlFn(token, query, { owner, repo, number: issueNumber, cursor });
    const refs = data.repository?.issue?.closedByPullRequestsReferences;
    for (const node of refs?.nodes || []) {
      pullRequests.push({
        number: node.number,
        state: node.state,
        labels: (node.labels?.nodes || []).map((label) => ({ name: label.name })),
      });
    }
    cursor = refs?.pageInfo?.hasNextPage ? refs.pageInfo.endCursor : null;
  } while (cursor);
  return pullRequests;
}

function hasBlockedLabel(pullRequest) {
  return (pullRequest?.labels || []).some(
    (label) => String(label?.name || '').toLowerCase() === BLOCKED_LABEL,
  );
}

/**
 * Determines whether an epic node's *existing* Copilot assignment still
 * reflects live work, or whether it is stale and must be force-restarted.
 *
 * This is the fix for the epic-node "stuck forever" bug: `runIssueIntake`
 * (called by `intakeOpenedIssue` below) always re-affirms the current
 * assignee set unless told to `restart`. Replacing the assignee list with
 * the SAME list (Copilot already present) does not re-fire GitHub's
 * `assigned` webhook, so a plain reprocess pass silently reports
 * `assigned: true` on every hourly run without ever actually restarting
 * anything. An epic node whose linked PR died therefore stayed assigned to
 * Copilot forever with no forward progress and no visible failure.
 *
 * Two independent ways ownership goes stale, both reported with a distinct
 * `reason` so the two failure classes stay distinguishable in logs:
 *   - abandoned: every linked PR (if any were ever opened) is now closed
 *     WITHOUT having merged. A closing PR normally restarts its issue itself
 *     (`reconcile.mjs`'s `drainPendingIssueRestarts`, gated on the PR
 *     transitioning to closed) -- this is the backstop for when that path
 *     never ran (PR closed by a route other than the merge train, or the
 *     restart itself was lost). A MERGED linked PR is never abandonment
 *     evidence, even alongside other closed siblings -- see below.
 *   - quarantined: every currently-open linked PR carries `merge-train-blocked`
 *     -- the merge train ejected it after repeated same-repo restricted-branch
 *     (`copilot/*`) update-branch 403s (see merge-train/reconcile.mjs) and it
 *     can never advance on its current branch. `quarantine-repair.mjs` is the
 *     first line of defense (it opens a live, writable-branch replacement PR
 *     that also closes this issue); this is the backstop for when a repair
 *     PR was not created or was itself abandoned.
 *
 * A node with NO linked PR at all is deliberately left alone (`stale: false`):
 * Copilot may simply not have opened a PR yet, and forcing a restart on every
 * fresh assignment would violate "never restart a healthy active session".
 * Staleness requires positive evidence -- a PR that existed and died -- not
 * merely the absence of one.
 */
export function copilotOwnershipStatus(issue, linkedPullRequests) {
  const copilotAssigned = (issue?.assignees || []).some((assignee) =>
    isCopilotLogin(assignee?.login),
  );
  if (!copilotAssigned) {
    return { stale: false, reason: 'Copilot is not currently assigned' };
  }
  if (!linkedPullRequests || linkedPullRequests.length === 0) {
    return { stale: false, reason: 'no linked PR yet; assumed in-progress session' };
  }
  // A MERGED linked PR is definitive proof the work landed -- never treat it
  // as abandonment. GitHub's issue auto-close on merge can lag the merge
  // event (webhook delivery, or a maintainer reopening a completed epic
  // node), so this reprocess pass can observe the issue still `open` and the
  // PR already `merged` in the same window; forcing a restart here would be
  // a disruptive, wasted re-implementation of already-shipped work.
  const mergedLinked = linkedPullRequests.filter(
    (pullRequest) => String(pullRequest?.state || '').toLowerCase() === 'merged',
  );
  if (mergedLinked.length > 0) {
    return {
      stale: false,
      reason: `linked PR(s) ${mergedLinked
        .map((pullRequest) => `#${pullRequest.number}`)
        .join(', ')} merged; issue closure is pending`,
    };
  }
  const openLinked = linkedPullRequests.filter(
    (pullRequest) => String(pullRequest?.state || '').toLowerCase() === 'open',
  );
  if (openLinked.length === 0) {
    return {
      stale: true,
      reason: `abandoned: linked PR(s) ${linkedPullRequests
        .map((pullRequest) => `#${pullRequest.number}`)
        .join(', ')} closed with no live replacement`,
    };
  }
  const healthyOpen = openLinked.filter((pullRequest) => !hasBlockedLabel(pullRequest));
  if (healthyOpen.length === 0) {
    return {
      stale: true,
      reason: `quarantined: linked PR(s) ${openLinked
        .map((pullRequest) => `#${pullRequest.number}`)
        .join(', ')} blocked by the merge train (${BLOCKED_LABEL})`,
    };
  }
  return { stale: false, reason: 'linked PR is open and not quarantined' };
}

export async function reprocessEpicNodes({
  graphqlFn,
  paginateFn,
  requestFn,
  token,
  owner,
  repo,
  maintainerLogin = 'nalfeo',
}) {
  const issues = await paginateFn(token, `/repos/${owner}/${repo}/issues?state=open&labels=epic`);
  const results = [];
  for (const issue of issues.filter(isManagedOpenEpicNode)) {
    try {
      const blockers = await openTextBlockers({ requestFn, token, owner, repo, issue });
      if (blockers.length > 0) {
        results.push({
          number: issue.number,
          assigned: false,
          reason: `blocked by open ${blockers.map((blocker) => `#${blocker}`).join(', ')}`,
        });
        continue;
      }
      const linkedPullRequests = await getLinkedPullRequests({
        graphqlFn,
        token,
        owner,
        repo,
        issueNumber: issue.number,
      });
      const ownership = copilotOwnershipStatus(issue, linkedPullRequests);
      const result = await intakeOpenedIssue({
        graphql: graphqlFn,
        paginate: paginateFn,
        request: requestFn,
        token,
        owner,
        repo,
        issue,
        maintainerLogin,
        restart: ownership.stale,
      });
      results.push({
        number: issue.number,
        ...result,
        ...(ownership.stale ? { restarted: true, staleReason: ownership.reason } : {}),
      });
    } catch (error) {
      if (error instanceof IssueNoLongerOpenError || error instanceof IssueClaimedByGoobersError) {
        results.push({
          number: issue.number,
          assigned: false,
          reason:
            error instanceof IssueNoLongerOpenError
              ? 'node closed during processing'
              : 'node claimed by Goobers during processing',
        });
        continue;
      }
      results.push({
        number: issue.number,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function main() {
  const token = process.env.CRAWLER_CI_PAT || '';
  const repository = process.env.GITHUB_REPOSITORY || '';
  const [owner, repo] = repository.split('/');
  if (!token || !owner || !repo) {
    throw new Error('CRAWLER_CI_PAT and GITHUB_REPOSITORY are required');
  }

  const results = await reprocessEpicNodes({
    graphqlFn: graphql,
    paginateFn: paginate,
    requestFn: request,
    token,
    owner,
    repo,
    maintainerLogin: process.env.ISSUE_OWNER || 'nalfeo',
  });
  let errors = 0;
  for (const result of results) {
    if (result.error) {
      errors += 1;
      process.stdout.write(`epic-node issue=#${result.number} error=${result.error}\n`);
    } else if (result.assigned) {
      const restartSuffix = result.restarted ? ` restarted reason=${result.staleReason}` : '';
      process.stdout.write(
        `epic-node issue=#${result.number} assigned assignee=@${result.assignee} comment=${result.comment}${restartSuffix}\n`,
      );
    } else {
      process.stdout.write(`epic-node issue=#${result.number} skip: ${result.reason}\n`);
    }
  }
  process.stdout.write(`epic-reprocess nodes=${results.length} errors=${errors}\n`);
  if (errors > 0) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(
      `epic-reprocess failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
