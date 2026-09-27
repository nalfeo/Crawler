import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');

it('keeps the dependency-free verify:fast bootstrap regressions in the unit gate', () => {
  const result = spawnSync(
    process.execPath,
    ['--test', 'scripts/agent/verify-fast-bootstrap.test.mjs'],
    { cwd: ROOT, encoding: 'utf8' },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
});

describe.each(['crawler-feature-pr', 'crawler-pr-remediation'])('%s local-ci', (workflow) => {
  const definition = parse(
    readFileSync(path.join(ROOT, `.goobers/gaggles/crawler/workflows/${workflow}.yaml`), 'utf8'),
  ) as {
    spec: { tasks: Array<{ name: string; run: { script?: string }; next?: string }> };
  };
  const stage = definition.spec.tasks.find((task) => task.name === 'local-ci')!;

  // Execute the actual stage shell with an empty dependency state. Stub only
  // npm's external effects, so ordering and shell failure handling stay real.
  function runStage(installStatus: number, verifyStatus: number) {
    expect(stage.run.script).toBeTruthy();
    return spawnSync(
      'bash',
      [
        '-c',
        `
ready=0
npm() {
  printf '%s\\n' "$*"
  case "$*" in
    'ci --ignore-scripts')
      [ "$INSTALL_STATUS" = 0 ] || return "$INSTALL_STATUS"
      ready=1
      ;;
    'run verify:fast')
      [ "$ready" = 1 ] || return 99
      return "$VERIFY_STATUS"
      ;;
    *) return 98 ;;
  esac
}
${stage.run.script}`,
      ],
      {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          INSTALL_STATUS: String(installStatus),
          VERIFY_STATUS: String(verifyStatus),
        },
      },
    );
  }

  it('installs dependencies in its own worktree before running the unchanged gate', () => {
    const result = runStage(0, 0);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split('\n')).toEqual(['ci --ignore-scripts', 'run verify:fast']);
    expect(stage.next).toBe('local-gate');
  });

  it('stops before verification when installation fails', () => {
    const result = runStage(17, 0);
    expect(result.status).toBe(17);
    expect(result.stdout.trim()).toBe('ci --ignore-scripts');
  });

  it('preserves verification failures after successful installation', () => {
    const result = runStage(0, 23);
    expect(result.status).toBe(23);
    expect(result.stdout.trim().split('\n')).toEqual(['ci --ignore-scripts', 'run verify:fast']);
  });
});
