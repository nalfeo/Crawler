/**
 * Integration tests for the ci-conflict-coordinator reconcile script.
 *
 * Each test spawns reconcile.mjs as a child process against a local mock
 * HTTP server and a real (temporary) git repository, exercising the
 * close → post-close revalidation → reopen code path end-to-end.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  makeLifecycleRecord,
  PHASE as LIFECYCLE_PHASE,
  renderLifecycleComment,
} from '../ci-recovery/pr-lifecycle.mjs';
import { makeCoordinatorState, renderCoordinatorComment } from './state.mjs';
import {
  blockerFingerprint,
  makeState as makeRecoveryState,
  renderStateComment as renderRecoveryStateComment,
} from '../ci-recovery/state.mjs';

const SCRIPT = fileURLToPath(new URL('./reconcile.mjs', import.meta.url));
const OWNER = 'test-owner';
const REPO = 'test-repo';
const APP_ID = '11111';
const TOKEN = 'x-test-token';

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function git(cwd, args, options = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      HOME: cwd,
      ...(options.env || {}),
    },
  }).trim();
}

function gitCommit(cwd, message) {
  git(cwd, ['add', '.']);
  git(cwd, ['commit', '--allow-empty', '-m', message], {
    env: {
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  return git(cwd, ['rev-parse', 'HEAD']);
}

function lifecycleComment(prNumber, phase, headSha) {
  return {
    body: renderLifecycleComment(
      makeLifecycleRecord({
        prNumber,
        phase,
        headSha,
        updatedAt: '2026-07-28T00:00:00Z',
      }),
    ),
    performed_via_github_app: { id: Number(APP_ID) },
    user: { login: 'crawler-bot' },
    author_association: 'MEMBER',
  };
}

/**
 * Set up a git remote + working repo with:
 *   main: ci.yml="main", extra.yml="main"
 *   pr1 : ci.yml="pr1"   (unique change → will be the leader/active slot)
 *   pr2 : extra.yml="pr2"(unique change → second member)
 *   pr3 : ci.yml="main", extra.yml="main" (superseded by main alone, predecessorHeads=[])
 *
 * PR3 has 2 CI files so it ranks above PR1/PR2 and is processed first in
 * buildSupersessionProofs. Since it is superseded before any PR is applied,
 * its predecessorHeads=[] and it is eligible for immediate closure.
 */
