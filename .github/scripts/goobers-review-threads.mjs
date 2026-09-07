/**
 * Goobers decision path for the review-thread reply/resolve lane (Phase 3,
 * Lane A of the Goobers migration — see docs/agent-os/personas/devops-engineer.md
 * and docs/runbooks/ci-mutation-bridge-runbook.md).
 *
 * `decideReviewThreadActions` is a pure, side-effect-free reproduction of the
 * two-phase legacy behavior in `.github/scripts/ci-recovery/reconcile.mjs`:
 *
 *   1. Post-outdated-marker pass: an unresolved, outdated thread with no
 *      trusted "✅ Addressed" marker gets a synthetic marker reply queued.
 *   2. Resolve pass: any unresolved thread whose (possibly just-synthesized)
 *      trusted marker names the current head or a reachable ancestor SHA gets
 *      resolved.
 *
 * Legacy mutates the same thread object in place between its two passes, so a
 * thread that receives a phase-1 marker is visible to phase-2's resolve check
 * within the SAME reconcile run (see reconcile.mjs:2358-2368, and the
 * mirrored early-exit path at reconcile.mjs:1901-1909). This function
 * reproduces that exact same-pass promotion by cloning the mutated thread
 * (never touching the caller's input) before running phase 2 over the cloned
 * working set.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  effectiveLatestThreadComment,
  extractAddressedMarkerSha,
  reviewThreadReplyCommentId,
  shouldResolveThread,
  TRUSTED_ASSOCIATIONS,
  TRUSTED_BOT_LOGINS,
} from './ci-recovery/state.mjs';
import { reviewThreadFollowupBacklogIssueNumbers } from './ci-recovery/issue-intake-lib.mjs';

/** Mirrors reconcile.mjs's `shouldAutoPostOutdatedMarker`/early-exit trusted-marker
 *  check: true only when the thread's effective latest comment carries a valid
 *  "✅ Addressed in <sha>" marker AND was authored by a trusted association or bot. */
function hasTrustedAddressedMarker(thread) {
  const last = effectiveLatestThreadComment(thread);
  if (!last) return false;
  return (
    extractAddressedMarkerSha(last.body) !== null &&
    (TRUSTED_ASSOCIATIONS.has(String(last.authorAssociation ?? '').toUpperCase()) ||
      TRUSTED_BOT_LOGINS.has(String(last.author?.login ?? '').toLowerCase()))
  );
}

/** Returns a shallow-cloned thread carrying an appended synthetic marker
 *  comment, matching the shape reconcile.mjs pushes onto `thread.comments.nodes`
 *  (authorAssociation 'OWNER', matching the CRAWLER_CI_PAT's trust level). Never
 *  mutates the input thread. */
function cloneThreadWithSyntheticMarker(thread, markerBody) {
  const existingNodes = thread.comments?.nodes ?? [];
  return {
    ...thread,
    comments: {
      ...thread.comments,
      nodes: [
        ...existingNodes,
        {
          id: `goobers-review-threads-outdated-marker:${thread.id}`,
          body: markerBody,
          url: '',
          author: { login: '' },
          authorAssociation: 'OWNER',
        },
      ],
    },
  };
}

/**
 * @param {object} params
 * @param {Array<object>} params.threads - GraphQL review-thread nodes (same shape
 *   as `listReviewThreads` in ci-recovery/github.mjs).
 * @param {string} params.headSha - Current PR head SHA.
 * @param {Array<string>} [params.reachableCommitShas] - SHAs proven to be
 *   ancestors of headSha (see reconcile.mjs's `reachableMarkerShas`
 *   computation). When provided, the decision layer honors lineage for stale
 *   markers instead of treating the set as unavailable.
 * @param {Array<object>} [params.closingIssues] - same-repo closing issues for
 *   follow-up-backlog classification.
 * @param {string} [params.repository] - repo in `owner/repo` form.
 * @param {Array<object>} [params.followUpIssueMapping] - optional known issue
 *   mapping for source issue numbers to created/reused follow-up issues.
 * @returns {Array<{threadId: string, action: 'post-outdated-marker'|'resolve',
 *   replyCommentId?: string, markerBody?: string, requiresPostedMarker?: boolean,
 *   kind?: string, sourceIssueNumbers?: number[], followUpIssueMapping?: Array<{
 *     sourceIssueNumber: number, issueNumber: number, action: 'created'|'reused' }>}>}
 */
