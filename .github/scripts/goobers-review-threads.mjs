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
 *   computation). Pass an empty array to conservatively skip lineage checks,
 *   the same conservative choice reconcile.mjs's own early-exit path makes.
 * @returns {Array<{threadId: string, action: 'post-outdated-marker'|'resolve',
 *   replyCommentId?: string, markerBody?: string, requiresPostedMarker?: boolean}>}
 */
export function decideReviewThreadActions({
  threads = [],
  headSha,
  reachableCommitShas = [],
} = {}) {
  const head = String(headSha ?? '').toLowerCase();
  const reachable = new Set(reachableCommitShas);
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
  for (const thread of workingThreads) {
    if (thread.isResolved) continue;
    if (!shouldResolveThread(thread, head, reachable)) continue;
    decisions.push({
      threadId: thread.id,
      action: 'resolve',
      ...(syntheticMarkerThreadIds.has(thread.id) ? { requiresPostedMarker: true } : {}),
    });
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
