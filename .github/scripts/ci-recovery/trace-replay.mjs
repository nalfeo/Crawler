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
  const recoveryJobs = expandSeries(fixture.recoverySeries).map((record, traceIndex) => ({
    ...record,
    traceIndex,
  }));
  const latencies = expandSeries(fixture.latencyProfileSeconds).map((entry) => entry.value);
  if (latencies.length !== recoveryJobs.length) {
    throw new Error('Trace latency profile must contain one value per Recovery job');
  }

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

  const baselineActions = new Set(recoveryJobs.map(effectiveActionKey));
  const proposedActions = new Set(proposedRecoveryJobs.map(effectiveActionKey));
  const afterOutcomes = proposedRecoveryJobs.map(
    (record) => record.afterOutcome || record.baselineOutcome,
  );
  const proposedLatencies = proposedRecoveryJobs.map((record) => latencies[record.traceIndex]);

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
      p50Seconds: nearestRank(latencies, 0.5),
      p95Seconds: nearestRank(latencies, 0.95),
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
