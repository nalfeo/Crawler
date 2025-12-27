import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Regression coverage for the "trust an attested merge-train check-run as
 * promotion provenance" bash embedded in ci.yml and security-review.yml.
 *
 * Both blocks must ONLY honor the check-run shortcut while
 * vars.MERGE_TRAIN_ENABLED == 'true'. Otherwise, rolling the flag back to
 * false would not restore full CI/security checks for a head that still
 * carries a leftover (or forged) successful "merge-train" check-run from
 * before rollback — exactly the gap a prior review round found.
 *
 * This test extracts the REAL `run:` block text from each workflow file (no
 * reimplementation), templates only the `${{ }}` expressions GitHub Actions
 * would have substituted, and executes it for real via bash with a stubbed
 * `gh` on PATH (jq runs for real), so a regression that removes the gate
 * would be caught even if it were reworded.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const hasJq = spawnSync('bash', ['-c', 'command -v jq']).status === 0;

// A fabricated check-runs response with a fully valid, trusted, successful
// "merge-train" attestation — the strongest possible (fake) evidence that the
// gate must still reject once MERGE_TRAIN_ENABLED is not 'true'.
const TRUSTED_APP_ID = '987654';
const FAKE_CHECK_RUNS = JSON.stringify({
  check_runs: [
    {
      name: 'merge-train',
      status: 'completed',
      conclusion: 'success',
      app: { id: Number(TRUSTED_APP_ID) },
      external_id: 'a'.repeat(64),
      id: 1,
    },
  ],
});

function extractRunBlock(fileText: string, stepName: string): string {
  const stepIndex = fileText.indexOf(`- name: ${stepName}`);
  if (stepIndex === -1) throw new Error(`step "${stepName}" not found`);
  const runMarker = 'run: |\n';
  const runIndex = fileText.indexOf(runMarker, stepIndex);
  if (runIndex === -1) throw new Error(`"run: |" not found after step "${stepName}"`);
  const bodyStart = runIndex + runMarker.length;
  const lines = fileText.slice(bodyStart).split('\n');
  const blockLines: string[] = [];
  for (const line of lines) {
    // The run block is indented 10 spaces under this step; a line that is
    // blank or starts with at least that indent belongs to the block. The
    // first less-indented, non-blank line ends it.
    if (line.trim() === '' || line.startsWith('          ')) {
      blockLines.push(line.startsWith('          ') ? line.slice(10) : line);
    } else {
      break;
    }
  }
  return blockLines.join('\n');
}

function templateExpressions(script: string, values: Record<string, string>): string {
  let result = script;
  for (const [expr, value] of Object.entries(values)) {
    result = result.split(`\${{ ${expr} }}`).join(value);
  }
  return result;
}

type GhStubOptions = {
  body: string;
  exitCode?: number;
};

function writeGhStub(workdir: string, { body, exitCode = 0 }: GhStubOptions): void {
  const ghStub = path.join(workdir, 'gh');
  writeFileSync(ghStub, `#!/usr/bin/env bash\ncat <<'EOF'\n${body}\nEOF\nexit ${exitCode}\n`);
  chmodSync(ghStub, 0o755);
}

