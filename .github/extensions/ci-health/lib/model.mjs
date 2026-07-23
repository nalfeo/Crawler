import {
  BLOCKED_LABEL,
  CI_CONFLICT_ORDER_WAIT_LABEL,
  MAX_TRAIN_SIZE,
  RECOVERY_PENDING_LABEL,
  STATUS_MARKER,
  VALIDATION_FAILED_LABEL,
  hasLeadingMarker,
  queueEntries,
} from '../../../scripts/merge-train/state.mjs';
import {
  OWNER_LABEL_PREFIX,
  WAITING_LABEL,
  WAITING_TRANSITION_LABEL,
} from '../../../scripts/ci-recovery/state.mjs';

const QUEUED_JOB_STATES = new Set(['pending', 'queued', 'requested', 'waiting']);
const QUEUED_RUN_STATES = new Set(['queued', 'waiting', 'pending', 'requested']);

function labelNames(pullRequest) {
  return new Set((pullRequest.labels ?? []).map((label) => label.name));
}

function compact(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function statusField(body, name) {
  const match = String(body).match(new RegExp(`^- ${name}:\\s*(.+)$`, 'im'));
  return match?.[1]?.trim() ?? null;
}

function stripCodeTicks(value) {
  if (!value) return value;
  return value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1) : value;
}

export function parseTrainStatusComments(comments, { fetchFailed = false } = {}) {
  if (fetchFailed) {
    return {
      commentHealth: 'unavailable',
      reportedPosition: null,
      candidateSha: null,
      state: 'unknown',
      detail: 'Merge Train status comments could not be fetched.',
    };
  }
  const managed = (comments ?? [])
    .filter((comment) => hasLeadingMarker(comment.body, STATUS_MARKER))
    .sort(
      (left, right) =>
        (Date.parse(left.updated_at ?? '') || 0) - (Date.parse(right.updated_at ?? '') || 0) ||
        Number(left.id ?? 0) - Number(right.id ?? 0),
    );

  if (managed.length === 0) {
    return {
      commentHealth: 'missing',
      reportedPosition: null,
      candidateSha: null,
      state: 'queued',
      detail: 'No managed Merge Train status comment has been published yet.',
    };
  }

  const body = managed.at(-1).body;
  const positionText = statusField(body, 'Position');
  const candidateText = stripCodeTicks(statusField(body, 'Candidate'));
  const state = stripCodeTicks(statusField(body, 'State'));
  const detail = statusField(body, 'Detail');
  const reportedPosition = /^\d+$/.test(positionText ?? '') ? Number(positionText) : NaN;
  const malformed =
    !Number.isInteger(reportedPosition) ||
    reportedPosition < 0 ||
    !candidateText ||
    !state ||
    !detail;

  return {
    commentHealth: malformed ? 'malformed' : managed.length > 1 ? 'duplicate' : 'ok',
    reportedPosition: Number.isInteger(reportedPosition) ? reportedPosition : null,
    candidateSha: candidateText === 'not built' ? null : candidateText,
    state: compact(state || 'unknown'),
    detail: compact(detail || 'Managed status comment is malformed.'),
  };
}

function normalizePullRequest(pullRequest) {
  return {
    number: pullRequest.number,
    title: compact(pullRequest.title),
    url: pullRequest.html_url,
    createdAt: pullRequest.created_at ?? null,
    updatedAt: pullRequest.updated_at ?? null,
    headSha: pullRequest.head?.sha ?? null,
    headRef: pullRequest.head?.ref ?? null,
    labels: [...labelNames(pullRequest)].sort(),
  };
}

function pullRequestState(pullRequest) {
  const labels = labelNames(pullRequest);
  if (labels.has(VALIDATION_FAILED_LABEL)) return 'validation-failed';
  if (labels.has(BLOCKED_LABEL)) return 'blocked';
  if (labels.has(CI_CONFLICT_ORDER_WAIT_LABEL)) return 'conflict-order-wait';
  if (labels.has(RECOVERY_PENDING_LABEL)) return 'recovery-pending';
  if (labels.has(WAITING_TRANSITION_LABEL)) return 'recovery-transition';
  if (labels.has(WAITING_LABEL)) return 'recovery-waiting';
  if ([...labels].some((label) => label.startsWith(OWNER_LABEL_PREFIX))) return 'recovery-owned';
  return 'queued';
}

