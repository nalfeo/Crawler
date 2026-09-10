import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('agent environment parity', () => {
  it('keeps runtime versions in canonical version files', () => {
    expect(read('.node-version').trim()).toBe('22.23.2');
    expect(read('.python-version').trim()).toBe('3.12.10');

    const setupNode = parse(read('.github/actions/setup-node/action.yml'));
    const runtimeStep = setupNode.runs.steps.find(
      (step: { uses?: string }) => step.uses === 'actions/setup-node@v4',
    );
    expect(runtimeStep.with['node-version-file']).toBe('.node-version');
    expect(runtimeStep.with['node-version']).toBeUndefined();
  });

  it.each(['.github/workflows/copilot-setup-steps.yml', '.github/workflows/ci.yml'])(
    '%s consumes the shared runtime and bootstrap contract',
    (workflowPath) => {
      const workflow = read(workflowPath);
      expect(workflow).toContain("python-version-file: '.python-version'");
      expect(workflow).toContain('node scripts/agent/setup-environment.mjs --skip-npm');
    },
  );

  it('makes Codex consume the same bootstrap contract', () => {
    const environment = read('.codex/environments/environment.toml');
    expect(environment).toContain('version = 1');
    expect(environment).toContain('script = "node scripts/agent/setup-environment.mjs"');
  });

  it('keeps dependency inputs centralized in the shared bootstrap', () => {
    const bootstrap = read('scripts/agent/setup-environment.mjs');
    expect(bootstrap).toContain("'../../.node-version'");
    expect(bootstrap).toContain("'../../.python-version'");
    expect(bootstrap).toContain('scripts/sprites/proper-pixel-art-requirements.txt');
  });
});
