import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { graphql, listClosingIssues, paginate, request } from './ci-recovery/github.mjs';
import {
  addIssueAssignees,
  buildIssueActorIds,
  getCopilotIssueAssignmentContext,
  isCopilotLogin,
  removeIssueAssignees,
} from './ci-recovery/issue-intake-lib.mjs';
import { requiresHumanApproval } from './merge-train/human-approval.mjs';

const READY_FOR_REVIEW_MUTATION = `
  mutation MarkPullRequestReadyForReview($pullRequestId: ID!) {
    markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) {
      pullRequest {
        number
      }
    }
  }
`;

export const COPILOT_CLOUD_AGENT_WORKFLOW_PATH = 'dynamic/copilot-swe-agent/copilot';
export const COPILOT_CLOUD_AGENT_WORKFLOW_ID = 288998107;
export const EMPTY_DRAFT_REPAIR_GRACE_MS = 5 * 60 * 1000;
export const EMPTY_DRAFT_REPAIR_LABEL = 'copilot-empty-draft-repaired';
export const EMPTY_DRAFT_REPEAT_TRIAGE_LABEL = 'copilot-empty-draft-repeat-triage';
const WORKFLOW_RUNS_PAGE_SIZE = 100;
const WORKFLOW_RUNS_MAX_PAGES = 10;