export function buildTrainState({
  openPullRequests,
  recoveryPullRequests,
  commentsByPr,
  commentFetchFailed = new Set(),
  repository,
}) {
  const canonicalQueue = queueEntries(openPullRequests, repository);
  const activeQueue = canonicalQueue.slice(0, MAX_TRAIN_SIZE);
  const activeNumbers = new Set(activeQueue.map((pullRequest) => pullRequest.number));

  const candidates = activeQueue.map((pullRequest, index) => {
    const status = parseTrainStatusComments(commentsByPr.get(pullRequest.number) ?? [], {
      fetchFailed: commentFetchFailed.has(pullRequest.number),
    });
    return {
      ...normalizePullRequest(pullRequest),
      position: index + 1,
      positionDrift:
        status.reportedPosition !== null && status.reportedPosition !== index + 1
          ? status.reportedPosition
          : null,
      ...status,
    };
  });

  const blocked = openPullRequests
    .filter((pullRequest) => {
      const labels = labelNames(pullRequest);
      return (
        !activeNumbers.has(pullRequest.number) &&
        (labels.has(BLOCKED_LABEL) ||
          labels.has(CI_CONFLICT_ORDER_WAIT_LABEL) ||
          labels.has(VALIDATION_FAILED_LABEL))
      );
    })
    .sort(
      (left, right) =>
        (Date.parse(left.created_at ?? '') || 0) - (Date.parse(right.created_at ?? '') || 0) ||
        left.number - right.number,
    )
    .map((pullRequest) => ({
      ...normalizePullRequest(pullRequest),
      state: pullRequestState(pullRequest),
      status: parseTrainStatusComments(commentsByPr.get(pullRequest.number) ?? [], {
        fetchFailed: commentFetchFailed.has(pullRequest.number),
      }),
    }));

  const recoveryByNumber = new Map();
  for (const pullRequest of [...openPullRequests, ...recoveryPullRequests]) {
    const labels = labelNames(pullRequest);
    const isRecovery =
      labels.has(RECOVERY_PENDING_LABEL) ||
      labels.has(WAITING_LABEL) ||
      labels.has(WAITING_TRANSITION_LABEL) ||
      [...labels].some((label) => label.startsWith(OWNER_LABEL_PREFIX));
    if (isRecovery) {
      recoveryByNumber.set(pullRequest.number, {
        ...normalizePullRequest(pullRequest),
        state: pullRequestState(pullRequest),
        closedAt: pullRequest.closed_at ?? null,
      });
    }
  }

  return {
    maxSize: MAX_TRAIN_SIZE,
    queueDepth: canonicalQueue.length,
    backlogCount: Math.max(0, canonicalQueue.length - MAX_TRAIN_SIZE),
    candidates,
    blocked,
    recovery: [...recoveryByNumber.values()].sort(
      (left, right) =>
        (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0) ||
        left.number - right.number,
    ),
  };
}

function isHostedJob(job) {
  return !(job.labels ?? []).some((label) => String(label).toLowerCase() === 'self-hosted');
}

function normalizeJob(job) {
  return {
    id: job.id,
    name: compact(job.name),
    status: job.status,
    conclusion: job.conclusion ?? null,
    startedAt: job.started_at ?? null,
    completedAt: job.completed_at ?? null,
    runnerName: job.runner_name ?? null,
    labels: job.labels ?? [],
    url: job.html_url ?? null,
    hosted: isHostedJob(job),
  };
}

function runRank(run) {
  if (run.status === 'queued') return 0;
  if (run.status === 'waiting') return 1;
  return 2;
}

export function buildActionsState({ runs, activeRunsTruncated, partialErrors }, runnerCap) {
  const normalizedRuns = runs
    .map((run) => {
      const jobs = (run.jobs ?? []).map(normalizeJob);
      return {
        id: run.id,
        name: compact(run.name ?? run.display_title ?? 'Workflow'),
        displayTitle: compact(run.display_title ?? run.name ?? 'Workflow'),
        workflowPath: run.path ?? null,
        status: run.status,
        event: run.event,
        branch: run.head_branch ?? null,
        headSha: run.head_sha ?? null,
        actor: run.actor?.login ?? null,
        createdAt: run.created_at ?? null,
        updatedAt: run.updated_at ?? null,
        url: run.html_url,
        jobs,
        jobsTruncated: Boolean(run.jobsTruncated),
        jobsError: run.jobsError ?? null,
      };
    })
    .sort(
      (left, right) =>
        runRank(left) - runRank(right) ||
        (Date.parse(left.createdAt ?? '') || 0) - (Date.parse(right.createdAt ?? '') || 0) ||
        left.id - right.id,
    );

  const hostedJobs = normalizedRuns.flatMap((run) => run.jobs).filter((job) => job.hosted);
  const inProgress = hostedJobs.filter((job) => job.status === 'in_progress').length;
  const queued = hostedJobs.filter((job) => QUEUED_JOB_STATES.has(job.status)).length;
  const queuedRunCount = normalizedRuns.filter((run) => QUEUED_RUN_STATES.has(run.status)).length;
  const warnings = [];
  if (activeRunsTruncated > 0) {
    warnings.push(
      `${activeRunsTruncated} active workflow runs were omitted by the API safety cap.`,
    );
  }
  if (normalizedRuns.some((run) => run.jobsTruncated)) {
    warnings.push('One or more workflow job lists were truncated.');
  }
  if (normalizedRuns.some((run) => run.jobsError)) {
    warnings.push(
      'One or more workflow job lists could not be loaded; occupancy data is incomplete.',
    );
  }
  warnings.push(...partialErrors);
  if (inProgress >= runnerCap) {
    warnings.unshift(
      `Visible hosted jobs in this repository have reached the configured cap (${inProgress}/${runnerCap}).`,
    );
  } else if (inProgress / runnerCap >= 0.8) {
    warnings.unshift(
      `Visible hosted jobs in this repository are at ${Math.round((inProgress / runnerCap) * 100)}% of the configured cap.`,
    );
  }
  if (queued > 0) {
    warnings.unshift(`${queued} visible hosted job${queued === 1 ? ' is' : 's are'} queued.`);
  }

  return {
    runnerCap,
    occupancyScope: 'Visible hosted jobs in this repository vs configured cap',
    visibleHostedInProgress: inProgress,
    visibleHostedQueued: queued,
    visibleSelfHostedInProgress: normalizedRuns
      .flatMap((run) => run.jobs)
      .filter((job) => !job.hosted && job.status === 'in_progress').length,
    utilizationPercent: Math.round((inProgress / runnerCap) * 100),
    activeRunCount: normalizedRuns.length,
    queuedRunCount,
    warnings,
    runs: normalizedRuns,
  };
}

