import assert from 'node:assert/strict';
import test from 'node:test';

import { decideReviewThreadActions } from './goobers-review-threads.mjs';

const HEAD_SHA = 'a'.repeat(40);
const RECENT_ANCESTOR_SHA = 'b'.repeat(40);
const UNREACHABLE_SHA = 'c'.repeat(40);

function threadUrl(id) {
  return `https://github.com/o/r/pull/1#discussion_r${id}`;
}

function outdatedThreadNoMarker(id, replyCommentId) {
  return {
    id,
    isResolved: false,
    isOutdated: true,
    comments: {
      nodes: [
        {
          id: `${id}-root`,
          body: 'Please reconsider this approach.',
          author: { login: 'some-reviewer' },
          authorAssociation: 'NONE',
          url: threadUrl(replyCommentId),
        },
      ],
    },
  };
}

test('(a) an outdated thread with no marker queues a post-outdated-marker decision', () => {
  const threads = [outdatedThreadNoMarker('t1', '111')];
  const decisions = decideReviewThreadActions({ threads, headSha: HEAD_SHA });
  const markerDecision = decisions.find(
    (d) => d.threadId === 't1' && d.action === 'post-outdated-marker',
  );
  assert.ok(markerDecision, 'expected a post-outdated-marker decision');
  assert.equal(markerDecision.replyCommentId, '111');
  assert.match(markerDecision.markerBody, /^✅ Addressed in [0-9a-f]{40}: thread outdated/);
});

test('(b) same-pass promotion: a single call over a marker-less outdated thread also resolves it', () => {
  // This matches reconcile.mjs's actual behavior (reconcile.mjs:2385-2395 mutates
  // `thread.comments.nodes` in place, so the resolve pass immediately below sees
  // the synthetic marker within the SAME run) rather than requiring a second,
  // separate reconcile pass to observe a real posted marker comment.
  const threads = [outdatedThreadNoMarker('t1', '111')];
  const decisions = decideReviewThreadActions({ threads, headSha: HEAD_SHA });
  assert.deepEqual(
    decisions.map((d) => d.action),
    ['post-outdated-marker', 'resolve'],
  );
  assert.equal(decisions[1].threadId, 't1');
  assert.equal(decisions[1].requiresPostedMarker, true);
});

test('(c) a trusted marker naming a reachable ancestor SHA resolves directly, no marker post', () => {
  const threads = [
    {
      id: 't2',
      isResolved: false,
      isOutdated: true,
      comments: {
        nodes: [
          {
            id: 't2-root',
            body: 'Fix the typo.',
            author: { login: 'reviewer' },
            authorAssociation: 'NONE',
            url: threadUrl('222'),
          },
          {
            id: 't2-marker',
            body: `✅ Addressed in ${RECENT_ANCESTOR_SHA}: fixed`,
            author: { login: 'copilot-swe-agent[bot]' },
            authorAssociation: 'NONE',
            url: '',
          },
        ],
      },
    },
  ];
  const decisions = decideReviewThreadActions({
    threads,
    headSha: HEAD_SHA,
    reachableCommitShas: [RECENT_ANCESTOR_SHA],
  });
  assert.deepEqual(decisions, [
    {
      threadId: 't2',
      action: 'resolve',
      reachableCommitShas: [RECENT_ANCESTOR_SHA],
    },
  ]);
});

test('(d) a trusted marker naming an unreachable, non-head SHA yields no decision', () => {
  const threads = [
    {
      id: 't3',
      isResolved: false,
      isOutdated: true,
      comments: {
        nodes: [
          {
            id: 't3-root',
            body: 'Please address.',
            author: { login: 'reviewer' },
            authorAssociation: 'NONE',
            url: threadUrl('333'),
          },
          {
            id: 't3-marker',
            body: `✅ Addressed in ${UNREACHABLE_SHA}: fixed`,
            author: { login: 'copilot-swe-agent[bot]' },
            authorAssociation: 'NONE',
            url: '',
          },
        ],
      },
    },
  ];
  const decisions = decideReviewThreadActions({
    threads,
    headSha: HEAD_SHA,
    reachableCommitShas: [],
  });
  assert.deepEqual(decisions, []);
});