function normalize(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

function trimRef(value) {
  return String(value ?? '').trim();
}

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function parseIsoDate(value) {
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? new Date(parsed) : null;
}

function completedAtForRun(run) {
  return parseIsoDate(run?.updated_at);
}

function sameRepository(fullName, repository) {
  return normalize(fullName) === normalize(repository);
}

export async function listCopilotCloudWorkflowRuns({
  requestFn,
  token,
  owner,
  repo,
  headBranch,
  maxPages = WORKFLOW_RUNS_MAX_PAGES,
}) {
  const workflowId = encodeURIComponent(COPILOT_CLOUD_AGENT_WORKFLOW_ID);
  const encodedBranch = encodeURIComponent(headBranch);
  const runs = [];

  for (let page = 1; page <= maxPages; page += 1) {
    const path =
      `/repos/${owner}/${repo}/actions/workflows/${workflowId}/runs` +
      `?branch=${encodedBranch}&per_page=${WORKFLOW_RUNS_PAGE_SIZE}&page=${page}`;
    const response = await requestFn(token, path);
    const pageRuns = Array.isArray(response?.data?.workflow_runs)
      ? response.data.workflow_runs
      : [];
    runs.push(...pageRuns);
    if (pageRuns.length < WORKFLOW_RUNS_PAGE_SIZE) {
      break;
    }
  }

  return runs;
}

export function changedFileRetryDelaysMs({
  eventName,
  payloadAction,
  triggeringPullNumber,
  prNumber,
}) {
  const isFreshSynchronize =
    eventName === 'pull_request_target' &&
    payloadAction === 'synchronize' &&
    Number(triggeringPullNumber) === Number(prNumber);
  return isFreshSynchronize ? [0, 1000, 2000] : [0];
}

export function matchingCopilotCloudRunRejection({ run, repository, headSha, headBranch }) {
  if (run?.path != null && run.path !== COPILOT_CLOUD_AGENT_WORKFLOW_PATH) return 'workflow-path';
  if (
    run?.workflow_id != null &&
    Number(run.workflow_id) !== Number(COPILOT_CLOUD_AGENT_WORKFLOW_ID)
  )
    return 'workflow-id';
  if (run?.repository?.full_name != null && !sameRepository(run.repository.full_name, repository))
    return 'run-repository';
  if (
    run?.head_repository?.full_name != null &&
    !sameRepository(run.head_repository.full_name, repository)
  )
    return 'run-head-repository';
  if (normalize(run?.head_sha) !== normalize(headSha)) return 'head-sha';
  if (trimRef(run?.head_branch) !== trimRef(headBranch)) return 'head-branch';
  if (!isCopilotLogin(run?.actor?.login)) return 'actor';
  if (run?.triggering_actor && !isCopilotLogin(run?.triggering_actor?.login)) {
    return 'triggering-actor';
  }
  return null;
}

export function latestMatchingCopilotCloudRun({ runs, repository, headSha, headBranch }) {
  return [...(runs || [])]
    .filter(
      (run) =>
        !matchingCopilotCloudRunRejection({
          run,
          repository,
          headSha,
          headBranch,
        }),
    )
    .sort((left, right) => {
      const rightUpdated = Date.parse(String(right?.updated_at ?? '')) || 0;
      const leftUpdated = Date.parse(String(left?.updated_at ?? '')) || 0;
      if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;
      const rightCreated = Date.parse(String(right?.created_at ?? '')) || 0;
      const leftCreated = Date.parse(String(left?.created_at ?? '')) || 0;
      if (rightCreated !== leftCreated) return rightCreated - leftCreated;
      return Number(right?.id || 0) - Number(left?.id || 0);
    })[0];
}

function localEmptyCopilotDraftRepairRejection({ pr, changedFiles, repository }) {
  if (normalize(pr?.state) !== 'open') return 'not-open';
  if (pr?.draft !== true) return 'not-draft';
  if (!sameRepository(pr?.head?.repo?.full_name, repository)) return 'fork';
  const labels = Array.isArray(pr?.labels) ? pr.labels : [];
  if (labels.some((label) => normalize(label?.name) === normalize(EMPTY_DRAFT_REPAIR_LABEL))) {
    return 'already-repaired';
  }
  if (Number(changedFiles) !== 0) {
    return `changed-files=${Number(changedFiles) || 0}`;
  }
  if (!isCopilotLogin(pr?.user?.login)) {
    return `author=${String(pr?.user?.login || 'unknown')}`;
  }
  return null;
}

function issueHasLabel(issue, labelName) {
  const labels = Array.isArray(issue?.labels?.nodes)
    ? issue.labels.nodes
    : Array.isArray(issue?.labels)
      ? issue.labels
      : [];
  return labels.some((label) => normalize(label?.name) === normalize(labelName));
}

export function inspectEmptyCopilotDraftRepair({
  pr,
  changedFiles,
  linkedIssues,
  runs,
  repository,
  now = new Date(),
  graceMs = EMPTY_DRAFT_REPAIR_GRACE_MS,
  expectedIssueId = null,
}) {
  const localRejection = localEmptyCopilotDraftRepairRejection({
    pr,
    changedFiles,
    repository,
  });
  if (localRejection) {
    return {
      eligible: false,
      reason: localRejection,
    };
  }

  const allReferences = Array.isArray(linkedIssues) ? linkedIssues : [];
  const references = allReferences.filter((issue) =>
    sameRepository(issue?.repository?.nameWithOwner, repository),
  );
  if (references.length !== 1) {
    return { eligible: false, reason: `linked-issue-count=${references.length}` };
  }
  const [linkedIssue] = references;
  if (normalize(linkedIssue?.state) !== 'open') {
    return {
      eligible: false,
      reason: `linked-issue-state=${String(linkedIssue?.state || 'unknown')}`,
    };
  }
  if (expectedIssueId !== null && String(linkedIssue?.id || '') !== String(expectedIssueId)) {
    return {
      eligible: false,
      reason: `linked-issue-changed=${String(linkedIssue?.number || 'unknown')}`,
    };
  }

  const latestRun = latestMatchingCopilotCloudRun({
    runs,
    repository,
    headSha: pr?.head?.sha,
    headBranch: pr?.head?.ref,
  });
  if (!latestRun) {
    return { eligible: false, reason: 'no-matching-copilot-cloud-run' };
  }
  if (normalize(latestRun?.status) !== 'completed') {
    return {
      eligible: false,
      reason: `copilot-cloud-run-status=${String(latestRun?.status || 'unknown')}`,
    };
  }
  const completedAt = completedAtForRun(latestRun);
  if (!completedAt) {
    return { eligible: false, reason: 'copilot-cloud-run-completed-at' };
  }
  const ageMs = now.getTime() - completedAt.getTime();
  if (ageMs < graceMs) {
    return {
      eligible: false,
      reason: `copilot-cloud-run-grace=${graceMs - ageMs}`,
    };
  }
  return {
    eligible: true,
    linkedIssue,
    latestRun,
    repeatRepair:
      issueHasLabel(linkedIssue, EMPTY_DRAFT_REPAIR_LABEL) ||
      issueHasLabel(linkedIssue, EMPTY_DRAFT_REPEAT_TRIAGE_LABEL),
  };
}

async function changedFilesForDraft({
  api,
  prNumber,
  eventName,
  payloadAction,
  triggeringPullNumber,
}) {
  const delaysMs = changedFileRetryDelaysMs({
    eventName,
    payloadAction,
    triggeringPullNumber,
    prNumber,
  });
  let changedFiles = 0;

  for (const delayMs of delaysMs) {
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const details = await api.getPull(prNumber);
    const rawChangedFiles = details?.changed_files;
    if (rawChangedFiles == null) {
      throw new Error(`changed_files absent in PR response`);
    }
    const numChangedFiles = Number(rawChangedFiles);
    if (!Number.isFinite(numChangedFiles) || numChangedFiles < 0) {
      throw new Error(`changed_files invalid in PR response (${rawChangedFiles})`);
    }
    changedFiles = numChangedFiles;
    if (changedFiles > 0) {
      break;
    }
  }

  return changedFiles;
}

async function requestHumanReviewerIfRequired({ api, pr, prNumber, reviewerLogin, log }) {
  if (requiresHumanApproval(pr)) {
    return requestHumanReviewer({ api, pr, prNumber, reviewerLogin, log });
  }
  const closingIssues = await api.listClosingIssues(prNumber);
  if (!requiresHumanApproval(pr, closingIssues)) {
    return false;
  }
  return requestHumanReviewer({ api, pr, prNumber, reviewerLogin, log });
}

async function requestHumanReviewer({ api, pr, prNumber, reviewerLogin, log }) {
  if (normalize(pr.user?.login) === normalize(reviewerLogin)) {
    return false;
  }
  const requestedReviewers = pr.requested_reviewers ?? [];
  if (
    requestedReviewers.some((reviewer) => normalize(reviewer.login) === normalize(reviewerLogin))
  ) {
    return false;
  }
  await api.requestReviewer(prNumber, reviewerLogin);
  log.info(`Requested @${reviewerLogin} to review human-gated PR #${prNumber}.`);
  return true;
}

async function repairEmptyCopilotDraft({ api, repository, pr, changedFiles, log, now, graceMs }) {
  const localRejection = localEmptyCopilotDraftRepairRejection({
    pr,
    changedFiles,
    repository,
  });
  if (localRejection) {
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${localRejection}`);
    return { status: 'skipped', reason: localRejection };
  }

  const linkedIssues = await api.listClosingIssues(pr.number);
  const runs = await api.listWorkflowRuns(pr.head.sha, pr.head.ref);
  const initialDecision = inspectEmptyCopilotDraftRepair({
    pr,
    changedFiles,
    linkedIssues,
    runs,
    repository,
    now,
    graceMs,
  });

  if (!initialDecision.eligible) {
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${initialDecision.reason}`);
    return { status: 'skipped', reason: initialDecision.reason };
  }

  const currentPr = await api.getPull(pr.number);
  if (normalize(currentPr?.head?.sha) !== normalize(pr.head.sha)) {
    const reason = `head-sha-changed=${String(currentPr?.head?.sha || 'unknown')}`;
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${reason}`);
    return { status: 'skipped', reason };
  }
  if (trimRef(currentPr?.head?.ref) !== trimRef(pr.head.ref)) {
    const reason = `head-branch-changed=${String(currentPr?.head?.ref || 'unknown')}`;
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${reason}`);
    return { status: 'skipped', reason };
  }

  const currentLinkedIssues = await api.listClosingIssues(pr.number);
  const currentRuns = await api.listWorkflowRuns(currentPr.head.sha, currentPr.head.ref);

  const rawConfirmedFiles = currentPr?.changed_files;
  if (rawConfirmedFiles == null) {
    const reason = 'confirmed-changed-files-absent';
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${reason}`);
    return { status: 'skipped', reason };
  }
  const numConfirmedFiles = Number(rawConfirmedFiles);
  if (!Number.isFinite(numConfirmedFiles) || numConfirmedFiles < 0) {
    const reason = `confirmed-changed-files-invalid=${String(rawConfirmedFiles)}`;
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${reason}`);
    return { status: 'skipped', reason };
  }

  const confirmedDecision = inspectEmptyCopilotDraftRepair({
    pr: currentPr,
    changedFiles: numConfirmedFiles,
    linkedIssues: currentLinkedIssues,
    runs: currentRuns,
    repository,
    now,
    graceMs,
    expectedIssueId: initialDecision.linkedIssue.id,
  });

  if (!confirmedDecision.eligible) {
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${confirmedDecision.reason}`);
    return { status: 'skipped', reason: confirmedDecision.reason };
  }

  const assignmentContext = await api.getCopilotIssueAssignmentContext(
    confirmedDecision.linkedIssue.number,
  );
  if (normalize(assignmentContext.issueState) !== 'open') {
    const reason = `linked-issue-state-changed=${String(assignmentContext.issueState || 'unknown')}`;
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${reason}`);
    return { status: 'skipped', reason };
  }
  if (!assignmentContext.assignees.some((assignee) => isCopilotLogin(assignee?.login))) {
    const reason = 'linked-issue-copilot-assignee-missing';
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${reason}`);
    return { status: 'skipped', reason };
  }

  const actorIdsWithoutCopilot = buildIssueActorIds({
    assignees: assignmentContext.assignees,
    copilotActorId: assignmentContext.copilot.id,
    includeCopilot: false,
  });
  const copilotActorIds = buildIssueActorIds({
    assignees: assignmentContext.assignees,
    copilotActorId: assignmentContext.copilot.id,
    includeCopilot: true,
  }).filter((id) => !actorIdsWithoutCopilot.includes(id));
  const linkedIssueNumber = confirmedDecision.linkedIssue.number;

  // Apply a durable repair marker label before closing so any subsequent scan
  // (including after a reopen event) skips this PR without repeating the repair.
  // The marker is best-effort: failure is logged but does not block the repair.
  let labelApplied = false;
  try {
    await api.addPrLabel(pr.number, EMPTY_DRAFT_REPAIR_LABEL);
    labelApplied = true;
  } catch (labelError) {
    const warn = log.warning ?? log.warn ?? log.info;
    warn?.call(
      log,
      `Could not add repair marker label to PR #${pr.number}: ${getErrorMessage(labelError)}`,
    );
  }

  let closeApplied = false;
  let closeRequestError = null;

  // Helper: rollback of a committed close by reopening and removing the repair label.
  // Collect rollback failures so reopen failures are surfaced (instead of silently
  // returning skipped with the PR still closed) while still attempting label cleanup.
  const rollbackClose = async () => {
    const rollbackErrors = [];
    if (closeApplied) {
      try {
        await api.updatePullState(pr.number, 'open');
      } catch (rollbackError) {
        rollbackErrors.push(new Error(`PR reopen failed: ${getErrorMessage(rollbackError)}`));
      }
    }
    if (labelApplied) {
      try {
        await api.removePrLabel(pr.number, EMPTY_DRAFT_REPAIR_LABEL);
      } catch (rollbackError) {
        rollbackErrors.push(new Error(`label cleanup failed: ${getErrorMessage(rollbackError)}`));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        rollbackErrors,
        `post-close rollback failed for PR #${pr.number}: ${rollbackErrors.map(getErrorMessage).join('; ')}`,
      );
    }
  };

  try {
    await api.updatePullState(pr.number, 'closed');
    closeApplied = true;
  } catch (error) {
    closeRequestError = error;
    try {
      const observedPull = await api.getPull(pr.number);
      if (normalize(observedPull?.state) === 'closed') {
        closeApplied = true;
      } else {
        throw error;
      }
    } catch (observationError) {
      // The close did not apply: remove the repair label before surfacing the failure
      // so future scans are not permanently blocked by a stuck marker on an open PR.
      if (labelApplied) {
        try {
          await api.removePrLabel(pr.number, EMPTY_DRAFT_REPAIR_LABEL);
        } catch (_) {
          /* best-effort: suppress even non-404 since we are already in a definite failure path */
        }
      }
      const observationMessage = getErrorMessage(observationError);
      throw new Error(
        `close operation failed for PR #${pr.number}: ${getErrorMessage(error)} (observation: ${observationMessage})`,
      );
    }
  }

  // Post-close drift verification: re-read the PR to confirm no concurrent push
  // changed the head SHA or made the PR non-empty in the race window between
  // our final eligibility confirmation and the actual close.
  let postCloseVerification;
  try {
    postCloseVerification = await api.getPull(pr.number);
  } catch (verifyError) {
    await rollbackClose();
    throw new Error(
      `post-close verification failed for PR #${pr.number}: ${getErrorMessage(verifyError)}`,
    );
  }
  const postCloseFiles = postCloseVerification?.changed_files;
  const postCloseNum = Number(postCloseFiles);
  if (postCloseFiles == null || !Number.isFinite(postCloseNum) || postCloseNum > 0) {
    const driftReason =
      postCloseFiles == null || !Number.isFinite(postCloseNum)
        ? 'post-close-changed-files-invalid'
        : `post-close-drift-files=${postCloseNum}`;
    await rollbackClose();
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${driftReason}`);
    return { status: 'skipped', reason: driftReason };
  }
  if (normalize(postCloseVerification?.head?.sha) !== normalize(pr.head.sha)) {
    const driftReason = `post-close-drift-sha=${String(postCloseVerification?.head?.sha || 'unknown')}`;
    await rollbackClose();
    log.info(`skip empty-draft repair pr=#${pr.number} reason=${driftReason}`);
    return { status: 'skipped', reason: driftReason };
  }

  if (confirmedDecision.repeatRepair) {
    // Apply the reversible mutations (triage label, Copilot removal) first and keep the
    // irreversible issue comment as the final side effect, so any failure can be fully
    // rolled back without leaving the triage label (which itself drives `repeatRepair`)
    // stuck on the issue.
    let triageLabelApplied = false;
    try {
      await api.addIssueLabel(linkedIssueNumber, EMPTY_DRAFT_REPEAT_TRIAGE_LABEL);
      triageLabelApplied = true;
      const removedLogins = await api.removeIssueAssignees(
        assignmentContext.issueId,
        copilotActorIds,
      );
      if (removedLogins.some((login) => isCopilotLogin(login))) {
        throw new Error(
          `Copilot removal did not persist on repeat empty-draft issue #${linkedIssueNumber}`,
        );
      }
      await api.addIssueComment(
        linkedIssueNumber,
        [
          `Empty Copilot draft repair has already been attempted for this issue, so PR #${pr.number} was closed without reassigning Copilot again.`,
          '',
          'Please clarify or triage the issue before starting another Copilot run.',
        ].join('\n'),
      );
    } catch (repairError) {
      const rollbackErrors = [];
      try {
        const restoredLogins = await api.addIssueAssignees(
          assignmentContext.issueId,
          copilotActorIds,
        );
        if (!restoredLogins.some((login) => isCopilotLogin(login))) {
          throw new Error(
            `Copilot assignment did not persist during repeat-repair rollback on issue #${linkedIssueNumber}`,
          );
        }
      } catch (rollbackError) {
        rollbackErrors.push(new Error(`issue rollback failed: ${getErrorMessage(rollbackError)}`));
      }
      if (triageLabelApplied) {
        try {
          await api.removeIssueLabel(linkedIssueNumber, EMPTY_DRAFT_REPEAT_TRIAGE_LABEL);
        } catch (rollbackError) {
          rollbackErrors.push(
            new Error(`issue triage label cleanup failed: ${getErrorMessage(rollbackError)}`),
          );
        }
      }
      if (closeApplied) {
        try {
          await api.updatePullState(pr.number, 'open');
        } catch (rollbackError) {
          rollbackErrors.push(new Error(`PR reopen failed: ${getErrorMessage(rollbackError)}`));
        }
      }
      if (labelApplied) {
        try {
          await api.removePrLabel(pr.number, EMPTY_DRAFT_REPAIR_LABEL);
        } catch (rollbackError) {
          rollbackErrors.push(new Error(`label cleanup failed: ${getErrorMessage(rollbackError)}`));
        }
      }
      if (rollbackErrors.length > 0) {
        throw new AggregateError(
          [repairError, ...rollbackErrors],
          `repeat repair failed for PR #${pr.number}: ${getErrorMessage(repairError)}; rollback also failed: ${rollbackErrors.map(getErrorMessage).join('; ')}`,
          { cause: repairError },
        );
      }
      throw repairError;
    }

    log.info(
      `Escalated repeat empty Copilot draft PR #${pr.number}: closed shell, removed Copilot from linked issue #${linkedIssueNumber}, cloud run ${confirmedDecision.latestRun.id}.`,
    );
    return {
      status: 'repaired',
      issueNumber: linkedIssueNumber,
      runId: confirmedDecision.latestRun.id,
      repeatRepair: true,
    };
  }

  try {
    const removedLogins = await api.removeIssueAssignees(
      assignmentContext.issueId,
      copilotActorIds,
    );
    if (removedLogins.some((login) => isCopilotLogin(login))) {
      throw new Error(
        `Copilot removal did not persist on linked issue #${confirmedDecision.linkedIssue.number}`,
      );
    }

    const reassignedLogins = await api.addIssueAssignees(
      assignmentContext.issueId,
      copilotActorIds,
    );
    if (!reassignedLogins.some((login) => isCopilotLogin(login))) {
      throw new Error(
        `Copilot reassignment did not persist on linked issue #${confirmedDecision.linkedIssue.number}`,
      );
    }
    await api.addIssueLabel(linkedIssueNumber, EMPTY_DRAFT_REPAIR_LABEL);
  } catch (repairError) {
    const rollbackErrors = [];
    try {
      const restoredLogins = await api.addIssueAssignees(
        assignmentContext.issueId,
        copilotActorIds,
      );
      if (!restoredLogins.some((login) => isCopilotLogin(login))) {
        throw new Error(
          `Copilot assignment did not persist during rollback on issue #${confirmedDecision.linkedIssue.number}`,
        );
      }
    } catch (rollbackError) {
      rollbackErrors.push(new Error(`issue rollback failed: ${getErrorMessage(rollbackError)}`));
    }
    if (closeApplied) {
      try {
        await api.updatePullState(pr.number, 'open');
      } catch (rollbackError) {
        rollbackErrors.push(new Error(`PR reopen failed: ${getErrorMessage(rollbackError)}`));
      }
    }
    if (labelApplied) {
      try {
        await api.removePrLabel(pr.number, EMPTY_DRAFT_REPAIR_LABEL);
      } catch (rollbackError) {
        rollbackErrors.push(new Error(`label cleanup failed: ${getErrorMessage(rollbackError)}`));
      }
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [repairError, ...rollbackErrors],
        `repair failed for PR #${pr.number}: ${getErrorMessage(repairError)}; rollback also failed: ${rollbackErrors.map(getErrorMessage).join('; ')}`,
        { cause: repairError },
      );
    }

    if (closeRequestError) {
      log.info(
        `close request for PR #${pr.number} errored but close state was confirmed; continuing repair flow.`,
      );
    }
    throw repairError;
  }

  log.info(
    `Repaired empty Copilot draft PR #${pr.number}: closed shell, restarted linked issue #${linkedIssueNumber}, cloud run ${confirmedDecision.latestRun.id}.`,
  );
  return {
    status: 'repaired',
    issueNumber: linkedIssueNumber,
    runId: confirmedDecision.latestRun.id,
  };
}