function setupGitRepos() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'crawler-coordinator-test-'));
  const remoteDir = path.join(tmpDir, 'remote.git');
  const workDir = path.join(tmpDir, 'work');
  mkdirSync(remoteDir);
  mkdirSync(workDir);

  git(remoteDir, ['init', '--bare']);

  git(workDir, ['init', '--initial-branch=main']);
  git(workDir, ['remote', 'add', 'origin', remoteDir]);
  git(workDir, ['config', 'user.email', 'test@example.com']);
  git(workDir, ['config', 'user.name', 'Test']);

  mkdirSync(path.join(workDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(workDir, '.github', 'workflows', 'ci.yml'), 'value: base\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'extra.yml'), 'value: base\n');
  const baseSha = gitCommit(workDir, 'base');

  // Advance main
  writeFileSync(path.join(workDir, '.github', 'workflows', 'ci.yml'), 'value: main\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'extra.yml'), 'value: main\n');
  const mainSha = gitCommit(workDir, 'main');
  git(workDir, ['push', 'origin', 'main']);

  // PR1: unique ci.yml change
  git(workDir, ['checkout', '-b', 'pr1', baseSha]);
  writeFileSync(path.join(workDir, '.github', 'workflows', 'ci.yml'), 'value: pr1\n');
  const pr1Sha = gitCommit(workDir, 'pr1');
  git(workDir, ['push', 'origin', 'pr1']);

  // PR2: unique extra.yml change
  git(workDir, ['checkout', '-b', 'pr2', baseSha]);
  writeFileSync(path.join(workDir, '.github', 'workflows', 'extra.yml'), 'value: pr2\n');
  const pr2Sha = gitCommit(workDir, 'pr2');
  git(workDir, ['push', 'origin', 'pr2']);

  // PR3: superseded (same content as main already merged)
  git(workDir, ['checkout', '-b', 'pr3', baseSha]);
  writeFileSync(path.join(workDir, '.github', 'workflows', 'ci.yml'), 'value: main\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'extra.yml'), 'value: main\n');
  const pr3Sha = gitCommit(workDir, 'pr3');
  git(workDir, ['push', 'origin', 'pr3']);

  git(workDir, ['checkout', 'main']);

  return { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha };
}

/**
 * Like setupGitRepos but gives PR1 and PR2 'applied' supersession proofs
 * (no merge conflict with main).
 *
 * The non-conflicting property is achieved by having each PR branch *add* a
 * brand-new workflow file rather than modify the files that main already
 * changed. The three-way merge simply inserts the new file with no conflict,
 * giving proof=applied.
 *
 *   base   : ci.yml="base", extra.yml="base"
 *   main   : ci.yml="main", extra.yml="main"
 *   PR1    : adds .github/workflows/pr1-unique.yml (ci.yml/extra.yml unchanged
 *            from base) → proof=applied, no conflict with main's ci.yml change.
 *            The mock file-list route for PR1 still claims ci.yml so the
 *            cluster-detection overlap with PR3 is preserved.
 *   PR2    : adds .github/workflows/pr2-unique.yml (same reasoning) →
 *            proof=applied, no conflict with main's extra.yml change.
 *   PR3    : same content as main in both files → proof=superseded
 *
 * Because neither PR1 nor PR2 is ambiguous the proof-labeling loop never adds
 * ci-conflict-escalation, letting the selection-binding-drift escalation path
 * be tested in isolation.
 */
function setupGitReposNonConflicting() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'crawler-coordinator-test-'));
  const remoteDir = path.join(tmpDir, 'remote.git');
  const workDir = path.join(tmpDir, 'work');
  mkdirSync(remoteDir);
  mkdirSync(workDir);

  git(remoteDir, ['init', '--bare']);

  git(workDir, ['init', '--initial-branch=main']);
  git(workDir, ['remote', 'add', 'origin', remoteDir]);
  git(workDir, ['config', 'user.email', 'test@example.com']);
  git(workDir, ['config', 'user.name', 'Test']);

  mkdirSync(path.join(workDir, '.github', 'workflows'), { recursive: true });
  writeFileSync(path.join(workDir, '.github', 'workflows', 'ci.yml'), 'value: base\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'extra.yml'), 'value: base\n');
  const baseSha = gitCommit(workDir, 'base');

  // Advance main: changes both existing files
  writeFileSync(path.join(workDir, '.github', 'workflows', 'ci.yml'), 'value: main\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'extra.yml'), 'value: main\n');
  const mainSha = gitCommit(workDir, 'main');
  git(workDir, ['push', 'origin', 'main']);

  // PR1: adds a brand-new workflow file so the three-way merge (base=baseSha,
  // ours=mainSha, theirs=pr1Sha) simply inserts the new file with no conflict.
  // ci.yml and extra.yml are left at their base values; main's changes to those
  // files are carried forward cleanly (ours-wins, no staged conflict).
  git(workDir, ['checkout', '-b', 'pr1', baseSha]);
  writeFileSync(path.join(workDir, '.github', 'workflows', 'pr1-unique.yml'), 'pr1: unique\n');
  const pr1Sha = gitCommit(workDir, 'pr1');
  git(workDir, ['push', 'origin', 'pr1']);

  // PR2: same strategy as PR1 — adds a distinct new workflow file
  git(workDir, ['checkout', '-b', 'pr2', baseSha]);
  writeFileSync(path.join(workDir, '.github', 'workflows', 'pr2-unique.yml'), 'pr2: unique\n');
  const pr2Sha = gitCommit(workDir, 'pr2');
  git(workDir, ['push', 'origin', 'pr2']);

  // PR3: superseded (same content as main in both files)
  git(workDir, ['checkout', '-b', 'pr3', baseSha]);
  writeFileSync(path.join(workDir, '.github', 'workflows', 'ci.yml'), 'value: main\n');
  writeFileSync(path.join(workDir, '.github', 'workflows', 'extra.yml'), 'value: main\n');
  const pr3Sha = gitCommit(workDir, 'pr3');
  git(workDir, ['push', 'origin', 'pr3']);

  git(workDir, ['checkout', 'main']);

  return { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha };
}

// ---------------------------------------------------------------------------
// Mock HTTP server
// ---------------------------------------------------------------------------

/**
 * Starts a minimal mock HTTP server.
 * `routes` maps `"METHOD /path"` (exact or prefix) to a handler function.
 * Returns { server, port, mutatingCalls }.
 */
function startServer(routes) {
  const mutatingCalls = [];
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const method = req.method.toUpperCase();
      let raw = '';
      req.on('data', (chunk) => {
        raw += chunk;
      });
      req.on('end', () => {
        const parsed = raw ? JSON.parse(raw) : undefined;
        const pathOnly = req.url.split('?')[0];
        if (['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)) {
          mutatingCalls.push({ method, url: pathOnly, body: parsed });
        }
        const exactKey = `${method} ${pathOnly}`;
        let handler = routes[exactKey];
        if (!handler) {
          const entry = Object.entries(routes).find(([k]) => {
            const space = k.indexOf(' ');
            const m = k.slice(0, space);
            const p = k.slice(space + 1);
            return (m === method || m === '*') && pathOnly.startsWith(p);
          });
          handler = entry?.[1];
        }
        if (handler) {
          const result = handler(req.url, parsed, req) ?? {};
          const status = result.status ?? 200;
          const bodyStr = result.body !== undefined ? JSON.stringify(result.body) : '{}';
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(bodyStr);
        } else {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: `Not Found: ${req.method} ${req.url}` }));
        }
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, mutatingCalls });
    });
  });
}

/**
 * Spawn reconcile.mjs against the mock server, using the provided git workDir.
 */
async function runScript(port, workDir, extraEnv = {}) {
  const child = spawn(process.execPath, [SCRIPT], {
    cwd: workDir,
    env: {
      GITHUB_REPOSITORY: `${OWNER}/${REPO}`,
      GITHUB_API_URL: `http://127.0.0.1:${port}`,
      GITHUB_GRAPHQL_URL: `http://127.0.0.1:${port}/graphql`,
      CI_CONFLICT_COORDINATOR_TOKEN: TOKEN,
      CI_CONFLICT_COORDINATOR_APP_ID: APP_ID,
      GITHUB_TOKEN: TOKEN,
      MERGE_TRAIN_ENABLED: 'true',
      MERGE_TRAIN_ADMISSION_CHECKS: '',
      // Speed up retries for test execution
      GITHUB_REQUEST_RETRY_DELAY_MS: '0',
      CI_CONFLICT_REOPEN_RETRY_DELAY_MS: '0',
      ...extraEnv,
    },
  });
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (d) => {
    stdout += d;
  });
  child.stderr?.on('data', (d) => {
    stderr += d;
  });
  const [code] = await once(child, 'close');
  return { code, stdout, stderr };
}

