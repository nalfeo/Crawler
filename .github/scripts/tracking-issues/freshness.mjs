function matchesAnyPattern(title, titlePatterns) {
  return titlePatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(title);
  });
}

const metadataMarkerPatterns = new Map();

function getCurrentRunNumber(context) {
  const value = Number(context.runNumber ?? process.env.GITHUB_RUN_NUMBER);
  if (!Number.isFinite(value)) {
    throw new Error('Tracking-issue freshness requires GITHUB_RUN_NUMBER');
  }
  return value;
}

function getCurrentBranch(context) {
  return context.refName ?? process.env.GITHUB_REF_NAME ?? process.env.GITHUB_HEAD_REF ?? '';
}

function readMetadataMarker(body, name) {
  let pattern = metadataMarkerPatterns.get(name);
  if (!pattern) {
    pattern = new RegExp(`<!-- ${name}:(.*?) -->`);
    metadataMarkerPatterns.set(name, pattern);
  }
  const match = body.match(pattern);
  return match?.[1]?.trim() ?? null;
}

export function parseTrackingIssueMetadata(body) {
  if (!body) {
    return null;
  }

  const runNumber = Number(readMetadataMarker(body, 'tracking-issue-run-number'));
  if (!Number.isFinite(runNumber)) {
    return null;
  }

  return {
    runId: readMetadataMarker(body, 'tracking-issue-run-id'),
    runNumber,
    headBranch: readMetadataMarker(body, 'tracking-issue-head-branch') ?? '',
  };
}

export function withTrackingIssueRunMetadata(body, { context }) {
  const metadata = [
    `<!-- tracking-issue-run-id:${context.runId ?? process.env.GITHUB_RUN_ID ?? ''} -->`,
    `<!-- tracking-issue-run-number:${getCurrentRunNumber(context)} -->`,
    `<!-- tracking-issue-head-branch:${getCurrentBranch(context)} -->`,
  ].join('\n');
  return `${metadata}\n\n${body}`;
}

export async function getWorkflowRunFreshness({ github, context, titlePatterns }) {
  const { owner, repo } = context.repo;
  const currentRunNumber = getCurrentRunNumber(context);
  const currentBranch = getCurrentBranch(context);
  const openIssues = await github.paginate(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: 'open',
    per_page: 100,
  });

  const newerCandidates = openIssues.flatMap((issue) => {
    if (issue.pull_request || !matchesAnyPattern(issue.title, titlePatterns) || !issue.body) {
      return [];
    }

    const metadata = parseTrackingIssueMetadata(issue.body);
    if (
      !metadata ||
      metadata.headBranch !== currentBranch ||
      metadata.runNumber <= currentRunNumber
    ) {
      return [];
    }

    return [{ issue, metadata }];
  });

  const newestCandidate = newerCandidates.sort(
    (left, right) =>
      right.metadata.runNumber - left.metadata.runNumber || right.issue.number - left.issue.number,
  )[0];
  const newerIssue = newestCandidate?.issue ?? null;

  return {
    currentRunNumber,
    currentBranch,
    newerIssue,
    newerIssueMetadata: newestCandidate?.metadata ?? null,
    isLatest: newerIssue === null,
  };
}
