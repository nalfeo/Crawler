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
const ASSET_ACTIVE_STALE_MS = 60 * 60 * 1000;
const WORKFLOW_ACTIVE_STALE_MS = 30 * 60 * 1000;
// Only comments posted by the workflow's automation identity are treated as
// authoritative pipeline markers. This prevents public fork contributors from
// spoofing completion/failure state or injecting summary URLs by posting a
// comment that matches one of the recognised prefixes.
const TRUSTED_ASSET_COMMENT_LOGINS = new Set(['github-actions[bot]']);

function labelNames(pullRequest) {
  return new Set((pullRequest.labels ?? []).map((label) => label.name));
}

function compact(value) {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ');
}

function truncate(value, maxLength = 500) {
  const text = compact(value);
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function timestamp(value) {
  return Date.parse(value ?? '') || 0;
}

function firstUrl(body, pattern) {
  return String(body ?? '').match(pattern)?.[0] ?? null;
}

function assetCommentMarker(comment) {
  const body = String(comment.body ?? '');
  const base = {
    commentId: comment.id,
    commentUrl: comment.url ?? null,
    updatedAt: comment.updatedAt ?? comment.createdAt ?? null,
    workflowUrl: firstUrl(body, /https:\/\/github\.com\/[^\s)]+\/actions\/runs\/\d+/),
    summaryUrl: firstUrl(body, /https?:\/\/[^\s)`]+\/summary\.json/),
  };
  if (/^(?:🎬 Queued for processing|🔁 Re-queued \(previous run appeared stale\))/u.test(body)) {
    return {
      ...base,
      kind: 'attempt',
      stage: 'queued',
      state: 'queued',
      detail: body.startsWith('🔁') ? 'Re-queued after a stale claim.' : 'Queued for processing.',
    };
  }
  if (/^🧪 Started asset-request pipeline/u.test(body)) {
    return {
      ...base,
      kind: 'progress',
      stage: 'synthesize',
      state: 'in_progress',
      detail: 'Brief synthesis started.',
    };
  }
  if (/^🧠 Selected candidate/u.test(body)) {
    return {
      ...base,
      kind: 'progress',
      stage: 'brief-selected',
      state: 'in_progress',
      detail: truncate(body.split('\n')[0], 180),
    };
  }
  if (/^📌 Promoted brief/u.test(body)) {
    return {
      ...base,
      kind: 'progress',
      stage: 'generate → postprocess → judge',
      state: 'in_progress',
      detail: truncate(body.split('\n')[0], 180),
    };
  }
  if (/^✅ Asset-request pipeline complete\./u.test(body)) {
    const selected = body.match(/^- selected for publication:\s*(.+)$/im)?.[1];
    if (/^- selection: no acceptable variants/im.test(body)) {
      return {
        ...base,
        kind: 'terminal',
        stage: 'quality-stopped',
        state: 'failed',
        detail: 'No acceptable variants; human intervention required.',
      };
    }
    return {
      ...base,
      kind: 'terminal',
      stage: 'generated + selected',
      state: 'complete',
      detail: selected
        ? `Selected for publication: ${truncate(selected, 180)}`
        : 'Generation complete.',
    };
  }
  if (/^⚠️ Asset-request pipeline failed\./u.test(body)) {
    const error = body.match(/\nError:\s*([\s\S]*?)(?:\n\n|$)/i)?.[1];
    return {
      ...base,
      kind: 'terminal',
      stage: 'failed',
      state: 'failed',
      detail: truncate(error || 'The worker reported a pipeline failure.'),
    };
  }
  return null;
}

export function parseAssetRequestComments(comments, { historyTruncated = false, now } = {}) {
  const ordered = [...new Map((comments ?? []).map((comment) => [comment.id, comment])).values()]
    .sort(
      (left, right) =>
        timestamp(left.createdAt ?? left.updatedAt) -
          timestamp(right.createdAt ?? right.updatedAt) ||
        String(left.id ?? '').localeCompare(String(right.id ?? '')),
    )
    .filter((comment) => TRUSTED_ASSET_COMMENT_LOGINS.has(comment.author?.login ?? ''))
    .map(assetCommentMarker)
    .filter(Boolean);
  const newestAttemptIndex = ordered.findLastIndex((marker) => marker.kind === 'attempt');
  const attempt = newestAttemptIndex >= 0 ? ordered.slice(newestAttemptIndex) : ordered;
  const latest = attempt.at(-1);
  if (!latest) {
    return {
      stage: historyTruncated ? 'unknown (history truncated)' : 'not queued',
      state: historyTruncated ? 'truncated' : 'unknown',
      detail: historyTruncated
        ? 'No recognized marker was found in the bounded comment window.'
        : 'No asset pipeline marker has been posted.',
      updatedAt: null,
      commentUrl: null,
      workflowUrl: null,
      summaryUrl: null,
      attribution: historyTruncated ? 'partial' : 'none',
      stale: false,
    };
  }
  const hasAttemptProgress = attempt.some((marker) => marker.kind === 'progress');
  const attribution =
    latest.kind === 'terminal' && newestAttemptIndex >= 0 && !hasAttemptProgress
      ? 'inferred'
      : 'observed';
  const stale =
    !['complete', 'failed'].includes(latest.state) &&
    timestamp(now) - timestamp(latest.updatedAt) > ASSET_ACTIVE_STALE_MS;
  return {
    ...latest,
    state: stale ? 'stale' : latest.state,
    detail: stale
      ? `${latest.detail} No newer marker has appeared for over an hour.`
      : latest.detail,
    attribution,
    stale,
  };
}

function durationMs(startedAt, completedAt, now) {
  const start = timestamp(startedAt);
  if (!start) return null;
  const end = timestamp(completedAt) || timestamp(now);
  return Math.max(0, end - start);
}

function workflowStep(latestRun, namePattern, now) {
  const job = latestRun?.jobs?.find((entry) => /ingest issues \+ drain queue/i.test(entry.name));
  const step = job?.steps?.find((entry) => namePattern.test(entry.name));
  if (!latestRun || !job || !step) {
    return {
      state: latestRun ? 'not_observed' : 'not_run',
      startedAt: null,
      completedAt: null,
      elapsedMs: null,
      detail: latestRun ? 'Step was not present in the latest run.' : 'No workflow run observed.',
      url: job?.html_url ?? latestRun?.html_url ?? null,
    };
  }
  const state = step.status === 'completed' ? (step.conclusion ?? 'completed') : step.status;
  const stale =
    step.status === 'in_progress' &&
    durationMs(step.started_at, step.completed_at, now) > WORKFLOW_ACTIVE_STALE_MS;
  return {
    state: stale ? 'stale' : state,
    startedAt: step.started_at ?? null,
    completedAt: step.completed_at ?? null,
    elapsedMs: durationMs(step.started_at, step.completed_at, now),
    detail: stale ? 'Step has exceeded the expected workflow window.' : step.name,
    url: job.html_url ?? latestRun.html_url ?? null,
  };
}

function canonicalAssetState(rawState, now) {
  const assetRequests = rawState.assetRequests ?? {};
  const openPullRequests = assetRequests.pullRequests ?? [];
  const queuePr = openPullRequests.find((pullRequest) => pullRequest.head?.ref === 'assets/queue');
  const promotePr = openPullRequests.find(
    (pullRequest) => pullRequest.head?.ref === 'assets/promote',
  );
  const refs = new Set((assetRequests.refs ?? []).map((entry) => entry.ref));
  const latestRun = assetRequests.reconcilerWorkflow?.latestRun ?? null;
  const runActive = latestRun && latestRun.status !== 'completed';
  let state = 'idle';
  let detail = 'No downstream queue or promotion work is active.';
  let url = latestRun?.html_url ?? null;
  if (promotePr) {
    state = 'promotion-pr';
    detail = `Guarded promotion PR #${promotePr.number} is open.`;
    url = promotePr.html_url;
  } else if (refs.has('refs/heads/assets/promote')) {
    state = 'promotion-branch';
    detail = 'The guarded assets/promote branch exists without an open PR.';
    url = `https://github.com/${rawState.repository}/tree/assets/promote`;
  } else if (queuePr) {
    state = 'queue-review';
    detail = `Canonical queue PR #${queuePr.number} is awaiting review or reconciliation.`;
    url = queuePr.html_url;
  } else if (runActive) {
    // Overlay reconciler activity before inspecting topology: an active run
    // explains why no PR exists yet without false-positive queue-without-pr.
    state =
      durationMs(latestRun.run_started_at ?? latestRun.created_at, null, now) >
      WORKFLOW_ACTIVE_STALE_MS
        ? 'stale'
        : latestRun.status;
    detail = 'The downstream Sprite queue reconciler is active.';
  } else if (latestRun?.conclusion && latestRun.conclusion !== 'success') {
    // Overlay reconciler failures before topology: a failed run is the primary
    // signal; bare branch existence is incidental in this state.
    state = latestRun.conclusion;
    detail = 'The latest downstream Sprite queue reconciler did not succeed.';
    url = latestRun.html_url ?? url;
  } else if (refs.has('refs/heads/assets/queue')) {
    // The assets/queue branch is deliberately never reset after a reconciler
    // run, so its bare existence is not evidence of pending work. When the
    // reconciler last ran successfully (or hasn't run at all), report idle so
    // the steady-state repository does not permanently show as failing.
    // queue-without-pr is only emitted when the reconciler has not yet
    // confirmed that the queue is current with main (no successful run on
    // record), giving operators a prompt to investigate without masking a
    // healthy no-op.
    if (latestRun?.conclusion !== 'success') {
      state = 'queue-without-pr';
      detail =
        'The assets/queue branch exists without an open canonical PR; no successful reconciler run on record.';
      url = `https://github.com/${rawState.repository}/tree/assets/queue`;
    }
  }
  return {
    state,
    detail,
    url,
    startedAt: latestRun?.run_started_at ?? latestRun?.created_at ?? null,
    completedAt: latestRun?.updated_at ?? null,
    elapsedMs: latestRun
      ? durationMs(
          latestRun.run_started_at ?? latestRun.created_at,
          latestRun.status === 'completed' ? latestRun.updated_at : null,
          now,
        )
      : null,
    lane: 'downstream reconciler',
    queue: {
      branchPresent: refs.has('refs/heads/assets/queue'),
      pullRequest: queuePr
        ? { number: queuePr.number, title: compact(queuePr.title), url: queuePr.html_url }
        : null,
    },
    promote: {
      branchPresent: refs.has('refs/heads/assets/promote'),
      pullRequest: promotePr
        ? { number: promotePr.number, title: compact(promotePr.title), url: promotePr.html_url }
        : null,
    },
  };
}

export function buildAssetPipelineState(rawState) {
  const assetRequests = rawState.assetRequests ?? {};
  const now = rawState.fetchedAt;
  const issues = (assetRequests.issues ?? []).map((issue) => {
    const parsed = parseAssetRequestComments(issue.comments?.nodes ?? [], {
      historyTruncated: Boolean(issue.comments?.pageInfo?.hasPreviousPage),
      now,
    });
    return {
      number: issue.number,
      title: compact(issue.title),
      url: issue.url,
      createdAt: issue.createdAt ?? null,
      ...parsed,
    };
  });
  const latestAssetRun = assetRequests.assetWorkflow?.latestRun ?? null;
  const stages = [
    {
      id: 'ingest',
      label: 'Ingest',
      lane: 'Asset Request Pipeline run',
      ...workflowStep(latestAssetRun, /ingest asset-request issues/i, now),
    },
    {
      id: 'drain',
      label: 'Generate + judge',
      lane: 'Asset Request Pipeline run',
      ...workflowStep(latestAssetRun, /drain worker/i, now),
    },
    {
      id: 'publish',
      label: 'Publish selected',
      lane: 'Asset Request Pipeline run',
      ...workflowStep(latestAssetRun, /publish selected variants/i, now),
    },
    {
      id: 'promote',
      label: 'Promote',
      ...canonicalAssetState(rawState, now),
    },
  ];
  const counts = {
    total: issues.length,
    complete: issues.filter((issue) => issue.state === 'complete').length,
    active: issues.filter((issue) => ['queued', 'in_progress'].includes(issue.state)).length,
    failed: issues.filter((issue) => issue.state === 'failed').length,
    stale: issues.filter((issue) => issue.state === 'stale').length,
    truncated: issues.filter((issue) => issue.state === 'truncated').length,
    unknown: issues.filter((issue) => issue.state === 'unknown').length,
  };
  const partial =
    Boolean(assetRequests.issuesTruncated) ||
    Boolean(assetRequests.errors?.length) ||
    issues.some((issue) => issue.attribution === 'partial');
  const stageDanger = stages.some((stage) =>
    /fail|cancel|timed_out|stale|queue-without-pr|promotion-branch/i.test(stage.state),
  );
  const active =
    counts.active > 0 ||
    stages.some((stage) => /queued|pending|in_progress|waiting|requested/i.test(stage.state)) ||
    ['queue-review', 'promotion-pr'].includes(stages.at(-1).state);
  const severity =
    counts.failed > 0 || counts.stale > 0 || stageDanger
      ? 'danger'
      : partial || counts.unknown > 0
        ? 'warning'
        : active
          ? 'info'
          : 'success';
  return {
    severity,
    defaultExpanded: severity !== 'success',
    active,
    partial,
    counts,
    issues,
    stages,
    latestRun: latestAssetRun
      ? {
          id: latestAssetRun.id,
          status: latestAssetRun.status,
          conclusion: latestAssetRun.conclusion ?? null,
          url: latestAssetRun.html_url,
          createdAt: latestAssetRun.created_at ?? null,
          updatedAt: latestAssetRun.updated_at ?? null,
        }
      : null,
    warnings: [
      ...(assetRequests.issuesTruncated
        ? ['Open asset-request issues exceeded the 500-issue safety cap.']
        : []),
      ...(assetRequests.errors ?? []),
      ...(issues.some((issue) => issue.attribution === 'partial')
        ? ['One or more issue statuses have truncated comment history.']
        : []),
      ...(assetRequests.assetWorkflow?.executableRunNotFound
        ? [
            'No executable Asset Request Pipeline run was found in the last few runs; observable stage data may be stale.',
          ]
        : []),
    ],
  };
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
    assetPipeline: buildAssetPipelineState(rawState),
    error,
  };
  return { ...snapshot, bottleneck: bottleneckFor(snapshot) };
}
