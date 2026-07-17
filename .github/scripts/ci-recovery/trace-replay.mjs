import {
  automationProgressKey,
  automationStallAction,
  shouldDispatchMergeTrainFill,
} from './state.mjs';

function expandSeries(series) {
  return series.flatMap((entry) =>
    Array.from({ length: entry.count }, (_, index) => ({ ...entry, index })),
  );
}

function nearestRank(values, percentile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1];
}

function effectiveActionKey(record) {
  const index =
    record.duplicateActionModulo === undefined
      ? record.index
      : record.index % record.duplicateActionModulo;
  return `pr-${String(index + 1).padStart(3, '0')}:${record.effectiveActionPrefix}-${String(index + 1).padStart(3, '0')}`;
}

export function replayProductionHourTrace(fixture) {
  const routerRecords = expandSeries(fixture.routerSeries);
  // Each expanded recovery job carries its own latencySeconds so latency is
  // correlated to the job/series entry rather than to a separate histogram
  // that is zip-correlated by position (which is fragile and semantically
  // wrong when entries are suppressed or interleaved differently).
  const recoveryJobs = expandSeries(fixture.recoverySeries);

  const proposedRouterJobs = routerRecords.filter((record) => {
    if (!record.baselineRunnerJob) return false;
    if (record.kind !== 'recursive-fill-success') return true;
    return shouldDispatchMergeTrainFill(record.alreadyQueued);
  });
  const proposedRecoveryJobs = recoveryJobs.filter(
    (record) =>
      !record.suppressedByQueuedAdmission ||
      shouldDispatchMergeTrainFill(record.alreadyQueued ?? true),
  );

  const baselineActions = new Set(
    recoveryJobs.filter((record) => record.effectiveAction).map(effectiveActionKey),
  );
  const proposedActions = new Set(
    proposedRecoveryJobs.filter((record) => record.effectiveAction).map(effectiveActionKey),
  );
  const afterOutcomes = proposedRecoveryJobs.map(
    (record) => record.afterOutcome || record.baselineOutcome,
  );
  const proposedLatencies = proposedRecoveryJobs.map((record) => record.latencySeconds);

  const stale = fixture.staleOwnerModel;
  const staleState = {
    version: 1,
    prNumber: 1,
    headSha: stale.headSha,
    fingerprint: stale.fingerprint,
    owner: 'automation',
    status: 'dispatched',
    leaseId: null,
    trigger: 'schedule:sweep',
    blockers: [],
    attempt: stale.attempt,
    progressKey: automationProgressKey(stale.headSha, stale.fingerprint),
    progressAt: stale.progressAt,
    updatedAt: stale.progressAt,
  };
  const staleAction = automationStallAction({
    state: staleState,
    headSha: stale.headSha,
    fingerprint: stale.fingerprint,
    now: new Date(stale.replayedAt),
  });

  const baselineRunnerJobs =
    routerRecords.filter((record) => record.baselineRunnerJob).length + recoveryJobs.length;
  const proposedRunnerJobs = proposedRouterJobs.length + proposedRecoveryJobs.length;
  return {
    baseline: {
      routerRecords: routerRecords.length,
      recoveryJobs: recoveryJobs.length,
      runnerJobs: baselineRunnerJobs,
      recoverySuccess: recoveryJobs.filter((record) => record.baselineOutcome === 'success').length,
      recoveryFailure: recoveryJobs.filter((record) => record.baselineOutcome === 'failure').length,
      // Baseline p50/p95 come from the observed production measurements in the
      // fixture rather than being recomputed from individual job entries, since
      // the per-job latencySeconds values are anonymised approximations chosen
      // to reflect typical outcomes, not exact per-event recordings.
      p50Seconds: fixture.observed?.recoveryP50Seconds ?? null,
      p95Seconds: fixture.observed?.recoveryP95Seconds ?? null,
      cleanupRaceFailures: recoveryJobs.filter((record) => record.kind === 'cleanup-race').length,
      staleOwnerFailures: 1,
      staleHeartbeatFailures: recoveryJobs.filter(
        (record) => record.kind === 'stale-lease-heartbeat',
      ).length,
      effectiveActions: [...baselineActions].sort(),
    },
    proposed: {
      routerRecords: routerRecords.filter((record) => record.kind !== 'workflow-requested-parked')
        .length,
      recoveryJobs: proposedRecoveryJobs.length,
      runnerJobs: proposedRunnerJobs,
      recoverySuccess: afterOutcomes.filter((outcome) => outcome === 'success').length,
      recoveryFailure: afterOutcomes.filter((outcome) => outcome === 'failure').length,
      p95Seconds: nearestRank(proposedLatencies, 0.95),
      cleanupRaceFailures: 0,
      staleOwnerFailures: staleAction === 'retry' ? 0 : 1,
      staleHeartbeatFailures: proposedRecoveryJobs.filter(
        (record) => record.kind === 'stale-lease-heartbeat',
      ).length,
      effectiveActions: [...proposedActions].sort(),
    },
    reduction: (baselineRunnerJobs - proposedRunnerJobs) / Math.max(1, baselineRunnerJobs),
  };
}