/**
 * Build the standard mock route table for a 3-PR cluster scenario where PR3
 * is superseded by main alone.
 *
 * @param {object} opts
 * @param {string} opts.mainSha
 * @param {string} opts.pr1Sha
 * @param {string} opts.pr2Sha
 * @param {string} opts.pr3Sha
 * @param {string} [opts.livePr1Sha]      - SHA returned by live GET /pulls/1 reads;
 *   defaults to pr1Sha. Pass a different value to simulate a synchronize race
 *   after the initial open-PR snapshot but before active-slot exposure.
 * @param {string} [opts.postClosePr3Sha]  - SHA returned for PR3 in post-close reads;
 *   defaults to pr3Sha (no drift). Pass a different value to simulate drift.
 * @param {number} [opts.closeStatus]      - HTTP status for PATCH {state:closed};
 *   defaults to 200. Values >=400 simulate an ambiguous close response.
 * @param {number} [opts.reopenStatus]     - HTTP status to return for the reopen PATCH;
 *   defaults to 200 (success).
 * @param {number} [opts.fenceReleaseStatus] - HTTP status to return for the owner-fence
 *   DELETE; defaults to 204 (success).
 * @param {Array<Array<object>>} [opts.checkRunPages] - check-runs response pages.
 * @param {boolean} [opts.enforceGraphqlAuth] - require auth header on GraphQL calls.
 */
