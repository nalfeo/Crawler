import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bashEnv, toBashScriptPath } from '../../helpers/bash-script-path.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const SCRIPT = toBashScriptPath(
  path.join(REPO_ROOT, 'scripts', 'sprites', 'asset-request-pipeline.sh'),
);

// The coordinator is a Bash script, so this suite can only run where a `bash`
// binary is resolvable; skip rather than fail on environments without one.
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;

let tempDir: string;
let fakeNpm: string;
let logFile: string;
let childPidFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'asset-request-pipeline-'));
  fakeNpm = path.join(tempDir, 'fake-npm.sh');
  logFile = path.join(tempDir, 'events.log');
  childPidFile = path.join(tempDir, 'worker-child.pid');
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env bash
set -u
command_name="\${2:-}"
case "$command_name" in
  sprites:worker)
    echo "worker-start secret=\${AZURE_OPENAI_API_KEY:-absent}" >> "$PIPELINE_TEST_LOG"
    # Stand in for the real npm -> tsx -> node tree: a descendant that never
    # sees a signal aimed only at this launcher PID.
    sleep 30 &
    echo $! > "$PIPELINE_TEST_CHILD_PID_FILE"
    trap 'echo worker-term >> "$PIPELINE_TEST_LOG"; exit 0' TERM INT
    if [[ "\${PIPELINE_TEST_MODE:-success}" == "worker-preexit" ]]; then
      exit 0
    fi
    while [[ ! -e "$SPRITES_WORKER_PRODUCER_COMPLETE_FILE" ]]; do sleep 0.01; done
    echo "worker-marker" >> "$PIPELINE_TEST_LOG"
    ;;
  sprites:ingest-once)
    echo "ingest-start secret=\${AZURE_OPENAI_API_KEY:-absent}" >> "$PIPELINE_TEST_LOG"
    # Deterministic ordering: never finish before the worker fixture has
    # recorded its descendant PID, so the assertions always have a handle.
    for _ in $(seq 1 1000); do
      [[ -s "$PIPELINE_TEST_CHILD_PID_FILE" ]] && break
      sleep 0.01
    done
    case "\${PIPELINE_TEST_MODE:-success}" in
      producer-fail) exit 7 ;;
      signal) kill -TERM "$PPID"; exit 0 ;;
      *) sleep 0.05; echo "ingest-done" >> "$PIPELINE_TEST_LOG" ;;
    esac
    ;;
  *) exit 9 ;;
esac
`,
  );
  chmodSync(fakeNpm, 0o755);
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function run(mode: string) {
  const marker = path.join(tempDir, 'producer.complete');
  const result = spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 5_000,
    env: bashEnv({
      SPRITES_PIPELINE_NPM_BIN: toBashScriptPath(fakeNpm),
      SPRITES_WORKER_PRODUCER_COMPLETE_FILE: toBashScriptPath(marker),
      PIPELINE_TEST_LOG: toBashScriptPath(logFile),
      PIPELINE_TEST_CHILD_PID_FILE: toBashScriptPath(childPidFile),
      PIPELINE_TEST_MODE: mode,
      AZURE_OPENAI_API_KEY: 'worker-secret',
    }),
  });
  const log = readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
  const workerChildPid = Number.parseInt(readFileSync(childPidFile, 'utf8').trim(), 10);
  return { result, log, marker, workerChildPid };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * `stop_worker_group` escalates to `kill -KILL -- -<pgid>` and returns without
 * waiting: the descendant it targets has been orphaned by its own launcher, so
 * it is reparented to init and only init can reap it. SIGKILL delivery plus
 * that reap is asynchronous, which means `process.kill(pid, 0)` can still
 * succeed for a short window after the coordinator exits — an assertion taken
 * at the instant `spawnSync` returns is a race that flakes under CI load
 * (run 34028158304). Poll for the descendant to disappear instead; a survivor
 * still fails the test once the budget is spent.
 */
async function waitForExit(pid: number, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (isAlive(pid)) {
    if (Date.now() >= deadline) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe.skipIf(!hasBash)('asset-request pipeline coordinator', () => {
  it('marks producer completion only after ingest and keeps provider secrets worker-scoped', () => {
    const { result, log, marker } = run('success');

    expect(result.status).toBe(0);
    expect(log).toHaveLength(4);
    expect(log).toContain('worker-start secret=worker-secret');
    expect(log).toContain('ingest-start secret=absent');
    expect(log.indexOf('ingest-done')).toBeGreaterThan(log.indexOf('ingest-start secret=absent'));
    expect(log.indexOf('worker-marker')).toBeGreaterThan(log.indexOf('ingest-done'));
    expect(() => readFileSync(marker)).toThrow();
  });

  it('preserves producer failure and terminates the waiting worker without creating the marker', () => {
    const { result, log, marker } = run('producer-fail');

    expect(result.status).toBe(7);
    expect(log).toContain('worker-term');
    expect(log).not.toContain('worker-marker');
    expect(() => readFileSync(marker)).toThrow();
  });

  it('fails loudly when the worker exits before producer completion', () => {
    const { result, log } = run('worker-preexit');

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('worker exited before producer completion');
    expect(log).not.toContain('worker-marker');
  });

  it('kills worker descendants when the producer fails', async () => {
    const { workerChildPid } = run('producer-fail');

    expect(Number.isInteger(workerChildPid)).toBe(true);
    expect(await waitForExit(workerChildPid)).toBe(false);
  });

  it('kills worker descendants when the launcher exits before producer completion', async () => {
    const { workerChildPid } = run('worker-preexit');

    expect(Number.isInteger(workerChildPid)).toBe(true);
    expect(await waitForExit(workerChildPid)).toBe(false);
  });

  it('maps TERM to 143 and cleans up the worker and marker', () => {
    const { result, log, marker } = run('signal');

    expect(result.status).toBe(143);
    expect(log).toContain('worker-term');
    expect(log).not.toContain('worker-marker');
    expect(() => readFileSync(marker)).toThrow();
  });
});
