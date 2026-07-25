/**
 * parseArgs unit tests for the reconcile-queue CLI shim.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/sprites/reconcile-queue-cli.js';

describe('reconcile-queue-cli parseArgs', () => {
  it('requires --repo-root', () => {
    expect(() => parseArgs([])).toThrow(/Missing required --repo-root/);
  });

  it('parses --repo-root with default options', () => {
    const { repoRoot, options } = parseArgs(['--repo-root', '/tmp/repo']);
    expect(repoRoot).toBe('/tmp/repo');
    expect(options.remote).toBeUndefined();
    expect(options.queueBranch).toBeUndefined();
    expect(options.promoteBranch).toBeUndefined();
    expect(options.baseBranch).toBeUndefined();
    expect(options.repo).toBeUndefined();
  });

  it('parses every override flag', () => {
    const { repoRoot, options } = parseArgs([
      '--repo-root',
      '/tmp/repo',
      '--remote',
      'upstream',
      '--queue-branch',
      'assets/q',
      '--promote-branch',
      'assets/p',
      '--base',
      'develop',
      '--repo',
      'owner/name',
    ]);
    expect(repoRoot).toBe('/tmp/repo');
    expect(options.remote).toBe('upstream');
    expect(options.queueBranch).toBe('assets/q');
    expect(options.promoteBranch).toBe('assets/p');
    expect(options.baseBranch).toBe('develop');
    expect(options.repo).toBe('owner/name');
  });

  it('throws when a flag is missing its value', () => {
    expect(() => parseArgs(['--repo-root'])).toThrow(/--repo-root requires a value/);
  });

  it('rejects unknown arguments', () => {
    expect(() => parseArgs(['--repo-root', '/tmp/repo', '--bogus'])).toThrow(
      /Unknown argument: --bogus/,
    );
  });
});