function buildRoutes({
  mainSha,
  pr1Sha,
  pr2Sha,
  pr3Sha,
  livePr1Sha = pr1Sha,
  postClosePr3Sha,
  postClosePr3Status = 200,
  closeStatus = 200,
  reopenStatus = 200,
  fenceReleaseStatus = 204,
  pr3HeadRef = undefined,
  pr1Labels = [],
  pr2Labels = [],
  pr3Labels = [],
  pr1Comments = [],
  pr2Comments = [],
  pr3Comments = [],
  pr3AutoMerge = null,
  pr3LabelsAfterGetCount = null,
  pr3LabelsAfter = [{ name: 'human-approval-required' }],
  pr3ClosingIssues = [],
  checkRunPages = [[]],
  enforceGraphqlAuth = false,
}) {
  const driftedPr3Sha = postClosePr3Sha ?? pr3Sha;
  let pr3PatchCount = 0;
  let pr3GetCount = 0;
  let pr3Closed = false;

  function livePull(number, sha, extraFields = {}) {
    return {
      number,
      state: 'open',
      draft: false,
      mergeable: true,
      mergeable_state: 'clean',
      auto_merge: null,
      node_id: `PR_${number}`,
      base: { ref: 'main' },
      head: { sha, repo: { full_name: `${OWNER}/${REPO}` } },
      labels: [],
      additions: 10,
      deletions: 2,
      changed_files: 1,
      created_at: `2026-07-0${number}T00:00:00Z`,
      title: `PR ${number}`,
      ...extraFields,
    };
  }

  // PR3-specific helper that merges optional head-ref and label overrides so
  // tests can simulate human-approval-gated scenarios without boilerplate.
  function pr3Pull(sha, extra = {}) {
    return livePull(3, sha, {
      changed_files: 2,
      ...(pr3HeadRef
        ? { head: { ref: pr3HeadRef, sha, repo: { full_name: `${OWNER}/${REPO}` } } }
        : {}),
      ...(pr3Labels.length > 0 ? { labels: pr3Labels } : {}),
      ...(pr3AutoMerge ? { auto_merge: pr3AutoMerge } : {}),
      ...extra,
    });
  }

  return {
    // Ensure labels (coordinator labels already exist → 422 ignored)
    [`POST /repos/${OWNER}/${REPO}/labels`]: (_url, body) => {
      // Owner-fence label creation: succeed only if it's PR3's fence
      if (body?.name === `ci-owner-pr-3`)
        return { status: 201, body: { node_id: 'LABEL_FENCE_3' } };
      // Coordinator labels already exist
      return { status: 422, body: { message: 'already exists' } };
    },

    // Paginated open PRs
    [`GET /repos/${OWNER}/${REPO}/pulls`]: () => ({
      body: [
        // PR3 has 2 CI files → ranks first
        pr3Pull(pr3Sha),
        livePull(1, pr1Sha, { labels: pr1Labels }),
        livePull(2, pr2Sha, { labels: pr2Labels }),
      ],
    }),

    // PR file lists (per-PR)
    [`GET /repos/${OWNER}/${REPO}/pulls/1/files`]: () => ({
      body: [{ filename: '.github/workflows/ci.yml' }],
    }),
    [`GET /repos/${OWNER}/${REPO}/pulls/2/files`]: () => ({
      body: [{ filename: '.github/workflows/extra.yml' }],
    }),
    [`GET /repos/${OWNER}/${REPO}/pulls/3/files`]: () => ({
      body: [{ filename: '.github/workflows/ci.yml' }, { filename: '.github/workflows/extra.yml' }],
    }),

    // PR comments (empty — no existing coordinator or recovery state)
    [`GET /repos/${OWNER}/${REPO}/issues/1/comments`]: () => ({ body: pr1Comments }),
    [`GET /repos/${OWNER}/${REPO}/issues/2/comments`]: () => ({ body: pr2Comments }),
    [`GET /repos/${OWNER}/${REPO}/issues/3/comments`]: () => ({ body: pr3Comments }),

    // main SHA
    [`GET /repos/${OWNER}/${REPO}/git/ref/heads/main`]: () => ({
      body: { object: { sha: mainSha } },
    }),

    // Check runs (all empty → not green by default)
    [`GET /repos/${OWNER}/${REPO}/commits`]: (url) => {
      const pageParam = new URL(url, 'http://localhost').searchParams.get('page');
      const page = Number.parseInt(pageParam || '1', 10);
      return { body: { check_runs: checkRunPages[page - 1] || [] } };
    },

    // Live PR reads for PR1 (leader): can drift after the initial snapshot.
    [`GET /repos/${OWNER}/${REPO}/pulls/1`]: () => ({
      body: livePull(1, livePr1Sha, { labels: pr1Labels }),
    }),

    // Live PR reads for PR2
    [`GET /repos/${OWNER}/${REPO}/pulls/2`]: () => ({
      body: livePull(2, pr2Sha, { labels: pr2Labels }),
    }),

    // Live PR reads for PR3: pre-close uses pr3Sha; once closed, post-close
    // reads use driftedPr3Sha and may fail per postClosePr3Status.
    [`GET /repos/${OWNER}/${REPO}/pulls/3`]: () => {
      pr3GetCount += 1;
      if (pr3Closed && postClosePr3Status >= 400) {
        return {
          status: postClosePr3Status,
          body: { message: 'post-close pull fetch failed' },
        };
      }
      const sha = pr3Closed ? driftedPr3Sha : pr3Sha;
      const labels =
        pr3LabelsAfterGetCount !== null && pr3GetCount >= pr3LabelsAfterGetCount
          ? pr3LabelsAfter
          : pr3Labels;
      return { body: pr3Pull(sha, { labels, state: pr3Closed ? 'closed' : 'open' }) };
    },

    // PATCH to close/reopen PR3
    [`PATCH /repos/${OWNER}/${REPO}/pulls/3`]: (_url, body) => {
      pr3PatchCount += 1;
      if (body?.state === 'closed') {
        pr3Closed = true;
        return { status: closeStatus, body: pr3Pull(pr3Sha, { state: 'closed' }) };
      }
      // Reopen call
      if (pr3PatchCount >= 2) {
        if (reopenStatus < 400) pr3Closed = false;
        return {
          status: reopenStatus,
          body: { message: reopenStatus === 200 ? 'ok' : 'server error' },
        };
      }
      return { status: 200, body: pr3Pull(pr3Sha) };
    },

    // Label mutations on issues (add/remove)
    [`POST /repos/${OWNER}/${REPO}/issues/1/labels`]: () => ({ body: [] }),
    [`POST /repos/${OWNER}/${REPO}/issues/2/labels`]: () => ({ body: [] }),
    [`POST /repos/${OWNER}/${REPO}/issues/3/labels`]: () => ({ body: [] }),
    [`DELETE /repos/${OWNER}/${REPO}/issues`]: () => ({ status: 204, body: null }),

    // Owner fence label delete (releaseOwnerFence)
    [`DELETE /repos/${OWNER}/${REPO}/labels`]: () => ({
      status: fenceReleaseStatus,
      body: fenceReleaseStatus < 300 ? null : { message: 'server error' },
    }),

    // Coordinator comments (POST new comment for each PR)
    [`POST /repos/${OWNER}/${REPO}/issues/1/comments`]: () => ({ body: { id: 1001 } }),
    [`POST /repos/${OWNER}/${REPO}/issues/2/comments`]: () => ({ body: { id: 1002 } }),
    [`POST /repos/${OWNER}/${REPO}/issues/3/comments`]: () => ({ body: { id: 1003 } }),

    // GraphQL closing-issue lookup used by the shared human-approval gate.
    [`POST /graphql`]: (_url, body, req) => {
      const expectedAuth = `Be${'arer'} ${TOKEN}`;
      if (enforceGraphqlAuth && req?.headers?.authorization !== expectedAuth) {
        return { status: 401, body: { message: 'Bad credentials' } };
      }
      return {
        body: {
          data: {
            repository: {
              pullRequest: {
                closingIssuesReferences: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: body?.variables?.number === 3 ? pr3ClosingIssues : [],
                },
              },
            },
          },
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('coordinator removes every stale label from an out-of-scope persisted member', async (t) => {
  const { tmpDir, workDir, pr1Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));
  const coordinatorLabels = [
    'ci-conflict-coordinated',
    'ci-conflict-leader',
    'ci-conflict-escalation',
    'ci-conflict-order-wait',
  ];
  const statePull = {
    number: 1,
    title: 'Out-of-scope PR',
    headSha: pr1Sha,
    ciFiles: ['.github/workflows/ci.yml'],
  };
  const staleState = makeCoordinatorState({
    prNumber: 1,
    groupId: 'ci-conflict-stale',
    originalMembers: [1, 2, 3],
    leaderNumber: 1,
    activeNumber: 1,
    order: [statePull],
    proofs: [],
    overlapFiles: ['.github/workflows/ci.yml'],
    updatedAt: '2026-07-20T00:00:00Z',
  });
  const pull = {
    number: 1,
    state: 'open',
    draft: false,
    auto_merge: null,
    node_id: 'PR_1',
    base: { ref: 'main' },
    head: {
      sha: pr1Sha,
      ref: 'pr1',
      repo: { full_name: `${OWNER}/${REPO}` },
    },
    labels: coordinatorLabels.map((name) => ({ name })),
    created_at: '2026-07-01T00:00:00Z',
    title: 'Out-of-scope PR',
  };
  const routes = {
    [`POST /repos/${OWNER}/${REPO}/labels`]: () => ({
      status: 422,
      body: { message: 'already exists' },
    }),
    [`GET /repos/${OWNER}/${REPO}/pulls`]: () => ({ body: [pull] }),
    [`GET /repos/${OWNER}/${REPO}/pulls/1/files`]: () => ({
      body: [{ filename: 'src/game/ignored.ts' }],
    }),
    [`GET /repos/${OWNER}/${REPO}/issues/1/comments`]: () => ({
      body: [
        {
          id: 1001,
          body: renderCoordinatorComment(staleState),
          performed_via_github_app: { id: Number(APP_ID) },
          user: { login: 'trusted-app[bot]' },
          author_association: 'NONE',
        },
      ],
    }),
    [`DELETE /repos/${OWNER}/${REPO}/issues/1/labels`]: () => ({
      status: 204,
      body: null,
    }),
  };
  const { server, port, mutatingCalls } = await startServer(routes);
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }
  assert.equal(code, 0, stderr);
  assert.match(stdout, /reason=out-of-scope-or-stale/);
  const labelDeletes = mutatingCalls.filter(
    (call) =>
      call.method === 'DELETE' && call.url.startsWith(`/repos/${OWNER}/${REPO}/issues/1/labels/`),
  );
  assert.equal(labelDeletes.length, coordinatorLabels.length);
});

test('coordinator closes superseded duplicate and confirms on revalidation (no drift)', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({ mainSha, pr1Sha, pr2Sha, pr3Sha }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  // PR3 must have been closed
  const closePatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'closed',
  );
  assert.ok(closePatch, 'expected PATCH {state:closed} for superseded PR3');

  // No reopen must have been attempted (no drift)
  const reopenPatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'open',
  );
  assert.equal(reopenPatch, undefined, 'must not reopen when post-close proof is stable');

  assert.match(stdout, /closed pr=#3/, 'stdout must log successful closure');
});

test('coordinator keeps every member fenced when the active-slot head drifts before exposure', async (t) => {
  // Use the non-conflicting fixture so PR1 gets an 'applied' proof and becomes
  // the active slot. That makes selection.active non-null and activeSafe=true,
  // meaning the binding-drift check actually runs. With the single-line fixture
  // PR1 is 'ambiguous', selection.active is null, and the drift path is never
  // reached — escalation would be added by the proof-labeling step instead,
  // making the assertion vacuous.
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitReposNonConflicting();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const driftedActiveSha = '6'.repeat(40);
  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({ mainSha, pr1Sha, pr2Sha, pr3Sha, livePr1Sha: driftedActiveSha }),
  );
  t.after(() => server.close());

  // Serialization is opt-in now, so this fencing characterization must pin the
  // enforcement path explicitly.
  const { code, stdout, stderr } = await runScript(port, workDir, {
    CI_CONFLICT_COORDINATION_ENFORCE: '1',
  });

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  const activeFenceAdd = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/1/labels` &&
      Array.isArray(c.body?.labels) &&
      c.body.labels.includes('ci-conflict-order-wait'),
  );
  assert.ok(activeFenceAdd, 'expected active slot to be fenced before any exposure attempt');

  // Pin that the binding-drift code path was actually reached before asserting
  // on the resulting escalation label. Without this guard the assertion below
  // would pass even if the drift-escalation block were removed, because the
  // proof-labeling step can independently add ci-conflict-escalation when a
  // proof is 'ambiguous'. The non-conflicting fixture gives PR1 an 'applied'
  // proof, so this stdout log is the only way escalation can appear.
  assert.match(
    stdout,
    /retain fenced/,
    'binding-drift detection must log "retain fenced" before escalation is posted',
  );

  const escalationAdd = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      /\/issues\/\d+\/labels$/.test(c.url) &&
      Array.isArray(c.body?.labels) &&
      c.body.labels.includes('ci-conflict-escalation'),
  );
  assert.ok(escalationAdd, 'enforced mode must publish selection-binding drift escalation labels');

  const activeFenceRemove = mutatingCalls.find(
    (c) =>
      c.method === 'DELETE' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/1/labels/ci-conflict-order-wait`,
  );
  assert.equal(
    activeFenceRemove,
    undefined,
    'must keep ORDER_WAIT on the selected active slot when its bound head drifts before exposure',
  );

  const recoveryDispatch = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      c.url === `/repos/${OWNER}/${REPO}/actions/workflows/ci-recovery.yml/dispatches`,
  );
  assert.equal(
    recoveryDispatch,
    undefined,
    'must not dispatch ci-recovery from a stale active-slot selection',
  );

  const closePatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'closed',
  );
  assert.equal(
    closePatch,
    undefined,
    'must not close another group member from the stale selection',
  );
});

