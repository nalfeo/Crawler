import { describe, expect, it } from 'vitest';
import {
  buildVerifierCommand,
  hashVerifier,
  resolveTestProject,
  slugify,
  validatePack,
} from '../../../scripts/agent/velocity/task-pack';
import {
  TASK_PACK_SCHEMA,
  type TaskPack,
  type TaskSpec,
} from '../../../scripts/agent/velocity/types';

function task(overrides: Partial<TaskSpec> = {}): TaskSpec {
  const verifierFiles = [{ path: 'tests/unit/foo.test.ts', contents: 'expect(1).toBe(1)' }];
  const verifierCommand = buildVerifierCommand(['tests/unit/foo.test.ts']);
  return {
    id: 'pr42-add-foo',
    prNumber: 42,
    title: 'Add foo',
    baseCommit: 'b'.repeat(40),
    solutionCommit: 'c'.repeat(40),
    prompt: 'Implement foo. Acceptance: tests/unit/foo.test.ts must pass.',
    verifierCommand,
    verifierFiles,
    verifierHash: hashVerifier(verifierCommand, verifierFiles),
    solutionFiles: ['src/core/foo.ts'],
    ...overrides,
  };
}

function pack(tasks: TaskSpec[]): TaskPack {
  return {
    schema: TASK_PACK_SCHEMA,
    id: 'test-pack',
    createdAt: '2026-07-25T00:00:00.000Z',
    repo: 'git@github.com:nalfeo/Crawler.git',
    tasks,
  };
}

describe('resolveTestProject', () => {
  it('maps tests/ecs into the unit project, matching vitest.config.ts', () => {
    expect(resolveTestProject(['tests/ecs/drop-system.test.ts'])).toBe('unit');
    expect(resolveTestProject(['tests/unit/a.test.ts', 'tests/property/b.test.ts'])).toBe('unit');
  });

  it('rejects a verifier that spans projects, which would run only a partial suite', () => {
    expect(() => resolveTestProject(['tests/unit/a.test.ts', 'tests/headless/b.test.ts'])).toThrow(
      /multiple vitest projects/,
    );
  });

  it('rejects a test file in no known project rather than emitting a no-op verifier', () => {
    expect(() => resolveTestProject(['tests/nowhere/a.test.ts'])).toThrow(
      /no known vitest project/,
    );
  });
});

describe('buildVerifierCommand', () => {
  it('pins the project and the exact files', () => {
    expect(buildVerifierCommand(['tests/unit/a.test.ts'])).toBe(
      'npx vitest run --project unit "tests/unit/a.test.ts"',
    );
  });
});

describe('slugify', () => {
  it('produces a stable, filesystem-safe slug', () => {
    expect(slugify('Fix: HUD overlap (again!)')).toBe('fix-hud-overlap-again');
  });

  it('caps length so task ids stay usable as directory names', () => {
    expect(slugify('x'.repeat(200)).length).toBeLessThanOrEqual(48);
  });
});

describe('hashVerifier', () => {
  it('is order-independent across verifier files', () => {
    const a = [
      { path: 'tests/a.test.ts', contents: 'a' },
      { path: 'tests/b.test.ts', contents: 'b' },
    ];
    const b = [
      { path: 'tests/b.test.ts', contents: 'b' },
      { path: 'tests/a.test.ts', contents: 'a' },
    ];
    expect(hashVerifier('cmd', a)).toBe(hashVerifier('cmd', b));
  });

  it('changes when any verifier byte changes', () => {
    const base = [{ path: 'tests/a.test.ts', contents: 'a' }];
    expect(hashVerifier('cmd', base)).not.toBe(
      hashVerifier('cmd', [{ path: 'tests/a.test.ts', contents: 'a ' }]),
    );
  });

  it('changes when the verifier command changes', () => {
    const files = [{ path: 'tests/a.test.ts', contents: 'a' }];
    expect(hashVerifier('cmd', files)).not.toBe(hashVerifier('other', files));
  });
});

describe('validatePack', () => {
  it('accepts a well-formed pack', () => {
    expect(validatePack(pack([task()]))).toEqual([]);
  });

  it('detects a verifier edited after the pack was frozen', () => {
    const tampered = task();
    tampered.verifierFiles[0]!.contents = 'expect(1).toBe(2)';
    const problems = validatePack(pack([tampered]));
    expect(problems.join('\n')).toMatch(/verifier hash mismatch/);
  });

  it('rejects a prompt that names a solution file', () => {
    const leaky = task({ prompt: 'Edit src/core/foo.ts to add foo.' });
    expect(validatePack(pack([leaky])).join('\n')).toMatch(/names solution file/);
  });

  it('rejects a prompt that leaks the solution commit', () => {
    const leaky = task({ prompt: `See ${'c'.repeat(40)} for the change.` });
    expect(validatePack(pack([leaky])).join('\n')).toMatch(/leaks the solution commit/);
  });

  it('rejects duplicate task ids and empty packs', () => {
    expect(validatePack(pack([task(), task()])).join('\n')).toMatch(/duplicate task id/i);
    expect(validatePack(pack([])).join('\n')).toMatch(/no tasks/i);
  });

  it('rejects an unknown schema', () => {
    const wrong = { ...pack([task()]), schema: 'nope' } as unknown as TaskPack;
    expect(validatePack(wrong).join('\n')).toMatch(/unknown schema/i);
  });
});