test('(e) marker-collision: calling the function twice with identical input is idempotent', () => {
  const threads = [outdatedThreadNoMarker('t1', '111')];
  const first = decideReviewThreadActions({ threads, headSha: HEAD_SHA });
  const second = decideReviewThreadActions({ threads, headSha: HEAD_SHA });
  assert.deepEqual(first, second);
  // The input threads array/objects must never be mutated by the call.
  assert.equal(threads[0].comments.nodes.length, 1);
});

test('(f) resolved threads are never included in any decision', () => {
  const threads = [
    { ...outdatedThreadNoMarker('t1', '111'), isResolved: true },
    {
      id: 't2',
      isResolved: true,
      isOutdated: false,
      comments: {
        nodes: [
          {
            id: 't2-marker',
            body: `✅ Addressed in ${HEAD_SHA}: fixed`,
            author: { login: 'copilot-swe-agent[bot]' },
            authorAssociation: 'NONE',
            url: '',
          },
        ],
      },
    },
  ];
  const decisions = decideReviewThreadActions({ threads, headSha: HEAD_SHA });
  assert.deepEqual(decisions, []);
});

test('threads with no reply target (no matching discussion url) are skipped in phase 1', () => {
  const threads = [
    {
      id: 't4',
      isResolved: false,
      isOutdated: true,
      comments: {
        nodes: [
          {
            id: 't4-root',
            body: 'Please address.',
            author: { login: 'reviewer' },
            authorAssociation: 'NONE',
            url: '',
          },
        ],
      },
    },
  ];
  const decisions = decideReviewThreadActions({ threads, headSha: HEAD_SHA });
  assert.deepEqual(decisions, []);
});

test('follow-up backlog threads emit a resolve decision with the created/reused issue mapping', () => {
  const sourceIssueNumber = 123;
  const threads = [
    {
      id: 't-followup',
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [
          {
            id: 't-followup-root',
            body: `Please file a follow-up backlog issue for #${sourceIssueNumber} without assigning Copilot.`,
            author: { login: 'copilot-pull-request-reviewer' },
            authorAssociation: 'MEMBER',
            url: threadUrl('777'),
          },
        ],
      },
    },
  ];
  const decisions = decideReviewThreadActions({
    threads,
    headSha: HEAD_SHA,
    closingIssues: [{ number: sourceIssueNumber, repository: { nameWithOwner: 'nalfeo/Crawler' } }],
    repository: 'nalfeo/Crawler',
    followUpIssueMapping: [{ sourceIssueNumber, issueNumber: 456, action: 'created' }],
  });
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].kind, 'follow-up-backlog');
  assert.equal(decisions[0].action, 'resolve');
  assert.deepEqual(decisions[0].issueMapping, [
    { sourceIssueNumber, issueNumber: 456, action: 'created' },
  ]);
  assert.match(decisions[0].markerBody, /issue #456 for #123/);
});

test('follow-up backlog threads without a complete positive issue mapping are skipped', () => {
  const sourceIssueNumber = 123;
  const threads = [
    {
      id: 't-followup-missing-map',
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [
          {
            id: 't-followup-missing-map-root',
            body: `Please file a follow-up backlog issue for #${sourceIssueNumber} without assigning Copilot.`,
            author: { login: 'copilot-pull-request-reviewer' },
            authorAssociation: 'MEMBER',
            url: threadUrl('778'),
          },
        ],
      },
    },
  ];
  const decisions = decideReviewThreadActions({
    threads,
    headSha: HEAD_SHA,
    closingIssues: [{ number: sourceIssueNumber, repository: { nameWithOwner: 'nalfeo/Crawler' } }],
    repository: 'nalfeo/Crawler',
    followUpIssueMapping: [],
  });
  assert.deepEqual(decisions, []);
});

test('a non-outdated unresolved thread with no marker is left alone', () => {
  const threads = [
    {
      id: 't5',
      isResolved: false,
      isOutdated: false,
      comments: {
        nodes: [
          {
            id: 't5-root',
            body: 'Still relevant feedback.',
            author: { login: 'reviewer' },
            authorAssociation: 'NONE',
            url: threadUrl('555'),
          },
        ],
      },
    },
  ];
  const decisions = decideReviewThreadActions({ threads, headSha: HEAD_SHA });
  assert.deepEqual(decisions, []);
});