test('coordinator keeps every member fenced and suppresses dispatch when the active slot has a trusted shepherd lease', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const shepherdState = makeRecoveryState({
    prNumber: 1,
    headSha: pr1Sha,
    fingerprint: blockerFingerprint([]),
    owner: 'shepherd',
    status: 'active',
    leaseId: 'test-shepherd-lease',
    blockers: [],
    updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  });

  const trustedRecoveryComment = {
    id: 2001,
    body: renderRecoveryStateComment(shepherdState),
    performed_via_github_app: { id: Number(APP_ID) },
    user: { login: 'trusted-app[bot]' },
    author_association: 'NONE',
  };

  const routes = buildRoutes({
    mainSha,
    pr1Sha,
    pr2Sha,
    pr3Sha,
    // Seed PR1 with both the owner label and the ORDER_WAIT fence so the
    // "no fence removal" assertion below is non-trivial: the fence exists on
    // disk and the coordinator must choose NOT to delete it due to the lease.
    pr1Labels: [{ name: 'ci-owner-pr-1' }, { name: 'ci-conflict-order-wait' }],
  });
  routes[`GET /repos/${OWNER}/${REPO}/issues/1/comments`] = () => ({
    body: [trustedRecoveryComment],
  });

  const { server, port, mutatingCalls } = await startServer(routes);
  t.after(() => server.close());

  // Enforcement must be enabled so the shepherd-lease suppression is exercised
  // non-trivially: without it, dispatch never happens anyway.
  const { code, stdout, stderr } = await runScript(port, workDir, {
    CI_CONFLICT_COORDINATION_ENFORCE: '1',
  });

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);
  const recoveryDispatch = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      c.url === `/repos/${OWNER}/${REPO}/actions/workflows/ci-recovery.yml/dispatches`,
  );
  assert.equal(
    recoveryDispatch,
    undefined,
    'must not dispatch ci-recovery when the active slot carries a trusted shepherd lease',
  );

  const activeFenceRemove = mutatingCalls.find(
    (c) =>
      c.method === 'DELETE' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/1/labels/ci-conflict-order-wait`,
  );
  assert.equal(
    activeFenceRemove,
    undefined,
    'must keep ORDER_WAIT on the active slot while a trusted shepherd lease is healthy',
  );

  const escalationAdd = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/1/labels` &&
      Array.isArray(c.body?.labels) &&
      c.body.labels.includes('ci-conflict-escalation'),
  );
  assert.ok(
    escalationAdd,
    'must escalate the active slot when a trusted shepherd lease is present',
  );
});