function normalizeIssueMappingEntries(sourceIssueNumbers = [], issueMapping = []) {
  const normalized = [];
  const seen = new Set();
  for (const entry of Array.isArray(issueMapping) ? issueMapping : []) {
    const sourceIssueNumber = Number(entry?.sourceIssueNumber ?? entry?.source ?? entry?.source_issue_number);
    const issueNumber = Number(entry?.issueNumber ?? entry?.followUpIssueNumber ?? entry?.followupIssueNumber ?? entry?.number);
    const action = String(entry?.action || entry?.kind || 'created').toLowerCase();
    if (!Number.isInteger(sourceIssueNumber) || !Number.isInteger(issueNumber)) continue;
    if (!sourceIssueNumbers.includes(sourceIssueNumber)) continue;
    const key = `${sourceIssueNumber}:${issueNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({
      sourceIssueNumber,
      issueNumber,
      action: action === 'reused' ? 'reused' : 'created',
    });
  }
  for (const sourceIssueNumber of sourceIssueNumbers) {
    if (!normalized.some((entry) => entry.sourceIssueNumber === sourceIssueNumber)) {
      normalized.push({
        sourceIssueNumber,
        issueNumber: null,
        action: 'created',
      });
    }
  }
  return normalized;
}

function buildFollowupBacklogMarkerBody({ head, sourceIssueNumbers, issueMapping }) {
  const mapping = Array.isArray(issueMapping) ? issueMapping : [];
  const followupList = mapping
    .filter((entry) => Number.isInteger(entry?.issueNumber) && entry.issueNumber > 0)
    .map((entry) => `#${entry.issueNumber}`);
  const resolvedList = followupList.length > 0 ? followupList : sourceIssueNumbers.map((n) => `#${n}`);
  const sourceList = sourceIssueNumbers.map((n) => `#${n}`).join(', ');
  const followupListText = resolvedList.join(', ');
  return `✅ Addressed in ${head}: filed unassigned follow-up backlog issue ${followupListText} for ${sourceList}.`;
}

export function decideReviewThreadActions({
  threads = [],
  headSha,
  reachableCommitShas = [],
  closingIssues = [],
  repository = '',
  followUpIssueMapping = [],
} = {}) {
  const head = String(headSha ?? '').toLowerCase();
  const reachable = new Set((Array.isArray(reachableCommitShas) ? reachableCommitShas : []).map((sha) => String(sha).toLowerCase()));
  const decisions = [];

  // Phase 1: outdated, unresolved threads with no trusted marker get a
  // synthetic "Addressed" reply queued. A cloned copy of the thread (never the
  // caller's object) carries the in-memory marker forward into phase 2, so a
  // thread promoted here can be resolved within THIS same call — exactly like
  // reconcile.mjs mutating `thread.comments.nodes` in place between its passes.
  const workingThreads = [];
  const syntheticMarkerThreadIds = new Set();
  for (const thread of threads) {
    if (thread.isResolved) {
      workingThreads.push(thread);
      continue;
    }
    if (
      !thread.isOutdated ||
      shouldResolveThread(thread, head, reachable) ||
      hasTrustedAddressedMarker(thread)
    ) {
      workingThreads.push(thread);
      continue;
    }
    const root = thread.comments?.nodes?.[0];
    const replyCommentId = reviewThreadReplyCommentId(root?.url);
    if (!replyCommentId) {
      // No reply target: mirror reconcile.mjs's `skip ... reason=no-reply-target`
      // and leave the thread untouched for phase 2.
      workingThreads.push(thread);
      continue;
    }
    const markerBody = `✅ Addressed in ${head}: thread outdated — reviewed lines no longer present at this location`;
    decisions.push({
      threadId: thread.id,
      action: 'post-outdated-marker',
      replyCommentId,
      markerBody,
    });
    syntheticMarkerThreadIds.add(thread.id);
    workingThreads.push(cloneThreadWithSyntheticMarker(thread, markerBody));
  }

  // Phase 2: resolve any unresolved thread (from the post-phase-1 working set)
  // whose trusted marker names the current head or a reachable ancestor SHA.
  // Follow-up backlog threads are special-cased before the generic resolver: they
  // require a created/reused issue mapping in the decision contract as well as a
  // file/reply/resolve mutation sequence that is fenced against stale live state.
  const repositoryName = String(repository || '').trim();
  const allClosingIssues = Array.isArray(closingIssues) ? closingIssues : [];
  const localClosingIssues = repositoryName
    ? allClosingIssues.filter(
        (issue) => String(issue?.repository?.nameWithOwner || '').toLowerCase() === repositoryName.toLowerCase(),
      )
    : allClosingIssues;

  for (const thread of workingThreads) {
    if (thread.isResolved) continue;
    const sourceIssueNumbers = reviewThreadFollowupBacklogIssueNumbers(
      thread,
      localClosingIssues,
      repositoryName,
    );
    if (sourceIssueNumbers.length > 0) {
      const root = thread.comments?.nodes?.[0];
      const replyCommentId = reviewThreadReplyCommentId(root?.url);
      if (!replyCommentId) continue;
      const issueMapping = normalizeIssueMappingEntries(
        sourceIssueNumbers,
        Array.isArray(followUpIssueMapping) ? followUpIssueMapping : [],
      );
      const backlogDecision = {
        threadId: thread.id,
        action: 'resolve',
        kind: 'follow-up-backlog',
        replyCommentId,
        sourceIssueNumbers,
        followUpIssueMapping: issueMapping,
        issueMapping,
        reachableCommitShas: [...reachable],
        markerBody: buildFollowupBacklogMarkerBody({
          head,
          sourceIssueNumbers,
          issueMapping,
        }),
      };
      decisions.push(backlogDecision);
      continue;
    }
    if (!shouldResolveThread(thread, head, reachable)) continue;
    const resolveDecision = {
      threadId: thread.id,
      action: 'resolve',
      reachableCommitShas: [...reachable],
      ...(syntheticMarkerThreadIds.has(thread.id) ? { requiresPostedMarker: true } : {}),
    };
    decisions.push(resolveDecision);
  }

  return decisions;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (!argv[index].startsWith('--')) continue;
    const key = argv[index].slice(2);
    options[key] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const args = parseArgs(process.argv.slice(2));
  if (typeof args.input !== 'string') throw new Error('--input is required');
  const input = JSON.parse(fs.readFileSync(args.input, 'utf8'));
  const decisions = decideReviewThreadActions(input);
  const outputPath = String(args.output || 'goobers-review-threads-result.json');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify({ decisions }, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ decisionCount: decisions.length })}\n`);
}
