import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SECURITY_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/security-review.yml');
const TEST_HEALTH_WORKFLOW = path.join(REPO_ROOT, '.github/workflows/test-health.yml');

describe('retired health issue automation', () => {
  it('removes the scheduled test-health workflow', () => {
    expect(existsSync(TEST_HEALTH_WORKFLOW)).toBe(false);
  });

  it('keeps security review PR-only without issue filing permissions or commands', () => {
    const source = readFileSync(SECURITY_WORKFLOW, 'utf8');
    const workflow = parse(source) as {
      on?: Record<string, unknown>;
      permissions?: Record<string, string>;
      jobs?: Record<string, unknown>;
    };

    expect(Object.keys(workflow.on ?? {})).toEqual(['pull_request']);
    expect(workflow.permissions?.issues).toBeUndefined();
    expect(workflow.jobs?.['aggregate-results']).toBeUndefined();
    expect(source).not.toContain('gh issue create');
    expect(source).not.toContain('security-review: scheduled report');
  });
});