test('coordinator discovers but does not serialize when enforcement is disabled (default)', async (t) => {
  // Use the non-conflicting fixture so PR1 gets an 'applied' proof and the
  // binding-drift check actually runs (selection.active is non-null). With the
  // original single-line fixture PR1 is 'ambiguous', so selection.active=null
  // and activeSafe=false — the drift code is never reached, making the
  // escalation-absent assertion vacuous.
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitReposNonConflicting();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  // Same drift scenario as the fencing test above — the ONLY difference is that
  // enforcement is left at its default (off). The fence must not be applied.
  const driftedActiveSha = '6'.repeat(40);
  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      livePr1Sha: driftedActiveSha,
      // Seed a stranded fence label left behind by a previous enforcing run.
      pr3Labels: [{ name: 'ci-conflict-order-wait' }],
    }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  const fenceAdd = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      /\/issues\/\d+\/labels$/.test(c.url) &&
      Array.isArray(c.body?.labels) &&
      c.body.labels.includes('ci-conflict-order-wait'),
  );
  assert.equal(
    fenceAdd,
    undefined,
    'must never apply ci-conflict-order-wait while enforcement is disabled',
  );

  // Pin that the binding-drift code path was reached. Without this guard the
  // escalation-absent assertion below would pass vacuously (the drift block
  // simply would not run at all with the original ambiguous-proof fixture
  // because selection.active would be null). Now that the drift check runs,
  // the absence of escalation truly exercises the enforceCoordination guard
  // inside the drift block.
  assert.match(
    stdout,
    /retain fenced/,
    'binding-drift detection must log "retain fenced" even when enforcement is disabled',
  );

  const escalationAdd = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      /\/issues\/\d+\/labels$/.test(c.url) &&
      Array.isArray(c.body?.labels) &&
      c.body.labels.includes('ci-conflict-escalation'),
  );
  assert.equal(
    escalationAdd,
    undefined,
    'unenforced mode must not publish grouping-derived escalation labels from selection drift',
  );

  // Discovery must still run: the coordinated label is how the group stays
  // visible/reportable even though it is no longer serialized.
  const coordinatedAdd = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      /\/issues\/\d+\/labels$/.test(c.url) &&
      Array.isArray(c.body?.labels) &&
      c.body.labels.includes('ci-conflict-coordinated'),
  );
  assert.ok(coordinatedAdd, 'discovery/reporting must keep working when enforcement is disabled');

  // Removal (not just omission) is what drains labels stranded by a previous
  // enforcing run, so no manual cleanup pass is required.
  const fenceRemove = mutatingCalls.find(
    (c) => c.method === 'DELETE' && /\/issues\/\d+\/labels\/ci-conflict-order-wait$/.test(c.url),
  );
  assert.ok(fenceRemove, 'must actively remove stranded ci-conflict-order-wait labels');
});

