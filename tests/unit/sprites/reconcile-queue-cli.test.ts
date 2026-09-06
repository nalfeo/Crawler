/**
 * parseArgs unit tests for the reconcile-queue CLI shim.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  COMBINED_RECONCILE_WARNING_EXIT_CODE,
  parseArgs,
  QUARANTINED_SOURCE_EXIT_CODE,
  reconcileResultExitCode,
  REJECTED_LIFECYCLE_DELETION_EXIT_CODE,
} from '../../../scripts/sprites/reconcile-queue-cli.js';

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

  it('fails the workflow when lifecycle deletion convergence is refused', () => {
    expect(reconcileResultExitCode({})).toBe(0);
    expect(reconcileResultExitCode({ rejectedLifecycleDeletions: [] })).toBe(0);
    expect(
      reconcileResultExitCode({
        rejectedLifecycleDeletions: [
          { annotationKey: 'rat-var-0', reason: 'mismatch', paths: ['generated/rat-var-0.png'] },
        ],
      }),
    ).toBe(REJECTED_LIFECYCLE_DELETION_EXIT_CODE);

    const workflow = readFileSync('.github/workflows/sprite-queue-reconciler.yml', 'utf8');
    expect(workflow).toContain("steps.reconcile.outputs.exit_code == '31'");
    expect(workflow).toContain('::error title=Sprite lifecycle convergence refused::');
  });

  it('fails the workflow when a source snapshot is quarantined', () => {
    expect(
      reconcileResultExitCode({
        quarantinedSources: [
          {
            sourceRef: 'origin/assets/checkin-broken',
            reason: 'malformed candidate shard',
            paths: ['public/assets/generated/entries/broken.json'],
          },
        ],
      }),
    ).toBe(QUARANTINED_SOURCE_EXIT_CODE);
    expect(
      reconcileResultExitCode({
        rejectedLifecycleDeletions: [
          { annotationKey: 'rat-var-0', reason: 'mismatch', paths: ['generated/rat-var-0.png'] },
        ],
        quarantinedSources: [
          {
            sourceRef: 'origin/assets/checkin-broken',
            reason: 'malformed candidate shard',
            paths: ['public/assets/generated/entries/broken.json'],
          },
        ],
      }),
    ).toBe(COMBINED_RECONCILE_WARNING_EXIT_CODE);

    const workflow = readFileSync('.github/workflows/sprite-queue-reconciler.yml', 'utf8');
    expect(workflow).toContain("steps.reconcile.outputs.exit_code == '32'");
    expect(workflow).toContain("steps.reconcile.outputs.exit_code == '33'");
    expect(workflow).toContain('::error title=Sprite source quarantined::');
  });
});
