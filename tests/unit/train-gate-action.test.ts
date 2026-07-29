import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

interface CompositeActionDoc {
  description?: string;
  inputs?: Record<string, { description?: string }>;
}

function loadTrainGateAction(): CompositeActionDoc {
  return parse(
    readFileSync(path.join(REPO_ROOT, '.github/actions/train-gate/action.yml'), 'utf8'),
  ) as CompositeActionDoc;
}

describe('train-gate composite action manifest', () => {
  it('keeps human-readable metadata free of GitHub expression syntax', () => {
    const action = loadTrainGateAction();
    expect(action.description).not.toContain('${{');
    for (const input of Object.values(action.inputs ?? {})) {
      expect(input.description).not.toContain('${{');
    }
  });
});