test('all-non-blocking groups drain escalation unless ownership-gated', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      pr1Labels: [{ name: 'ci-conflict-escalation' }],
      pr2Labels: [{ name: 'ci-conflict-escalation' }],
      pr3Labels: [{ name: 'ci-conflict-escalation' }, { name: 'human-approval-required' }],
      pr1Comments: [lifecycleComment(1, LIFECYCLE_PHASE.QUARANTINED, pr1Sha)],
      pr2Comments: [lifecycleComment(2, LIFECYCLE_PHASE.ABANDONED, pr2Sha)],
      pr3Comments: [lifecycleComment(3, LIFECYCLE_PHASE.QUARANTINED, pr3Sha)],
    }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);
  assert.match(stdout, /reason=all-pulls-non-blocking/, 'must hit all-non-blocking group path');

  const pr1EscalationRemoved = mutatingCalls.find(
    (c) =>
      c.method === 'DELETE' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/1/labels/ci-conflict-escalation`,
  );
  assert.ok(pr1EscalationRemoved, 'non-owned non-blocking member must have escalation drained');

  const pr2EscalationRemoved = mutatingCalls.find(
    (c) =>
      c.method === 'DELETE' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/2/labels/ci-conflict-escalation`,
  );
  assert.ok(pr2EscalationRemoved, 'abandoned non-owned member must have escalation drained');

  const pr3EscalationRemoved = mutatingCalls.find(
    (c) =>
      c.method === 'DELETE' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/3/labels/ci-conflict-escalation`,
  );
  assert.equal(
    pr3EscalationRemoved,
    undefined,
    'ownership-gated non-blocking member must retain escalation label',
  );
});

test('auto-merge stays disarmed for human-gated PRs even when enforcement is disabled', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  // PR3 needs human approval AND already has auto-merge armed. Disabling
  // serialization must NOT leave it armed: GitHub would merge it the moment its
  // checks pass, before CI recovery's independent human gate next runs.
  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      pr3Labels: [{ name: 'human-approval-required' }],
      pr3AutoMerge: { enabled_by: { login: 'nalfeo' } },
    }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  const disarm = mutatingCalls.find(
    (c) =>
      typeof c.body?.query === 'string' &&
      c.body.query.includes('disablePullRequestAutoMerge') &&
      c.body?.variables?.pullRequestId === 'PR_3',
  );
  assert.ok(
    disarm,
    'must disarm auto-merge for a human-approval-gated PR regardless of enforcement mode',
  );

  // The fence itself must still be off — this asserts the safety carve-out did
  // not silently re-enable serialization.
  const fenceAdd = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      /\/issues\/\d+\/labels$/.test(c.url) &&
      Array.isArray(c.body?.labels) &&
      c.body.labels.includes('ci-conflict-order-wait'),
  );
  assert.equal(fenceAdd, undefined, 'the ownership carve-out must not re-enable serialization');
});

test('coordinator reopens duplicate when post-close drift is detected', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  // Simulate PR3 head changing after close by returning a different SHA on the
  // third GET /pulls/3 (the post-close read).
  const driftedSha = '9'.repeat(40);

  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({ mainSha, pr1Sha, pr2Sha, pr3Sha, postClosePr3Sha: driftedSha }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  // Script must exit cleanly — reopen succeeded
  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  const closePatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'closed',
  );
  assert.ok(closePatch, 'expected PATCH {state:closed} for superseded PR3');

  const reopenPatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'open',
  );
  assert.ok(reopenPatch, 'expected PATCH {state:open} reopen after drift detected');

  assert.match(
    stdout,
    /reopen pr=#3 reason=post-close-proof-drifted/,
    'stdout must log drift-triggered reopen',
  );
});

test('coordinator reopens duplicate when post-close proof cannot be re-read', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      postClosePr3Status: 500,
    }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  const closePatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'closed',
  );
  assert.ok(closePatch, 'expected PATCH {state:closed} for superseded PR3');

  const reopenPatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'open',
  );
  assert.ok(reopenPatch, 'expected PATCH {state:open} reopen after post-close read failure');

  assert.match(
    stdout,
    /reopen pr=#3 reason=post-close-proof-unverifiable/,
    'stdout must log reopen when post-close proof cannot be verified',
  );
});

test('coordinator fails workflow when post-close reopen is unrecoverable', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const driftedSha = '8'.repeat(40);

  // Return 500 for the reopen PATCH to simulate a persistent failure
  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      postClosePr3Sha: driftedSha,
      reopenStatus: 500,
    }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  // Script must exit non-zero — unrecoverable state must escalate
  assert.notEqual(code, 0, 'reconcile must exit non-zero when reopen is unrecoverable');

  const closePatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'closed',
  );
  assert.ok(closePatch, 'expected PATCH {state:closed} before the reopen failure');

  // All reopen attempts must have been tried
  const reopenAttempts = mutatingCalls.filter(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'open',
  );
  assert.equal(reopenAttempts.length, 3, 'must attempt reopen 3 times before giving up');

  // Error must surface in stderr as an unhandled exception message
  assert.match(
    stderr,
    /UNSAFE.*failed to reopen PR #3/,
    'stderr must include UNSAFE escalation message for unrecoverable reopen failure',
  );
  assert.match(stdout, /reopen-attempt-failed pr=#3/, 'stdout must log each failed reopen attempt');
});

test('UNSAFE reopen error is preserved even when owner-fence release also fails', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const driftedSha = '7'.repeat(40);

  // Both reopen (500) and fence-release DELETE (500) fail simultaneously.
  // The UNSAFE error from the reopen failure must still surface in stderr,
  // not be replaced by the fence-release error.
  const { server, port } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      postClosePr3Sha: driftedSha,
      reopenStatus: 500,
      fenceReleaseStatus: 500,
    }),
  );
  t.after(() => server.close());

  const { code, stderr, stdout } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.notEqual(code, 0, 'reconcile must exit non-zero when reopen is unrecoverable');

  // The UNSAFE message must appear in stderr even with fence-release failure
  assert.match(
    stderr,
    /UNSAFE.*failed to reopen PR #3/,
    'UNSAFE error must survive fence-release failure in finally block',
  );

  // Fence-release failure must appear as a warning in stdout (not swallowed, not fatal)
  assert.match(
    stdout,
    /warn: owner-fence release failed for PR #3/,
    'fence-release failure must be logged as a warning',
  );
});

test('coordinator runs post-close safety flow when close response is ambiguous', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      closeStatus: 500,
      postClosePr3Sha: 'f'.repeat(40),
    }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  const closePatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'closed',
  );
  assert.ok(closePatch, 'expected close PATCH to be attempted');

  const reopenPatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'open',
  );
  assert.ok(reopenPatch, 'expected reopen after ambiguous close response and detected drift');
  assert.match(stdout, /reopen pr=#3 reason=post-close-proof-drifted/);
});

test('coordinator rechecks human approval inside close fence before closing duplicate', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      // Label appears after initial snapshot, before close mutation.
      pr3LabelsAfterGetCount: 3,
    }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  const closePatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'closed',
  );
  assert.equal(
    closePatch,
    undefined,
    'must not close duplicate once live human-approval requirement appears before close',
  );
  assert.match(stdout, /retain pr=#3 reason=human-approval-required/);
});

test('coordinator retains superseded duplicate with nightly-balance branch (human-approval-required, label absent)', async (t) => {
  // Regression for: a nightly-balance PR superseded by main alone could be
  // closed before CI recovery wrote the human-approval-required label, because
  // the duplicate-close gate only checked recovery ownership (ADR 0067 §94).
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  // PR3 is on a nightly-balance branch (requires human approval by branch
  // prefix alone — no label is present yet).
  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      pr3HeadRef: 'copilot/balance-telemetry-improvement-sweep',
    }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  // The coordinator must NOT close the human-approval-gated duplicate.
  const closePatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'closed',
  );
  assert.equal(
    closePatch,
    undefined,
    'must not close a human-approval-required (nightly-balance) duplicate before the label is applied',
  );

  // Retention must be logged.
  assert.match(
    stdout,
    /retain pr=#3 reason=human-approval-required/,
    'stdout must log human-approval retention for the nightly-balance duplicate',
  );

  // The duplicate must be escalated so operators can see it is blocked.
  const escalationLabel = 'ci-conflict-escalation';
  const escalatePatch = mutatingCalls.find(
    (c) =>
      c.method === 'POST' &&
      c.url === `/repos/${OWNER}/${REPO}/issues/3/labels` &&
      Array.isArray(c.body?.labels) &&
      c.body.labels.includes(escalationLabel),
  );
  assert.ok(
    escalatePatch,
    'must add ci-conflict-escalation label to the retained nightly-balance duplicate',
  );
});

test('coordinator retains superseded duplicate closing a human-approval-required issue', async (t) => {
  // Regression: a newly opened PR that closes an approval-gated issue must be
  // retained before CI recovery has time to copy the approval label to the PR.
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const { server, port, mutatingCalls } = await startServer(
    buildRoutes({
      mainSha,
      pr1Sha,
      pr2Sha,
      pr3Sha,
      pr3ClosingIssues: [
        {
          id: 'ISSUE_42',
          number: 42,
          title: 'Approval-gated issue',
          state: 'OPEN',
          labels: { nodes: [{ name: 'human-approval-required' }] },
          repository: { nameWithOwner: `${OWNER}/${REPO}` },
        },
      ],
    }),
  );
  t.after(() => server.close());

  const { code, stdout, stderr } = await runScript(port, workDir);

  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstdout: ${stdout}\nstderr: ${stderr}`);

  const closePatch = mutatingCalls.find(
    (c) =>
      c.method === 'PATCH' &&
      c.url === `/repos/${OWNER}/${REPO}/pulls/3` &&
      c.body?.state === 'closed',
  );
  assert.equal(
    closePatch,
    undefined,
    'must not close a duplicate that closes a human-approval-required issue',
  );

  assert.match(
    stdout,
    /retain pr=#3 reason=human-approval-required/,
    'stdout must log human-approval retention for the labelled duplicate',
  );
});

