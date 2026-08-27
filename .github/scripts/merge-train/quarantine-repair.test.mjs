import assert from 'node:assert/strict';
import test from 'node:test';

import {
  REPAIR_BRANCH_PREFIX,
  buildReplacementBody,
  buildSupersedeNoticeBody,
  hasLabelNamed,
  isConfirmedRestrictedBranchQuarantine,
  isRestrictedCopilotBranch,
  isSameRepository,
  parseRepairMarker,
  renderRepairMarker,
  repairAllQuarantinedPrs,
  repairBranchName,
  repairEligibility,
  repairQuarantinedPr,
} from './quarantine-repair.mjs';
import { UNADVANCEABLE_STRIKE_THRESHOLD, renderUnadvanceableStrike } from './reconcile-lib.mjs';
import { BLOCKED_LABEL } from './state.mjs';

const OWNER = 'nalfeo';
const REPO = 'Crawler';
const HEAD_SHA = '3a4a769647904d9a32f449bee658a241d0c4a748';
const STATUS_MARKER = '<!-- crawler-merge-train:v1 -->';

function quarantineStatusComment(headSha = HEAD_SHA, strikes = UNADVANCEABLE_STRIKE_THRESHOLD) {
  return {
    body: `${STATUS_MARKER}\n## Merge train\n\n${renderUnadvanceableStrike({ headSha, strikes, attempts: strikes })}`,
  };
}

function originalPr(overrides = {}) {
  return {
    number: 3588,
    state: 'open',
    title: 'Floor 4 slice 3: waves',
    body: 'Some description.\n\n- Fixes #3542',
    labels: [{ name: BLOCKED_LABEL }],
    head: {
      ref: 'copilot/floor-4-slice-3-waves',
      sha: HEAD_SHA,
      repo: { full_name: `${OWNER}/${REPO}` },
    },
    ...overrides,
  };
}

test('isRestrictedCopilotBranch matches only the copilot/* namespace', () => {
  assert.equal(isRestrictedCopilotBranch('copilot/floor-4-slice-3-waves'), true);
  assert.equal(isRestrictedCopilotBranch('nalfeo-repair-asset-queue'), false);
  assert.equal(isRestrictedCopilotBranch(''), false);
  assert.equal(isRestrictedCopilotBranch(undefined), false);
});

test('hasLabelNamed is case-insensitive and tolerant of missing labels', () => {
  assert.equal(hasLabelNamed({ labels: [{ name: 'Merge-Train-Blocked' }] }, BLOCKED_LABEL), true);
  assert.equal(hasLabelNamed({ labels: [] }, BLOCKED_LABEL), false);
  assert.equal(hasLabelNamed({}, BLOCKED_LABEL), false);
});

test('isSameRepository compares the head repo full_name case-insensitively', () => {
  const pr = { head: { repo: { full_name: 'Nalfeo/Crawler' } } };
  assert.equal(isSameRepository(pr, 'nalfeo/Crawler'), true);
  assert.equal(isSameRepository(pr, 'someone-else/Crawler'), false);
});

test('repairBranchName is deterministic for the same PR and head sha', () => {
  const name = repairBranchName(3588, HEAD_SHA);
  assert.equal(name, repairBranchName(3588, HEAD_SHA));
  assert.ok(name.startsWith(REPAIR_BRANCH_PREFIX));
  assert.ok(name.includes('pr-3588-'));
  // A different head sha (e.g. after the original branch moved) must map to a
  // different branch, never silently reuse a stale one.
  assert.notEqual(name, repairBranchName(3588, `f${HEAD_SHA.slice(1)}`));
});

test('renderRepairMarker / parseRepairMarker round-trip', () => {
  const marker = renderRepairMarker(3588, HEAD_SHA);
  const body = `Some replacement PR body.\n\n${marker}`;
  assert.deepEqual(parseRepairMarker(body), { prNumber: 3588, sha: HEAD_SHA });
  assert.equal(parseRepairMarker('no marker here'), null);
  assert.equal(parseRepairMarker(''), null);
});