function bottleneckFor(snapshot) {
  const { train, actions, error } = snapshot;
  if (error) {
    return {
      kind: 'refresh-error',
      severity: 'danger',
      title: 'GitHub state is stale',
      detail: error,
    };
  }
  if (actions.visibleHostedInProgress >= actions.runnerCap) {
    return {
      kind: 'visible-cap-reached',
      severity: 'danger',
      title: 'Visible runner cap reached',
      detail: `${actions.visibleHostedInProgress}/${actions.runnerCap} repository-visible hosted jobs are running.`,
    };
  }
  if (actions.visibleHostedQueued > 0) {
    return {
      kind: 'runner-queue',
      severity: 'warning',
      title: 'Hosted jobs are queued',
      detail: `${actions.visibleHostedQueued} visible hosted job${actions.visibleHostedQueued === 1 ? '' : 's'} waiting for capacity.`,
    };
  }
  if (actions.queuedRunCount > 0) {
    return {
      kind: 'workflow-queue',
      severity: 'warning',
      title: 'Workflow runs are queued',
      detail: `${actions.queuedRunCount} workflow run${actions.queuedRunCount === 1 ? '' : 's'} waiting to start; GitHub has not exposed queued hosted jobs for ${actions.queuedRunCount === 1 ? 'it' : 'them'} yet.`,
    };
  }
  const failedCandidate = train.candidates.find((candidate) =>
    /fail|error|block/i.test(candidate.state),
  );
  if (failedCandidate) {
    return {
      kind: 'train-failure',
      severity: 'danger',
      title: `Merge Train candidate #${failedCandidate.number} needs attention`,
      detail: failedCandidate.detail,
    };
  }
  const waitingCandidate = train.candidates.find(
    (candidate) => !/success|ready|promot/i.test(candidate.state),
  );
  if (waitingCandidate) {
    return {
      kind: 'train-validation',
      severity: 'warning',
      title: `Merge Train is ${waitingCandidate.state}`,
      detail: waitingCandidate.detail,
    };
  }
  if (train.recovery.length > 0) {
    return {
      kind: 'recovery',
      severity: 'warning',
      title: 'CI Recovery work is pending',
      detail: `${train.recovery.length} pull request${train.recovery.length === 1 ? '' : 's'} waiting or owned.`,
    };
  }
  if (actions.activeRunCount > 0) {
    return {
      kind: 'active',
      severity: 'info',
      title: 'CI is active without visible queueing',
      detail: `${actions.activeRunCount} workflow run${actions.activeRunCount === 1 ? '' : 's'} in progress.`,
    };
  }
  return {
    kind: 'idle',
    severity: 'success',
    title: 'CI is idle',
    detail:
      train.queueDepth > 0
        ? 'Merge Train entries are ready for reconciliation.'
        : 'No active runs or train candidates.',
  };
}

export function createDashboardSnapshot(rawState, runnerCap, error = null) {
  const train = buildTrainState(rawState);
  const actions = buildActionsState(rawState, runnerCap);
  const snapshot = {
    repository: rawState.repository,
    repositoryUrl: `https://github.com/${rawState.repository}`,
    actionsUrl: `https://github.com/${rawState.repository}/actions`,
    fetchedAt: rawState.fetchedAt,
    apiCalls: rawState.apiCalls,
    train,
    actions,
    error,
  };
  return { ...snapshot, bottleneck: bottleneckFor(snapshot) };
}
