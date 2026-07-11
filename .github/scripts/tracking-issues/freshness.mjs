export async function getWorkflowRunFreshness({ github, context }) {
  const { owner, repo } = context.repo;
  const { data: currentRun } = await github.rest.actions.getWorkflowRun({
    owner,
    repo,
    run_id: context.runId,
  });

  const workflowRuns = await github.paginate(github.rest.actions.listWorkflowRuns, {
    owner,
    repo,
    workflow_id: currentRun.workflow_id,
    ...(currentRun.head_branch ? { branch: currentRun.head_branch } : {}),
    per_page: 100,
  });

  const newerRun =
    workflowRuns.find(
      (run) =>
        run.id !== currentRun.id &&
        run.run_number > currentRun.run_number &&
        run.head_branch === currentRun.head_branch,
    ) ?? null;

  return {
    currentRun,
    newerRun,
    isLatest: newerRun === null,
  };
}