test('buildReplacementBody preserves the original body verbatim (so Fixes #N still closes the issue)', () => {
  const original = originalPr();
  const body = buildReplacementBody({ original, headSha: HEAD_SHA });
  assert.match(body, /Supersedes #3588/);
  assert.match(body, /- Fixes #3542/);
  assert.match(body, new RegExp(HEAD_SHA));
  assert.equal(parseRepairMarker(body)?.prNumber, 3588);
});

test('buildSupersedeNoticeBody names the replacement PR and the exact head sha', () => {
  const body = buildSupersedeNoticeBody({ replacementPrNumber: 3700, headSha: HEAD_SHA });
  assert.match(body, /#3700/);
  assert.match(body, new RegExp(HEAD_SHA));
  assert.match(body, new RegExp(BLOCKED_LABEL));
});

test('repairEligibility: only open, quarantined, same-repo, restricted-branch PRs are eligible', () => {
  const repository = `${OWNER}/${REPO}`;
  assert.equal(repairEligibility(originalPr(), repository).eligible, true);
  assert.equal(repairEligibility(originalPr({ state: 'closed' }), repository).eligible, false);
  assert.equal(repairEligibility(originalPr({ labels: [] }), repository).eligible, false);
  assert.equal(
    repairEligibility(
      originalPr({
        head: { ref: 'copilot/x', sha: HEAD_SHA, repo: { full_name: 'someone/fork' } },
      }),
      repository,
    ).eligible,
    false,
  );
  assert.equal(
    repairEligibility(
      originalPr({
        head: { ref: 'nalfeo-repair-asset-queue', sha: HEAD_SHA, repo: { full_name: repository } },
      }),
      repository,
    ).eligible,
    false,
  );
  assert.equal(
    repairEligibility(
      originalPr({ head: { ref: 'copilot/x', sha: 'not-a-sha', repo: { full_name: repository } } }),
      repository,
    ).eligible,
    false,
  );
});

test('isConfirmedRestrictedBranchQuarantine confirms only a live, threshold-reaching strike record for the CURRENT head sha', async () => {
  const pr = originalPr();
  const confirmedFor = async (comments) =>
    isConfirmedRestrictedBranchQuarantine({
      paginateFn: async () => comments,
      token: 'token',
      owner: OWNER,
      repo: REPO,
      pr,
    });

  assert.equal((await confirmedFor([quarantineStatusComment()])).confirmed, true);
  // No status comment at all (e.g. blocked by a totally different path that
  // never wrote the unadvanceable-strike marker, like a validation failure).
  assert.equal((await confirmedFor([])).confirmed, false);
  // Below the quarantine threshold: not actually ejected yet.
  assert.equal(
    (await confirmedFor([quarantineStatusComment(HEAD_SHA, UNADVANCEABLE_STRIKE_THRESHOLD - 1)]))
      .confirmed,
    false,
  );
  // Stale record: the branch moved since the strike was recorded.
  assert.equal((await confirmedFor([quarantineStatusComment('f'.repeat(40))])).confirmed, false);
});

function stubGithub({
  refExists = false,
  refSha = null,
  existingPr = null,
  createPrResponse,
  extraComments = [],
} = {}) {
  const calls = [];
  const comments = [quarantineStatusComment(), ...extraComments];
  const requestFn = async (token, path, options) => {
    calls.push({ path, method: options?.method || 'GET', body: options?.body });
    if (path === `/repos/${OWNER}/${REPO}/pulls/3588`) {
      return { data: originalPr() };
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/git/ref/heads/${REPAIR_BRANCH_PREFIX}`)) {
      if (!refExists) {
        const error = new Error('Not Found');
        error.status = 404;
        throw error;
      }
      return { data: { object: { sha: refSha ?? HEAD_SHA } } };
    }
    if (path === `/repos/${OWNER}/${REPO}/git/refs` && options?.method === 'POST') {
      return { data: { ref: options.body.ref } };
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/pulls?head=`)) {
      return { data: existingPr ? [existingPr] : [] };
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls` && options?.method === 'POST') {
      if (createPrResponse instanceof Error) throw createPrResponse;
      return { data: createPrResponse ?? { number: 3700, state: 'open' } };
    }
    if (path === `/repos/${OWNER}/${REPO}/issues/3588/comments` && options?.method === 'POST') {
      // performed_via_github_app simulates our own automation identity, the
      // same signal `isTrustedNoticeAuthor` checks in production.
      comments.push({ body: options.body.body, performed_via_github_app: {} });
      return { data: { id: comments.length } };
    }
    throw new Error(`unexpected request: ${options?.method || 'GET'} ${path}`);
  };
  const paginateFn = async (_token, path) => {
    calls.push({ path, method: 'GET(paginate)' });
    if (path === `/repos/${OWNER}/${REPO}/issues/3588/comments`) return comments;
    if (path.includes(`labels=${encodeURIComponent(BLOCKED_LABEL)}`)) {
      return [
        { number: 3588, pull_request: {} },
        { number: 42, pull_request: undefined },
      ];
    }
    throw new Error(`unexpected paginate: ${path}`);
  };
  return { requestFn, paginateFn, calls, comments };
}

test('repairQuarantinedPr creates the branch and replacement PR from scratch, then links back', async () => {
  const { requestFn, paginateFn, calls, comments } = stubGithub();

  const result = await repairQuarantinedPr({
    requestFn,
    paginateFn,
    token: 'token',
    owner: OWNER,
    repo: REPO,
    originalPrNumber: 3588,
  });

  assert.deepEqual(result, {
    action: 'repaired',
    originalPrNumber: 3588,
    replacementPrNumber: 3700,
    branchName: repairBranchNameFor(),
    headSha: HEAD_SHA,
    noticePosted: true,
  });

  const createRef = calls.find((call) => call.path === `/repos/${OWNER}/${REPO}/git/refs`);
  assert.equal(createRef.body.sha, HEAD_SHA);
  assert.equal(createRef.body.ref, `refs/heads/${repairBranchNameFor()}`);

  const createPr = calls.find(
    (call) => call.path === `/repos/${OWNER}/${REPO}/pulls` && call.method === 'POST',
  );
  assert.equal(createPr.body.base, 'main');
  assert.equal(createPr.body.head, repairBranchNameFor());
  assert.match(createPr.body.body, /Supersedes #3588/);

  assert.equal(comments.length, 2);
  assert.match(comments[1].body, /Replacement PR #3700/);
});

test('repairQuarantinedPr is idempotent: re-running does not recreate the branch, PR, or comment', async () => {
  const branchName = repairBranchNameFor();
  const validReplacementBody = `${renderRepairMarker(3588, HEAD_SHA)}`;
  const { requestFn, paginateFn, calls } = stubGithub({
    refExists: true,
    refSha: HEAD_SHA,
    existingPr: {
      number: 3700,
      state: 'open',
      base: { ref: 'main' },
      body: validReplacementBody,
    },
  });
  // Simulate the linking comment already having been posted on a prior run
  // (by our own trusted automation identity).
  const comments = [
    quarantineStatusComment(),
    {
      body: 'already linked\n\n<!-- crawler:quarantine-repair-notice:3700 -->',
      performed_via_github_app: {},
    },
  ];
  const paginateWithComments = async (token, path) => {
    if (path === `/repos/${OWNER}/${REPO}/issues/3588/comments`) return comments;
    return paginateFn(token, path);
  };

  const result = await repairQuarantinedPr({
    requestFn,
    paginateFn: paginateWithComments,
    token: 'token',
    owner: OWNER,
    repo: REPO,
    originalPrNumber: 3588,
  });

  assert.deepEqual(result, {
    action: 'linked-existing',
    originalPrNumber: 3588,
    replacementPrNumber: 3700,
    branchName,
    headSha: HEAD_SHA,
    noticePosted: false,
  });
  assert.ok(!calls.some((call) => call.method === 'POST' && call.path.endsWith('/git/refs')));
  assert.ok(
    !calls.some((call) => call.path === `/repos/${OWNER}/${REPO}/pulls` && call.method === 'POST'),
  );
  assert.ok(
    !calls.some(
      (call) =>
        call.path === `/repos/${OWNER}/${REPO}/issues/3588/comments` && call.method === 'POST',
    ),
  );
});

test('repairQuarantinedPr recovers from a race where another run created the PR first (422)', async () => {
  const branchName = repairBranchNameFor();
  const raceError = new Error('A pull request already exists for nalfeo:' + branchName);
  raceError.status = 422;
  const { requestFn, paginateFn } = stubGithub({
    createPrResponse: raceError,
    existingPr: null,
  });
  // After the 422, the re-query for an existing PR on that branch must find it.
  let queried = false;
  const requestWithRaceRecovery = async (token, path, options) => {
    if (path.startsWith(`/repos/${OWNER}/${REPO}/pulls?head=`) && queried) {
      return {
        data: [
          {
            number: 3701,
            state: 'open',
            base: { ref: 'main' },
            body: renderRepairMarker(3588, HEAD_SHA),
          },
        ],
      };
    }
    if (path.startsWith(`/repos/${OWNER}/${REPO}/pulls?head=`)) {
      queried = true;
      return { data: [] };
    }
    return requestFn(token, path, options);
  };

  const result = await repairQuarantinedPr({
    requestFn: requestWithRaceRecovery,
    paginateFn,
    token: 'token',
    owner: OWNER,
    repo: REPO,
    originalPrNumber: 3588,
  });

  assert.equal(result.action, 'linked-existing');
  assert.equal(result.replacementPrNumber, 3701);
});

test('repairQuarantinedPr refuses to overwrite a repair branch pointing at an unexpected sha', async () => {
  const { requestFn, paginateFn } = stubGithub({ refExists: true, refSha: 'f'.repeat(40) });

  await assert.rejects(
    repairQuarantinedPr({
      requestFn,
      paginateFn,
      token: 'token',
      owner: OWNER,
      repo: REPO,
      originalPrNumber: 3588,
    }),
    /refusing to overwrite/,
  );
});

test('repairQuarantinedPr skips a PR that is no longer quarantined (re-checked live, not from a stale list)', async () => {
  const requestFn = async (_token, path) => {
    if (path === `/repos/${OWNER}/${REPO}/pulls/3588`) {
      return { data: originalPr({ labels: [] }) };
    }
    throw new Error(`unexpected request: ${path}`);
  };
  const result = await repairQuarantinedPr({
    requestFn,
    paginateFn: async () => [],
    token: 'token',
    owner: OWNER,
    repo: REPO,
    originalPrNumber: 3588,
  });
  assert.equal(result.action, 'skip');
  assert.match(result.reason, /no longer quarantined/);
});

test('repairQuarantinedPr skips a BLOCKED_LABEL PR blocked for an unrelated reason (validation failure / no-op), never fabricating a sibling PR', async () => {
  // Same shape as a validation-failure or no-op-diff de-admit: BLOCKED_LABEL
  // present, copilot/* head ref present, but NO unadvanceable-strike record
  // was ever written for this PR (blockEntry/deAdmitNoop never write one).
  const requestFn = async (_token, path) => {
    if (path === `/repos/${OWNER}/${REPO}/pulls/3588`) {
      return { data: originalPr() };
    }
    throw new Error(`unexpected request: ${path}`);
  };
  const result = await repairQuarantinedPr({
    requestFn,
    paginateFn: async () => [], // no status comment at all
    token: 'token',
    owner: OWNER,
    repo: REPO,
    originalPrNumber: 3588,
  });
  assert.equal(result.action, 'skip');
  assert.match(result.reason, /no confirmed restricted-branch quarantine record/);
});

test('repairQuarantinedPr refuses to link to an open PR on its branch that lacks the expected repair marker', async () => {
  const { requestFn, paginateFn } = stubGithub({
    existingPr: { number: 3700, state: 'open', base: { ref: 'main' }, body: 'unrelated PR body' },
  });

  await assert.rejects(
    repairQuarantinedPr({
      requestFn,
      paginateFn,
      token: 'token',
      owner: OWNER,
      repo: REPO,
      originalPrNumber: 3588,
    }),
    /does not carry the expected repair marker/,
  );
});

test('repairQuarantinedPr refuses to link to an open PR on its branch targeting the wrong base', async () => {
  const { requestFn, paginateFn } = stubGithub({
    existingPr: {
      number: 3700,
      state: 'open',
      base: { ref: 'some-other-branch' },
      body: renderRepairMarker(3588, HEAD_SHA),
    },
  });

  await assert.rejects(
    repairQuarantinedPr({
      requestFn,
      paginateFn,
      token: 'token',
      owner: OWNER,
      repo: REPO,
      originalPrNumber: 3588,
    }),
    /refusing to link to it/,
  );
});

test('repairAllQuarantinedPrs discovers PR-shaped issues carrying the blocked label and repairs each', async () => {
  const { requestFn, paginateFn } = stubGithub();

  const results = await repairAllQuarantinedPrs({
    requestFn,
    paginateFn,
    token: 'token',
    owner: OWNER,
    repo: REPO,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].action, 'repaired');
  assert.equal(results[0].originalPrNumber, 3588);
});

test('repairAllQuarantinedPrs reports (not throws) a per-candidate failure and keeps processing others', async () => {
  const paginateFn = async (_token, path) => {
    if (path.includes(`labels=${encodeURIComponent(BLOCKED_LABEL)}`)) {
      return [
        { number: 3588, pull_request: {} },
        { number: 3594, pull_request: {} },
      ];
    }
    return [];
  };
  const requestFn = async (_token, path) => {
    if (path === `/repos/${OWNER}/${REPO}/pulls/3588`) {
      throw new Error('network blip');
    }
    if (path === `/repos/${OWNER}/${REPO}/pulls/3594`) {
      return { data: originalPr({ number: 3594, labels: [] }) };
    }
    throw new Error(`unexpected request: ${path}`);
  };

  const results = await repairAllQuarantinedPrs({
    requestFn,
    paginateFn,
    token: 'token',
    owner: OWNER,
    repo: REPO,
  });

  assert.deepEqual(
    results.map((r) => r.action),
    ['error', 'skip'],
  );
  assert.match(results[0].reason, /network blip/);
});

function repairBranchNameFor() {
  return repairBranchName(3588, HEAD_SHA);
}