describe.skipIf(!hasBash || !hasJq)('merge-train promotion check gating (ci.yml)', () => {
  let workdir: string;
  let githubOutput: string;

  beforeEach(() => {
    workdir = mkdtempSync(path.join(tmpdir(), 'train-gate-ci-'));
    githubOutput = path.join(workdir, 'github_output');
    writeFileSync(githubOutput, '');
  });

  function runCiScope(
    eventName: 'push' | 'pull_request',
    mergeTrainEnabled: string,
    ghStubOptions: GhStubOptions = { body: FAKE_CHECK_RUNS },
  ): Record<string, string> {
    const raw = readFileSync(path.join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
    const block = extractRunBlock(raw, 'Preserve train-promoted head evidence');
    const templated = templateExpressions(block, {
      'steps.detect.outputs.art_only': 'false',
      'steps.detect.outputs.docs_only': 'false',
      'steps.detect.outputs.gameplay_safe': 'false',
      'steps.detect.outputs.sprites_only': 'false',
      'steps.detect.outputs.sprites_touched': 'false',
      'github.event_name': eventName,
      'vars.MERGE_TRAIN_ENABLED': mergeTrainEnabled,
    });

    // Stub `gh` so the real jq filter runs against a fabricated, otherwise
    // fully-trusted, successful merge-train check-run.
    writeGhStub(workdir, ghStubOptions);

    const res = spawnSync('bash', ['-c', templated], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${workdir}${path.delimiter}${process.env.PATH}`,
        GITHUB_OUTPUT: githubOutput,
        GITHUB_REPOSITORY: 'nalfeo/Crawler',
        TARGET_SHA: 'deadbeef',
        MERGE_TRAIN_APP_ID: TRUSTED_APP_ID,
      },
    });
    if (res.status !== 0) {
      throw new Error(
        `script exited ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
      );
    }
    const output = readFileSync(githubOutput, 'utf8');
    const values: Record<string, string> = {};
    for (const line of output.split('\n')) {
      const match = line.match(/^([a-z_]+)=(.*)$/);
      const key = match?.[1];
      const value = match?.[2];
      if (key !== undefined && value !== undefined) values[key] = value;
    }
    return values;
  }

  afterEach(() => {
    // mkdtempSync cleanup is best-effort; the OS temp dir reaps orphans.
  });

  it('does NOT trust a fabricated merge-train check-run when the flag is off', () => {
    for (const eventName of ['push', 'pull_request'] as const) {
      const out = runCiScope(eventName, 'false');
      expect(out.docs_only, `docs_only for ${eventName}`).toBe('false');
      expect(out.train_promoted, `train_promoted for ${eventName}`).toBe('false');
    }
  });

  it('trusts a genuine merge-train check-run only when the flag is exactly true', () => {
    const out = runCiScope('push', 'true');
    expect(out.docs_only).toBe('true');
    expect(out.train_promoted).toBe('true');
  });

  it('does not trust the check-run when the flag value is not the exact string "true"', () => {
    const out = runCiScope('push', 'True');
    expect(out.docs_only).toBe('false');
    expect(out.train_promoted).toBe('false');
  });

  it('fails open to full CI when check-runs output is not valid JSON', () => {
    const out = runCiScope('pull_request', 'true', {
      body: '<!DOCTYPE html><html>bad gateway</html>',
    });
    expect(out.docs_only).toBe('false');
    expect(out.train_promoted).toBe('false');
  });
});

describe.skipIf(!hasBash || !hasJq)(
  'merge-train promotion check gating (security-review.yml)',
  () => {
    let workdir: string;
    let githubOutput: string;

    beforeEach(() => {
      workdir = mkdtempSync(path.join(tmpdir(), 'train-gate-sec-'));
      githubOutput = path.join(workdir, 'github_output');
      writeFileSync(githubOutput, '');
    });

    function runSecurityScope(
      mergeTrainEnabled: string,
      ghStubOptions: GhStubOptions = { body: FAKE_CHECK_RUNS },
    ): Record<string, string> {
      const raw = readFileSync(
        path.join(REPO_ROOT, '.github/workflows/security-review.yml'),
        'utf8',
      );
      const block = extractRunBlock(raw, 'Normalize scope for security review');
      const templated = templateExpressions(block, {
        'steps.detect.outputs.docs_only': 'false',
        'steps.detect.outputs.art_only': 'false',
        'steps.detect.outputs.dependencies_touched': 'false',
        'steps.detect.outputs.ai_code_touched': 'false',
        'steps.detect.outputs.codeowners_touched': 'false',
        'github.event_name': 'pull_request',
        'vars.MERGE_TRAIN_ENABLED': mergeTrainEnabled,
      });

      writeGhStub(workdir, ghStubOptions);

      const res = spawnSync('bash', ['-c', templated], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${workdir}${path.delimiter}${process.env.PATH}`,
          GITHUB_OUTPUT: githubOutput,
          GITHUB_REPOSITORY: 'nalfeo/Crawler',
          PR_HEAD_SHA: 'deadbeef',
          MERGE_TRAIN_APP_ID: TRUSTED_APP_ID,
        },
      });
      if (res.status !== 0) {
        throw new Error(
          `script exited ${res.status}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`,
        );
      }
      const output = readFileSync(githubOutput, 'utf8');
      const values: Record<string, string> = {};
      for (const line of output.split('\n')) {
        const match = line.match(/^([a-z_]+)=(.*)$/);
        const key = match?.[1];
        const value = match?.[2];
        if (key !== undefined && value !== undefined) values[key] = value;
      }
      return values;
    }

    afterEach(() => {
      // mkdtempSync cleanup is best-effort; the OS temp dir reaps orphans.
    });

    it('does NOT trust a fabricated merge-train check-run when the flag is off', () => {
      const out = runSecurityScope('false');
      expect(out.docs_only).toBe('false');
      expect(out.train_promoted).toBe('false');
    });

    it('trusts a genuine merge-train check-run only when the flag is exactly true', () => {
      const out = runSecurityScope('true');
      expect(out.docs_only).toBe('true');
      expect(out.train_promoted).toBe('true');
    });

    it('fails open to full security checks when check-runs output is not valid JSON', () => {
      const out = runSecurityScope('true', { body: '<!DOCTYPE html><html>bad gateway</html>' });
      expect(out.docs_only).toBe('false');
      expect(out.train_promoted).toBe('false');
    });
  },
);
