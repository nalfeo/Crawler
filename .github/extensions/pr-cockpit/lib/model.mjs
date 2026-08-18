import {
  BLOCKED_LABEL,
  CI_CONFLICT_ORDER_WAIT_LABEL,
  QUEUE_LABEL,
  VALIDATION_FAILED_LABEL,
} from '../../../scripts/merge-train/state.mjs';
import {
  OWNER_LABEL_PREFIX,
  WAITING_LABEL,
  WAITING_TRANSITION_LABEL,
} from '../../../scripts/ci-recovery/state.mjs';

const RECOVERY_LABELS = new Set([WAITING_LABEL, WAITING_TRANSITION_LABEL]);
const MERGE_TRAIN_LABELS = new Set([
  QUEUE_LABEL,
  BLOCKED_LABEL,
  CI_CONFLICT_ORDER_WAIT_LABEL,
  VALIDATION_FAILED_LABEL,
]);
const FAILURE_CONCLUSIONS = new Set(['failure', 'timed_out', 'cancelled', 'action_required']);
const REQUIRED_CHECKS = new Set(['ci', 'merge-train']);

function labelNames(pullRequest) {
  return (pullRequest?.labels ?? []).map((label) => String(label?.name ?? '')).filter(Boolean);
}

function normalizeCheck(check) {
  return {
    name: String(check?.name ?? ''),
    status: String(check?.status ?? 'unknown'),
    conclusion: check?.conclusion == null ? null : String(check.conclusion),
    url: check?.html_url ?? check?.details_url ?? check?.url ?? null,
  };
}

function isFailingCheck(check) {
  return check.status === 'completed' && FAILURE_CONCLUSIONS.has(String(check.conclusion ?? ''));
}

function isPendingCheck(check) {
  return check.status !== 'completed';
}

export function normalizePullRequest(raw) {
  const labels = labelNames(raw);
  return {
    number: Number(raw?.number),
    title: String(raw?.title ?? ''),
    url: raw?.html_url ?? raw?.url ?? null,
    state: String(raw?.state ?? 'unknown'),
    draft: Boolean(raw?.draft ?? raw?.isDraft),
    mergeableState: raw?.mergeable_state ?? raw?.mergeStateStatus ?? null,
    mergeable: raw?.mergeable ?? null,
    headRefName: raw?.head?.ref ?? raw?.headRefName ?? null,
    headSha: raw?.head?.sha ?? raw?.headSha ?? raw?.headRefOid ?? null,
    updatedAt: raw?.updated_at ?? raw?.updatedAt ?? null,
    labels,
    ciRecoveryOwner: labels.find((label) => label.startsWith(OWNER_LABEL_PREFIX)) ?? null,
    ciRecoveryState: labels.filter(
      (label) => RECOVERY_LABELS.has(label) || label.startsWith(OWNER_LABEL_PREFIX),
    ),
    mergeTrainState: labels.filter((label) => MERGE_TRAIN_LABELS.has(label)),
  };
}

export function summarizeChecks(checks = []) {
  const normalized = checks.map(normalizeCheck).filter((check) => check.name);
  const required = normalized.filter((check) => REQUIRED_CHECKS.has(check.name));
  const failing = normalized.filter(isFailingCheck);
  const pending = normalized.filter(isPendingCheck);
  return {
    total: normalized.length,
    required,
    failing,
    pending,
    requiredFailing: required.filter(isFailingCheck),
    requiredPending: required.filter(isPendingCheck),
  };
}

export function buildBlockers({ pullRequest, checks = [], unresolvedThreads = 0 } = {}) {
  const pr = normalizePullRequest(pullRequest ?? {});
  const checkSummary = summarizeChecks(checks);
  const blockers = [];

  if (pr.draft) {
    blockers.push({ type: 'draft', severity: 'blocker', message: 'PR is draft.' });
  }
  if (['dirty', 'unknown', 'blocked'].includes(String(pr.mergeableState ?? '').toLowerCase())) {
    blockers.push({
      type: 'mergeability',
      severity: 'blocker',
      message: `Mergeability is ${pr.mergeableState}.`,
    });
  }
  if (unresolvedThreads > 0) {
    blockers.push({
      type: 'review-threads',
      severity: 'blocker',
      message: `${unresolvedThreads} unresolved review thread(s).`,
    });
  }
  for (const check of checkSummary.requiredFailing) {
    blockers.push({
      type: 'required-check',
      severity: 'blocker',
      message: `Required check ${check.name} concluded ${check.conclusion}.`,
      check,
    });
  }
  for (const check of checkSummary.requiredPending) {
    blockers.push({
      type: 'required-check-pending',
      severity: 'waiting',
      message: `Required check ${check.name} is ${check.status}.`,
      check,
    });
  }

  return {
    pullRequest: pr,
    checks: checkSummary,
    unresolvedThreads,
    blockers,
    mergeReady: blockers.length === 0,
    notes: [
      'No human review is required unless gh pr merge explicitly says so.',
      'Cancelled/action_required checks should be diagnosed through the workflow run logs, not gh pr checks alone.',
    ],
  };
}

export function summarizePullRequests(rawPullRequests = []) {
  return rawPullRequests.map((pullRequest) => normalizePullRequest(pullRequest));
}