test('coordinator paginates check runs with filter=all and authenticates GraphQL approval checks', async (t) => {
  const { tmpDir, workDir, mainSha, pr1Sha, pr2Sha, pr3Sha } = setupGitRepos();
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const observedCheckRunUrls = [];
  const page1 = Array.from({ length: 100 }, (_, idx) => ({
    id: idx + 1,
    name: `optional-${idx + 1}`,
    status: 'completed',
    conclusion: 'success',
  }));
  const page2 = [
    {
      id: 101,
      name: 'optional-101',
      status: 'completed',
      conclusion: 'success',
    },
  ];

  const routes = buildRoutes({
    mainSha,
    pr1Sha,
    pr2Sha,
    pr3Sha,
    checkRunPages: [page1, page2],
    enforceGraphqlAuth: true,
  });
  const baseCheckRunsRoute = routes[`GET /repos/${OWNER}/${REPO}/commits`];
  routes[`GET /repos/${OWNER}/${REPO}/commits`] = (url, body, req) => {
    observedCheckRunUrls.push(url);
    return baseCheckRunsRoute(url, body, req);
  };
  const { server, port } = await startServer(routes);
  t.after(() => server.close());

  const { code, stderr } = await runScript(port, workDir);
  if (process.platform === 'win32' && code === 3221226505 && /UV_HANDLE_CLOSING/.test(stderr)) {
    t.skip('known Windows UV_HANDLE_CLOSING async-close crash');
    return;
  }

  assert.equal(code, 0, `reconcile exited non-zero\nstderr: ${stderr}`);
  assert.ok(
    observedCheckRunUrls.some((url) => url.includes('filter=all') && url.includes('page=2')),
    'must request paginated check runs with filter=all when page 1 is full',
  );
});