function parseRepository(fullName) {
  const [owner, repo] = String(fullName || '').split('/');
  if (!owner || !repo) {
    throw new Error('GITHUB_REPOSITORY must be set to owner/repo');
  }
  return { owner, repo };
}

function createApi({ token, owner, repo }) {
  const addIssueLabel = async (issueNumber, labelName) => {
    try {
      await request(token, `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
        method: 'POST',
        body: { labels: [labelName] },
      });
    } catch (addError) {
      if (addError?.status === 422) {
        await request(token, `/repos/${owner}/${repo}/labels`, {
          method: 'POST',
          body: { name: labelName, color: 'e4e669' },
        }).catch(() => {});
        await request(token, `/repos/${owner}/${repo}/issues/${issueNumber}/labels`, {
          method: 'POST',
          body: { labels: [labelName] },
        });
      } else {
        throw addError;
      }
    }
  };

  const removeIssueLabel = async (issueNumber, labelName) => {
    try {
      await request(
        token,
        `/repos/${owner}/${repo}/issues/${issueNumber}/labels/${encodeURIComponent(labelName)}`,
        { method: 'DELETE' },
      );
    } catch (removeError) {
      if (removeError?.status !== 404) {
        throw removeError;
      }
    }
  };

  return {
    listOpenPulls: () => paginate(token, `/repos/${owner}/${repo}/pulls?state=open&per_page=100`),
    getPull: async (pullNumber) =>
      (await request(token, `/repos/${owner}/${repo}/pulls/${pullNumber}`)).data,
    markReadyForReview: async (pullRequestId) =>
      graphql(token, READY_FOR_REVIEW_MUTATION, { pullRequestId }),
    requestReviewer: async (pullNumber, reviewerLogin) =>
      request(token, `/repos/${owner}/${repo}/pulls/${pullNumber}/requested_reviewers`, {
        method: 'POST',
        body: { reviewers: [reviewerLogin] },
      }),
    listClosingIssues: (pullNumber) => listClosingIssues(token, owner, repo, pullNumber),
    listWorkflowRuns: async (_headSha, headBranch) =>
      listCopilotCloudWorkflowRuns({
        requestFn: request,
        token,
        owner,
        repo,
        headBranch,
      }),
    updatePullState: async (pullNumber, state) =>
      (
        await request(token, `/repos/${owner}/${repo}/pulls/${pullNumber}`, {
          method: 'PATCH',
          body: { state },
        })
      ).data,
    getCopilotIssueAssignmentContext: (issueNumber) =>
      getCopilotIssueAssignmentContext({
        graphql,
        token,
        owner,
        repo,
        issueNumber,
      }),
    addIssueAssignees: (assignableId, actorIds) =>
      addIssueAssignees({
        graphql,
        token,
        assignableId,
        actorIds,
      }),
    removeIssueAssignees: (assignableId, actorIds) =>
      removeIssueAssignees({
        graphql,
        token,
        assignableId,
        actorIds,
      }),
    addPrLabel: (pullNumber, labelName) => addIssueLabel(pullNumber, labelName),
    addIssueLabel,
    addIssueComment: async (issueNumber, body) =>
      request(token, `/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
        method: 'POST',
        body: { body },
      }),
    removePrLabel: removeIssueLabel,
    removeIssueLabel,
  };
}

