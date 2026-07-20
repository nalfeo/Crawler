/**
 * Deterministic temporary-repository tests for materialize-candidate.sh.
 *
 * Each test creates an isolated temp directory with a local bare "origin" and
 * a work repo, configures the custom bundle-transport ref, then runs the shell
 * script and asserts the exit code and stderr output. Tests cover:
 *   - valid thin bundle → materializes and exits 0
 *   - ref points to a commit (not a blob) → exits 1 before verification
 *   - corrupt / non-bundle blob → git bundle verify fails, exits 1
 *   - valid bundle but wrong CANDIDATE_SHA → SHA mismatch, exits 1
 */

import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const materializeTest = process.platform === 'win32' ? test.skip : test;

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'materialize-candidate.sh',
);

const GIT_CONFIG_ENV = {
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

function git(args, { cwd, env = {} } = {}) {
  return execFileSync('git', args, {
    stdio: 'pipe',
    env: { ...process.env, ...GIT_CONFIG_ENV, ...env },
    cwd,
  })
    .toString()
    .trim();
}

/**
 * Set up an isolated temp environment:
 *   - <tmp>/origin.git  bare repo acting as remote "origin"
 *   - <tmp>/work        non-bare work repo with origin pointed at origin.git
 *
 * Returns { tmp, originDir, workDir, candidateSha, bundlePath }.
 */
function setupRepos() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'mt-materialize-'));
  const originDir = path.join(tmp, 'origin.git');
  const builderDir = path.join(tmp, 'builder');
  const workDir = path.join(tmp, 'work');
  const bundlePath = path.join(tmp, 'candidate.bundle');

  git(['init', '--bare', originDir, '-b', 'main']);
  git(['init', builderDir, '-b', 'main']);
  git(['config', 'user.email', 'test@example.com'], { cwd: builderDir });
  git(['config', 'user.name', 'Test'], { cwd: builderDir });
  git(['remote', 'add', 'origin', `file://${originDir}`], { cwd: builderDir });

  writeFileSync(path.join(builderDir, 'base.txt'), 'base');
  git(['add', '.'], { cwd: builderDir });
  git(['commit', '-m', 'base'], { cwd: builderDir });
  const baseSha = git(['rev-parse', 'HEAD'], { cwd: builderDir });
  git(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: builderDir });

  writeFileSync(path.join(builderDir, 'candidate.txt'), 'candidate');
  git(['add', '.'], { cwd: builderDir });
  git(['commit', '-m', 'candidate'], { cwd: builderDir });
  const candidateSha = git(['rev-parse', 'HEAD'], { cwd: builderDir });

  git(['bundle', 'create', bundlePath, 'HEAD', `^${baseSha}`], { cwd: builderDir });

  // The validation checkout contains only trusted main, so the candidate object
  // can arrive only through the thin bundle under test.
  git(['clone', '--branch', 'main', '--single-branch', `file://${originDir}`, workDir]);

  return { tmp, originDir, workDir, baseSha, candidateSha, bundlePath };
}

/**
 * Store arbitrary content as a Git blob in the bare origin repo and return its SHA.
 * Uses `git hash-object -w` with a file path to avoid stdin encoding issues.
 */
function storeBlobInOrigin(originDir, filePath) {
  return execFileSync('git', ['hash-object', '-w', filePath], {
    stdio: 'pipe',
    env: { ...process.env, GIT_DIR: originDir },
  })
    .toString()
    .trim();
}

function updateRefInOrigin(originDir, ref, sha) {
  execFileSync('git', ['update-ref', ref, sha], {
    stdio: 'pipe',
    env: { ...process.env, GIT_DIR: originDir },
  });
}

function runScript(workDir, tmp, env) {
  const runnerTemp = path.join(tmp, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });
  return spawnSync('bash', [SCRIPT], {
    stdio: 'pipe',
    cwd: workDir,
    env: {
      ...process.env,
      ...GIT_CONFIG_ENV,
      RUNNER_TEMP: runnerTemp,
      ...env,
    },
  });
}

function cleanup(tmp) {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch (_) {
    /* ignore cleanup errors */
  }
}

