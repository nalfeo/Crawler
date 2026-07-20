import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashEnv, toBashScriptPath } from '../helpers/bash-script-path';

/**
 * Executable regression coverage for the security boundary in
 * `materialize-candidate.sh`: the step that turns an untrusted, opaque
 * candidate bundle (transported only as a Git blob, never a real commit
 * object) back into a real commit that later CI steps will build/check on
 * trusted infrastructure.
 *
 * Prior coverage only asserted the workflow YAML step *text*
 * (`merge-train-validation-sharding.test.ts`), never actually ran the
 * script, so a regression in the fail-closed branches (non-blob transport
 * ref, corrupt bundle, SHA-confusion) would not be caught. These tests
 * execute the real script via bash against real temporary Git repositories
 * for the happy path and each fail-closed branch.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCRIPT_PATH = path.join(REPO_ROOT, '.github/scripts/merge-train/materialize-candidate.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const TRANSPORT_REF = 'refs/merge-train-candidates/pr-1';

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function initRepo(dir: string): void {
  git(['init', '--quiet'], dir);
  git(['config', 'user.email', 'train@example.invalid'], dir);
  git(['config', 'user.name', 'Merge Train Test'], dir);
}

function commit(dir: string, file: string, contents: string, message: string): string {
  writeFileSync(path.join(dir, file), contents);
  git(['add', file], dir);
  git(['commit', '--quiet', '-m', message], dir);
  return git(['rev-parse', 'HEAD'], dir);
}

/**
 * Builds a standalone source repository with a single candidate commit and
 * bundles it exactly the way `buildCandidate` does in the real pipeline:
 * `git bundle create <file> HEAD` after checking the candidate out, so the
 * bundle's only advertised ref is literally `HEAD` -- matching what
 * `materialize-candidate.sh` fetches (`HEAD:${candidate_ref}`).
 */
function buildCandidateBundle(workdir: string): { sha: string; bundlePath: string } {
  const sourceDir = mkdtempSync(path.join(workdir, 'src-'));
  initRepo(sourceDir);
  const sha = commit(sourceDir, 'file.txt', 'candidate contents\n', 'candidate commit');
  const bundlePath = path.join(sourceDir, 'bundle.file');
  git(['bundle', 'create', bundlePath, 'HEAD'], sourceDir);
  return { sha, bundlePath };
}

/** Writes arbitrary bytes into `originRepo`'s object DB and points the
 * candidate transport ref at the resulting blob -- the same mechanism the
 * real orchestrator uses to publish an opaque candidate for the runner. */
function publishTransportBlob(originRepo: string, contentPath: string): string {
  const blobSha = execFileSync('git', ['hash-object', '-w', contentPath], {
    cwd: originRepo,
    encoding: 'utf8',
  }).trim();
  git(['update-ref', TRANSPORT_REF, blobSha], originRepo);
  return blobSha;
}

describe.skipIf(!hasBash)('materialize-candidate.sh', () => {
  let workdir: string;
  let originRepo: string;
  let workRepo: string;
  let runnerTemp: string;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(tmpdir(), 'materialize-candidate-'));
    originRepo = path.join(workdir, 'origin');
    workRepo = path.join(workdir, 'work');
    runnerTemp = path.join(workdir, 'runner-temp');
    mkdirSync(originRepo);
    mkdirSync(workRepo);
    mkdirSync(runnerTemp);
    initRepo(originRepo);
    initRepo(workRepo);
    // The remote URL is read by whichever `git` binary the bash script
    // resolves at runtime (which, under WSL, is a different `git` than the
    // one Node's execFileSync used to build the fixture repos above), so it
    // must be translated the same way the script path itself is.
    git(['remote', 'add', 'origin', toBashScriptPath(originRepo)], workRepo);
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
  });

  function runScript(candidateSha: string, candidateRef = TRANSPORT_REF) {
    const command = `cd "${toBashScriptPath(workRepo)}" && bash "${toBashScriptPath(SCRIPT_PATH)}"`;
    return spawnSync('bash', ['-c', command], {
      encoding: 'utf8',
      env: bashEnv({
        CANDIDATE_REF: candidateRef,
        CANDIDATE_SHA: candidateSha,
        GITHUB_TOKEN: 'fake-token-not-a-real-secret',
        RUNNER_TEMP: toBashScriptPath(runnerTemp),
      }),
    });
  }

  it('materializes a valid candidate bundle and checks out exactly the claimed SHA', () => {
    const { sha, bundlePath } = buildCandidateBundle(workdir);
    publishTransportBlob(originRepo, bundlePath);

    const result = runScript(sha);

    expect(result.status, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`).toBe(0);
    expect(git(['rev-parse', 'HEAD'], workRepo)).toBe(sha);
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], workRepo)).toBe('HEAD'); // detached
    expect(git(['status', '--porcelain'], workRepo)).toBe('');
  });

  it('fails closed when the transport ref does not resolve to a Git blob', () => {
    // Publish a real commit at the transport ref instead of a blob -- e.g. a
    // confused or forged publisher pointing at a commit object directly.
    const seedSha = commit(originRepo, 'seed.txt', 'seed\n', 'seed commit');
    git(['update-ref', TRANSPORT_REF, seedSha], originRepo);

    const result = runScript(seedSha);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('must resolve to a Git blob');
    // Must fail before ever touching HEAD in the work repo.
    expect(git(['symbolic-ref', '-q', 'HEAD'], workRepo)).not.toBe('');
  });

  it('fails closed on a malformed/corrupt bundle blob', () => {
    const garbagePath = path.join(workdir, 'garbage.bin');
    writeFileSync(garbagePath, 'not-a-real-git-bundle-just-garbage-bytes\n');
    publishTransportBlob(originRepo, garbagePath);
    const fakeSha = 'a'.repeat(40);

    const result = runScript(fakeSha);

    expect(result.status).not.toBe(0);
    // `git bundle verify` must be the thing that rejects it, before the
    // script ever attempts to fetch/checkout anything from it.
    expect(() => git(['rev-parse', 'refs/merge-train-validation/candidate'], workRepo)).toThrow();
    expect(git(['symbolic-ref', '-q', 'HEAD'], workRepo)).not.toBe('');
  });

  it('fails closed when the materialized commit SHA does not match the claimed CANDIDATE_SHA', () => {
    const { sha, bundlePath } = buildCandidateBundle(workdir);
    publishTransportBlob(originRepo, bundlePath);
    const wrongSha = 'f'.repeat(40);
    expect(wrongSha).not.toBe(sha);

    const result = runScript(wrongSha);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Candidate bundle SHA mismatch');
    // Must never check out the mismatched commit onto the work repo's HEAD.
    expect(git(['symbolic-ref', '-q', 'HEAD'], workRepo)).not.toBe('');
  });
});
