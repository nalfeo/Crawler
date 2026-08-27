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

let tempDir: string;
let fakeNpm: string;
let logFile: string;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), 'asset-request-pipeline-'));
  fakeNpm = path.join(tempDir, 'fake-npm.sh');
  logFile = path.join(tempDir, 'events.log');
  writeFileSync(
    fakeNpm,
    `#!/usr/bin/env bash
set -u
command_name="\${2:-}"
case "$command_name" in
  sprites:worker)
    echo "worker-start secret=\${AZURE_OPENAI_API_KEY:-absent}" >> "$PIPELINE_TEST_LOG"
    trap 'echo worker-term >> "$PIPELINE_TEST_LOG"; exit 0' TERM INT
    if [[ "\${PIPELINE_TEST_MODE:-success}" == "worker-preexit" ]]; then
      exit 0
    fi
    while [[ ! -e "$SPRITES_WORKER_PRODUCER_COMPLETE_FILE" ]]; do sleep 0.01; done
    echo "worker-marker" >> "$PIPELINE_TEST_LOG"
    ;;
  sprites:ingest-once)
    echo "ingest-start secret=\${AZURE_OPENAI_API_KEY:-absent}" >> "$PIPELINE_TEST_LOG"
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
      PIPELINE_TEST_MODE: mode,
      AZURE_OPENAI_API_KEY: 'worker-secret',
    }),
  });
  const log = readFileSync(logFile, 'utf8').trim().split(/\r?\n/);
  return { result, log, marker };
}

describe('asset-request pipeline coordinator', () => {
  it('marks producer completion only after ingest and keeps provider secrets worker-scoped', () => {
    const { result, log, marker } = run('success');

    expect(result.status).toBe(0);
    expect(log).toEqual([
      'worker-start secret=worker-secret',
      'ingest-start secret=absent',
      'ingest-done',
      'worker-marker',
    ]);
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

  it('maps TERM to 143 and cleans up the worker and marker', () => {
    const { result, log, marker } = run('signal');

    expect(result.status).toBe(143);
    expect(log).toContain('worker-term');
    expect(log).not.toContain('worker-marker');
    expect(() => readFileSync(marker)).toThrow();
  });
});