materializeTest('materialize-candidate: valid thin bundle materializes and exits 0', () => {
  const { tmp, originDir, workDir, candidateSha, bundlePath } = setupRepos();
  try {
    const ref = 'refs/merge-train-candidates/candidate-1-valid';
    const blobSha = storeBlobInOrigin(originDir, bundlePath);
    updateRefInOrigin(originDir, ref, blobSha);

    const result = runScript(workDir, tmp, {
      CANDIDATE_REF: ref,
      CANDIDATE_SHA: candidateSha,
      GITHUB_TOKEN: 'fake-token-for-local-test',
    });
    assert.equal(
      result.status,
      0,
      `Expected exit 0 but got ${result.status}. stderr: ${result.stderr.toString()}`,
    );
  } finally {
    cleanup(tmp);
  }
});

materializeTest(
  'materialize-candidate: non-blob ref (commit SHA) is rejected before verification',
  () => {
    const { tmp, originDir, workDir, baseSha } = setupRepos();
    try {
      // Point the transport ref directly at a commit object (not a blob).
      const ref = 'refs/merge-train-candidates/candidate-1-nonblob';
      updateRefInOrigin(originDir, ref, baseSha);

      const result = runScript(workDir, tmp, {
        CANDIDATE_REF: ref,
        CANDIDATE_SHA: baseSha,
        GITHUB_TOKEN: 'fake-token-for-local-test',
      });
      assert.equal(result.status, 1, 'Expected exit 1 for non-blob ref');
      assert.ok(
        result.stderr.toString().includes('must resolve to a Git blob'),
        `Expected "must resolve to a Git blob" in stderr. Got: ${result.stderr.toString()}`,
      );
    } finally {
      cleanup(tmp);
    }
  },
);

materializeTest(
  'materialize-candidate: invalid (non-bundle) blob is rejected by bundle verify',
  () => {
    const { tmp, originDir, workDir, candidateSha } = setupRepos();
    try {
      // Write a temp file with non-bundle content, then store as blob in origin.
      const junkPath = path.join(tmp, 'junk.bin');
      writeFileSync(junkPath, 'this is not a valid git bundle file');
      const badBlob = storeBlobInOrigin(originDir, junkPath);

      const ref = 'refs/merge-train-candidates/candidate-1-badbundle';
      updateRefInOrigin(originDir, ref, badBlob);

      const result = runScript(workDir, tmp, {
        CANDIDATE_REF: ref,
        CANDIDATE_SHA: candidateSha,
        GITHUB_TOKEN: 'fake-token-for-local-test',
      });
      assert.equal(result.status, 1, 'Expected exit 1 for invalid bundle');
      // git bundle verify writes an error about v2/v3 format to stderr.
      const combined = result.stdout.toString() + result.stderr.toString();
      assert.ok(
        combined.includes('bundle') || combined.includes('v2') || combined.includes('v3'),
        `Expected bundle-verification error in output. Got: ${combined}`,
      );
    } finally {
      cleanup(tmp);
    }
  },
);

materializeTest(
  'materialize-candidate: SHA mismatch fails closed after bundle verification succeeds',
  () => {
    const { tmp, originDir, workDir, candidateSha, bundlePath } = setupRepos();
    try {
      const ref = 'refs/merge-train-candidates/candidate-1-shmismatch';
      const blobSha = storeBlobInOrigin(originDir, bundlePath);
      updateRefInOrigin(originDir, ref, blobSha);

      // Provide a wrong CANDIDATE_SHA so materialized SHA !== expected SHA.
      const wrongSha = 'a'.repeat(40);
      assert.notEqual(wrongSha, candidateSha, 'sanity: wrong SHA must differ from real SHA');

      const result = runScript(workDir, tmp, {
        CANDIDATE_REF: ref,
        CANDIDATE_SHA: wrongSha,
        GITHUB_TOKEN: 'fake-token-for-local-test',
      });
      assert.equal(result.status, 1, 'Expected exit 1 for SHA mismatch');
      assert.ok(
        result.stderr.toString().includes('SHA mismatch'),
        `Expected "SHA mismatch" in stderr. Got: ${result.stderr.toString()}`,
      );
    } finally {
      cleanup(tmp);
    }
  },
);