export async function runPrReadyReviewerGuard({
  repository,
  reviewerLoginRaw,
  eventName,
  payloadAction,
  triggeringPullNumber,
  api,
  log = console,
  now = new Date(),
  graceMs = EMPTY_DRAFT_REPAIR_GRACE_MS,
}) {
  const reviewerLogin = String(reviewerLoginRaw || '')
    .trim()
    .toLowerCase();
  if (!reviewerLogin) {
    throw new Error('REVIEWER_LOGIN is required');
  }

  const isEventScopedRun = eventName === 'pull_request_target';
  let openPrs;
  if (isEventScopedRun) {
    const prNumber = Number(triggeringPullNumber);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      log.warning?.(
        `Skipping event-scoped PR guard run: invalid triggering pull request number (${String(
          triggeringPullNumber ?? '',
        )})`,
      );
      return { draftsPublished: 0, emptyDraftRepairs: 0, humanReviewerRequests: 0 };
    }
    const pull = await api.getPull(prNumber);
    openPrs = String(pull?.state || '').toLowerCase() === 'open' ? [pull] : [];
  } else {
    openPrs = await api.listOpenPulls();
  }
  if (openPrs.length === 0) {
    log.info('No open PRs found.');
    return { draftsPublished: 0, emptyDraftRepairs: 0, humanReviewerRequests: 0 };
  }
  let draftsPublished = 0;
  let emptyDraftRepairs = 0;
  let humanReviewerRequests = 0;
  const publishFailures = [];
  const repairFailures = [];
  const reviewerRequestFailures = [];

  for (const pr of openPrs) {
    const prNumber = pr.number;
    let closedByRepair = false;
    let attemptedRepair = false;

    if (pr.draft) {
      try {
        const changedFiles = await changedFilesForDraft({
          api,
          prNumber,
          eventName,
          payloadAction,
          triggeringPullNumber,
        });
        if (changedFiles === 0) {
          attemptedRepair = true;
          const repairResult = await repairEmptyCopilotDraft({
            api,
            repository,
            pr,
            changedFiles,
            log,
            now,
            graceMs,
          });
          if (repairResult.status === 'repaired') {
            emptyDraftRepairs += 1;
            closedByRepair = true;
          }
        } else {
          log.info(`skip empty-draft repair pr=#${prNumber} reason=changed-files=${changedFiles}`);
          await api.markReadyForReview(pr.node_id);
          draftsPublished += 1;
          log.info(
            `Marked PR #${prNumber} as ready for review with ${changedFiles} changed file(s).`,
          );
        }
      } catch (error) {
        // Rate-limit errors (403 "API rate limit exceeded") are transient — the
        // workflow is a cron/sweep that will retry on its next scheduled run.
        // Treat them as skips so a temporary quota exhaustion does not fail the
        // entire job and trigger a false-positive repair-failure alert.
        const isRateLimit =
          error?.status === 403 &&
          String(error?.data?.message ?? error?.message ?? '')
            .toLowerCase()
            .includes('rate limit');
        if (isRateLimit) {
          log.warn(`skip pr=#${prNumber} reason=rate-limit: ${getErrorMessage(error)}`);
        } else {
          const prError = `PR #${prNumber}: ${getErrorMessage(error)}`;
          if (attemptedRepair) {
            repairFailures.push(new Error(prError, { cause: error }));
            log.error(
              `Could not repair empty Copilot draft PR #${prNumber}: ${getErrorMessage(error)}`,
            );
          } else {
            publishFailures.push(new Error(prError, { cause: error }));
            log.error(`Could not mark PR #${prNumber} ready: ${getErrorMessage(error)}`);
          }
        }
      }
    } else {
      log.info(`skip empty-draft repair pr=#${prNumber} reason=not-draft`);
    }

    if (closedByRepair) {
      continue;
    }

    if (!pr.draft) {
      try {
        humanReviewerRequests += Number(
          await requestHumanReviewerIfRequired({
            api,
            pr,
            prNumber,
            reviewerLogin,
            log,
          }),
        );
      } catch (error) {
        const prError = `PR #${prNumber}: ${getErrorMessage(error)}`;
        reviewerRequestFailures.push(new Error(prError, { cause: error }));
        log.error(
          `Could not request human reviewer for PR #${prNumber}: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  log.info(
    `Done. Drafts published: ${draftsPublished}. Empty draft repairs: ${emptyDraftRepairs}. Human reviewer requests: ${humanReviewerRequests}.`,
  );

  if (
    publishFailures.length > 0 ||
    repairFailures.length > 0 ||
    reviewerRequestFailures.length > 0
  ) {
    const failureLines = [
      ...(publishFailures.length > 0
        ? [
            `Failed to publish ${publishFailures.length} draft PR(s):`,
            ...publishFailures.map((failure) => failure.message),
          ]
        : []),
      ...(repairFailures.length > 0
        ? [
            `Failed to repair ${repairFailures.length} empty Copilot draft PR shell(s):`,
            ...repairFailures.map((failure) => failure.message),
          ]
        : []),
      ...(reviewerRequestFailures.length > 0
        ? [
            `Failed to request a human reviewer for ${reviewerRequestFailures.length} PR(s):`,
            ...reviewerRequestFailures.map((failure) => failure.message),
          ]
        : []),
    ];
    throw new AggregateError(
      [...publishFailures, ...repairFailures, ...reviewerRequestFailures],
      failureLines.join('\n'),
    );
  }

  return { draftsPublished, emptyDraftRepairs, humanReviewerRequests };
}

async function main() {
  const token = String(process.env.CRAWLER_CI_PAT || '').trim();
  if (!token) {
    throw new Error('CRAWLER_CI_PAT is required');
  }
  const repository = String(process.env.GITHUB_REPOSITORY || '').trim();
  const { owner, repo } = parseRepository(repository);
  const eventName = String(process.env.GITHUB_EVENT_NAME || '');
  const payload = process.env.GITHUB_EVENT_PATH
    ? JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'))
    : {};
  const logger = {
    info: (message) => process.stdout.write(`${message}\n`),
    warning: (message) => process.stderr.write(`${message}\n`),
    error: (message) => process.stderr.write(`${message}\n`),
  };
  await runPrReadyReviewerGuard({
    repository,
    reviewerLoginRaw: process.env.REVIEWER_LOGIN,
    eventName,
    payloadAction: payload?.action,
    triggeringPullNumber: payload?.pull_request?.number,
    api: createApi({ token, owner, repo }),
    log: logger,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
