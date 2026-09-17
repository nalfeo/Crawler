import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspect, parseManifest } from '../../scripts/agent/inspect';

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'crawler-inspect-'));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ scripts: { check: 'node check.mjs' } }),
  );
  writeFileSync(join(root, 'a.txt'), 'alpha\nbeta\ngamma\n');
  writeFileSync(join(root, 'b.txt'), 'beta\n');
  return root;
}

describe('agent:inspect', () => {
  it('preserves manifest order across independent requests', () => {
    const root = fixture();
    try {
      const output = inspect(
        parseManifest({
          requests: [
            { kind: 'package-script', name: 'check' },
            { kind: 'file', path: 'a.txt', lineCount: 1 },
            { kind: 'search', pattern: 'beta' },
          ],
        }),
        root,
      );
      expect(output).toMatch(/## 1\. package-script[\s\S]*## 2\. file[\s\S]*## 3\. search/);
      expect(output).toContain('a.txt:2:beta');
      expect(output).toContain('b.txt:1:beta');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('bounds noisy sections and the aggregate result', () => {
    const root = fixture();
    try {
      writeFileSync(join(root, 'noisy.txt'), `${'x'.repeat(80)}\n`.repeat(100));
      const output = inspect(
        parseManifest({
          requests: Array.from({ length: 12 }, () => ({
            kind: 'file' as const,
            path: 'noisy.txt',
            lineCount: 1000,
          })),
        }),
        root,
      );
      expect(output).toContain('[agent-output truncated]');
      expect(output.length).toBeLessThanOrEqual(7_200);
      expect(output.split('\n').length).toBeLessThanOrEqual(180);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('makes no matches and individual request errors explicit', () => {
    const root = fixture();
    try {
      const output = inspect(
        parseManifest({
          requests: [
            { kind: 'search', pattern: 'missing' },
            { kind: 'file', path: 'missing.txt' },
          ],
        }),
        root,
      );
      expect(output).toContain('[no literal matches for "missing"]');
      expect(output).toContain('[request error:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('falls back deterministically when ripgrep is unavailable', () => {
    const root = fixture();
    const originalPath = process.env.PATH;
    try {
      process.env.PATH = '';
      const output = inspect(
        parseManifest({ requests: [{ kind: 'search', pattern: 'beta' }] }),
        root,
      );
      expect(output).toContain('a.txt:2:beta');
      expect(output).toContain('b.txt:1:beta');
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects unsafe paths before inspection', () => {
    expect(() => parseManifest({ requests: [{ kind: 'file', path: '../secret' }] })).not.toThrow();
    const root = fixture();
    try {
      expect(
        inspect(parseManifest({ requests: [{ kind: 'file', path: '../secret' }] }), root),
      ).toContain('path escapes repository root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
