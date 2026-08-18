/**
 * Tests for the queue-commit CLI shim argument parser (`parseArgs`).
 *
 * The CLI is invoked by the canvas sprite-editor `.mjs` extension as a `tsx`
 * subprocess. `parseArgs` is the pure, deterministic boundary — it maps
 * `--asset`/`--manifest-key` pairs into `CheckinAsset[]` and enforces the
 * invariant that every `--asset` carries a paired `--manifest-key` so the
 * authoritative manifest/catalog entry is queued alongside the PNG (concern #3).
 * These tests exercise that parser directly, with no git or subprocess.
 */

import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../../scripts/sprites/queue-commit-cli.js';

const BASE = ['--repo-root', '/repo', '--message', 'chore(assets): queue foo'] as const;

describe('queue-commit-cli parseArgs', () => {
  it('parses a properly paired --asset/--manifest-key set', () => {
    const parsed = parseArgs([
      ...BASE,
      '--asset',
      'generated/foo-var-1.png',
      '--manifest-key',
      'foo-var-1',
      '--asset',
      'generated/bar-var-2.png',
      '--manifest-key',
      'bar-var-2',
    ]);
    expect(parsed.repoRoot).toBe('/repo');
    expect(parsed.message).toBe('chore(assets): queue foo');
    expect(parsed.assets).toEqual([
      {
        assetPath: 'generated/foo-var-1.png',
        manifestKey: 'foo-var-1',
        briefId: null,
        variantIndex: null,
      },
      {
        assetPath: 'generated/bar-var-2.png',
        manifestKey: 'bar-var-2',
        briefId: null,
        variantIndex: null,
      },
    ]);
  });

  it('parses an annotation-only Sprite Editor save with all curation semantics', () => {
    const annotation = {
      key: 'foo-var-1',
      favorite: false,
      disliked: true,
      comment: 'Needs a stronger silhouette.',
    };
    const parsed = parseArgs([
      ...BASE,
      '--annotation-json',
      Buffer.from(JSON.stringify(annotation)).toString('base64url'),
    ]);
    expect(parsed.assets).toEqual([]);
    expect(parsed.annotations).toEqual([annotation]);
  });

  it('rejects an --asset that is missing its paired --manifest-key (concern #3)', () => {
    // Without this guard, copyArtSurface queues an orphan PNG with no manifest/
    // catalog entry — a silent authority split that the reviewer flagged.
    expect(() => parseArgs([...BASE, '--asset', 'generated/foo-var-1.png'])).toThrow(
      /missing its paired --manifest-key/,
    );
  });

  it('rejects an orphan --asset even when a later asset IS paired', () => {
    expect(() =>
      parseArgs([
        ...BASE,
        '--asset',
        'generated/orphan-var-0.png',
        '--asset',
        'generated/paired-var-1.png',
        '--manifest-key',
        'paired-var-1',
      ]),
    ).toThrow(/generated\/orphan-var-0\.png is missing its paired --manifest-key/);
  });

  it('rejects a --manifest-key that does not follow an --asset', () => {
    expect(() => parseArgs([...BASE, '--manifest-key', 'stray-key'])).toThrow(
      /--manifest-key must follow an --asset/,
    );
  });

  it('requires --repo-root, --message, and at least one --asset', () => {
    expect(() =>
      parseArgs(['--message', 'm', '--asset', 'generated/a.png', '--manifest-key', 'a']),
    ).toThrow(/Missing required --repo-root/);
    expect(() =>
      parseArgs(['--repo-root', '/repo', '--asset', 'generated/a.png', '--manifest-key', 'a']),
    ).toThrow(/Missing required --message/);
    expect(() => parseArgs([...BASE])).toThrow(
      /At least one --asset or --annotation-json is required/,
    );
  });

  it('throws on a value-less flag and on unknown arguments', () => {
    expect(() => parseArgs(['--repo-root'])).toThrow(/--repo-root requires a value/);
    expect(() => parseArgs([...BASE, '--bogus'])).toThrow(/Unknown argument: --bogus/);
  });
});
