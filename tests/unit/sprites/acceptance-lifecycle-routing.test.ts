/**
 * Deterministic gate: every sprite-approval entry point is CLASSIFIED, and the
 * classification decides whether it may retire disliked art.
 *
 * The disliked-asset lifecycle only holds if explicit human acceptance runs
 * inside `runAcceptedDislikedLifecycleTransaction` — approving in the open
 * leaves retained disliked variants behind with no closure validation and no
 * rollback. Two independent reviews found three bypasses at once (the sidecar
 * `/accept` route, `--sequence`, `--icon-batch`), which is the signature of a
 * rule that lives only in reviewers' heads. So it lives here instead: a new
 * approval caller fails this test until somebody classifies it.
 *
 * The two classes:
 *   - HUMAN_ACCEPTANCE — an operator explicitly accepting art for a concept.
 *     MUST route through the transaction.
 *   - BATCH_PRODUCER — CI or unattended batch pipelines. MUST NOT hold any
 *     deletion authority (no lifecycle transaction, no `unapproveVariant`).
 *     Their disliked cleanup is deferred to the repo-wide sweeper,
 *     `npm run sprites:disliked-lifecycle -- --apply`, which a human runs. This
 *     is a deliberate exemption, not an oversight: Constitutional §3 keeps CI
 *     out of the business of destroying checked-in assets.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const SPRITES_DIR = path.resolve('scripts', 'sprites');

/** Explicit human acceptance surfaces — must run the lifecycle transaction. */
const HUMAN_ACCEPTANCE = [
  'approve-cli.ts', // --variant, --sequence, --icon-batch
  path.join('sidecar', 'server.ts'), // POST .../approve and POST .../accept
];

/** Unattended producers — allowed to approve, never to delete. */
const BATCH_PRODUCER = [
  'asset-request-publisher.ts', // issue-driven asset pipeline
  'ci-harvest-approve.ts', // CI-only G2-B harvest
  'icon-batch-cli.ts', // CI entry point for icon generation
  'reprocess-welcome-room-cli.ts', // repair reprocess of already-accepted art
  'theme-equipment-runner.ts', // bulk theme-equipment pipeline
];

/** Modules that define or implement the lifecycle rather than consume it. */
const IMPLEMENTATION = ['approve.ts', 'disliked-lifecycle.ts', 'disliked-lifecycle-cli.ts'];

const APPROVAL_CALL = /\b(approveVariant|approveFrameSequence|approveIconBatch)\s*\(/;

/**
 * Drop block comments and whole-line `//` comments so a JSDoc sentence like
 * "a thin shell over `approveVariant()`" is not mistaken for a call site.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');
}

function listSourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listSourceFiles(child));
    else if (entry.isFile() && entry.name.endsWith('.ts')) files.push(child);
  }
  return files;
}

function read(relativePath: string): string {
  return stripComments(readFileSync(path.join(SPRITES_DIR, relativePath), 'utf8'));
}

describe('sprite acceptance entry points are classified', () => {
  it('routes every human acceptance surface through the lifecycle transaction', () => {
    for (const relativePath of HUMAN_ACCEPTANCE) {
      const source = read(relativePath);
      expect(source, `${relativePath} must import the lifecycle transaction`).toContain(
        'runAcceptedDislikedLifecycleTransaction',
      );
      // Every approval call must be inside the transaction's `approve` callback,
      // so count them: one transaction invocation per approval call site.
      const approvals = source.match(/\b(approveVariant|approveFrameSequence|approveIconBatch)\(/g);
      const transactions = source.match(/runAcceptedDislikedLifecycleTransaction\(/g);
      expect(approvals, `${relativePath} should still approve something`).not.toBeNull();
      expect(
        transactions?.length,
        `${relativePath} has ${approvals?.length} approval call(s) but ` +
          `${transactions?.length ?? 0} transaction(s) — an approval is bypassing cleanup`,
      ).toBe(approvals?.length);
    }
  });

  it('grants no deletion authority to unattended batch producers', () => {
    for (const relativePath of BATCH_PRODUCER) {
      const source = read(relativePath);
      expect(
        source,
        `${relativePath} is an unattended producer and must not run lifecycle deletions`,
      ).not.toContain('runAcceptedDislikedLifecycleTransaction');
      expect(source, `${relativePath} must not delete accepted art`).not.toMatch(
        /\bunapproveVariant\s*\(/,
      );
    }
  });

  it('fails closed on a NEW, unclassified approval caller', () => {
    const classified = new Set([...HUMAN_ACCEPTANCE, ...BATCH_PRODUCER, ...IMPLEMENTATION]);
    const unclassified = listSourceFiles(SPRITES_DIR)
      .filter((file) => APPROVAL_CALL.test(stripComments(readFileSync(file, 'utf8'))))
      .map((file) => path.relative(SPRITES_DIR, file))
      .filter((relativePath) => !classified.has(relativePath))
      .sort();

    expect(
      unclassified,
      'New sprite-approval entry point(s) found. Classify each one in ' +
        'tests/unit/sprites/acceptance-lifecycle-routing.test.ts: HUMAN_ACCEPTANCE ' +
        '(route it through runAcceptedDislikedLifecycleTransaction) or BATCH_PRODUCER ' +
        '(no deletion authority; the repo-wide sprites:disliked-lifecycle sweeper cleans up).',
    ).toEqual([]);
  });
});
