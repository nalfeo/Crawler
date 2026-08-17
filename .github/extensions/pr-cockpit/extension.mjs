import { joinSession } from '@github/copilot-sdk/extension';
import { getPullRequestCockpit, listPullRequests } from './lib/github-client.mjs';

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

async function handleListPrCockpit(params = {}) {
  return listPullRequests({
    cwd: process.cwd(),
    state: typeof params.state === 'string' ? params.state : 'open',
    limit: positiveInteger(params.limit) ?? 20,
  });
}

async function handleGetPrCockpit(params = {}) {
  const pullNumber = positiveInteger(params.pullNumber);
  if (!pullNumber) return { error: 'pullNumber must be a positive integer.' };
  return getPullRequestCockpit({ cwd: process.cwd(), pullNumber });
}

async function handleGetPrBlockers(params = {}) {
  const cockpit = await handleGetPrCockpit(params);
  if (cockpit.error) return cockpit;
  return {
    repository: cockpit.repository,
    pullRequest: cockpit.pullRequest,
    blockers: cockpit.blockers,
    mergeReady: cockpit.mergeReady,
    notes: cockpit.notes,
  };
}

const session = await joinSession({
  tools: [
    {
      name: 'list_pr_cockpit',
      description:
        'Read-only Crawler PR cockpit list. Returns open pull requests with normalized draft, mergeability, CI recovery, and merge-train labels.',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['open', 'closed', 'merged', 'all'], default: 'open' },
          limit: { type: 'number', minimum: 1, maximum: 100, default: 20 },
        },
      },
      handler: handleListPrCockpit,
    },
    {
      name: 'get_pr_cockpit',
      description:
        'Read-only Crawler PR cockpit detail. Summarizes PR state, check runs, unresolved review threads, and merge blockers without mutating GitHub.',
      parameters: {
        type: 'object',
        properties: { pullNumber: { type: 'number', minimum: 1 } },
        required: ['pullNumber'],
      },
      handler: handleGetPrCockpit,
    },
    {
      name: 'get_pr_blockers',
      description:
        'Read-only blocker summary for a Crawler PR. Use before claiming a PR is blocked; never infers a human-review requirement.',
      parameters: {
        type: 'object',
        properties: { pullNumber: { type: 'number', minimum: 1 } },
        required: ['pullNumber'],
      },
      handler: handleGetPrBlockers,
    },
  ],
});

session.log('[pr-cockpit] extension started');
