function safeRun(run) {
  if (!run) return null;
  return {
    id: run.id,
    status: run.status,
    conclusion: run.conclusion,
    headBranch: run.headBranch,
    headSha: run.headSha,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    url: run.url,
    event: run.event,
    attempt: run.attempt,
    workflowType: run.workflowType ?? null,
  };
}

function safeLocalRun(run) {
  if (!run) return null;
  return {
    path: run.path,
    name: run.name,
    runAt: run.runAt,
    modifiedAt: run.modifiedAt,
    floors: run.floors,
  };
}

function safeRepositoryBranch(branch) {
  if (!branch) return null;
  return { name: branch.name, ref: branch.ref, local: branch.local };
}

function safeRepositoryArtifact(artifact) {
  if (!artifact) return null;
  return {
    path: artifact.path,
    name: artifact.name,
    kind: artifact.kind,
    generatedAt: artifact.generatedAt,
    commit: artifact.commit ?? null,
    winRate: artifact.winRate ?? null,
    totalWins: artifact.totalWins ?? null,
    totalRuns: artifact.totalRuns ?? null,
  };
}

function stateSnapshot(state, pollIntervalMs) {
  return {
    source: state.source,
    path: state.source === 'local' ? state.path : null,
    localDirectory: state.localDirectory,
    localRuns: state.localRuns.map(safeLocalRun),
    localErrors: state.localErrors,
    selectedLocalPath: state.selectedLocalPath,
    repositoryBranches: (state.repositoryBranches ?? []).map(safeRepositoryBranch),
    selectedRepositoryBranch: safeRepositoryBranch(state.selectedRepositoryBranch),
    repositoryArtifacts: (state.repositoryArtifacts ?? []).map(safeRepositoryArtifact),
    repositoryErrors: state.repositoryErrors ?? [],
    selectedRepositoryPath: state.selectedRepositoryPath ?? null,
    repository: state.context?.repository ?? null,
    branch: state.context?.branch ?? null,
    sessionId: state.sessionId,
    runs: state.runs.map(safeRun),
    selectedRun: safeRun(state.selectedRun),
    selectionReason: state.selectionReason,
    workflowType: state.repositoryArtifactKind ?? state.selectedRun?.workflowType ?? null,
    expectedWeapons: state.expectedWeapons,
    availableWeapons: state.availableWeapons,
    expiredArtifactCount: state.expiredArtifactCount,
    jobPhases: state.jobPhases,
    pollIntervalMs,
    polling: Boolean(state.pollTimer),
    refreshing: state.refreshing,
    error: state.error,
    warning: state.warning,
    loadedAt: state.loadedAt,
    lastRefreshedAt: state.lastRefreshedAt,
    data: state.data,
  };
}

export { safeLocalRun, safeRepositoryArtifact, safeRepositoryBranch, safeRun, stateSnapshot };
