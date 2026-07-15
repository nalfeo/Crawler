import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for a real review finding on docs/guides/merge-train.md:
 * the "Rollback" section originally instructed operators to remove
 * `merge-train` from `main`'s required status checks BEFORE disabling
 * `MERGE_TRAIN_ENABLED`. That ordering fails open: between the two steps the
 * train is still enabled but no longer gated by branch protection, so a PR
 * could merge before anything actually validated it.
 *
 * The "Emergency repair lane" section already had the safe order (disable
 * the flag first, which fails closed because nothing then publishes the
 * still-required `merge-train` check; only then roll back protection).
 *
 * The mechanism changed with the ruleset-based App-bypass fix (ADR 0062,
 * .github/scripts/merge-train/protection.mjs): rollback no longer deletes a
 * classic required-status-check context -- it restores classic
 * `required_status_checks` to the legacy ci-only shape and disables the
 * "Merge Train Required Checks" ruleset via `protection.mjs rollback`. This
 * test parses the real doc text (no reimplementation) and asserts both
 * sections still disable the flag strictly before rolling back protection, so
 * a future edit that reintroduces the unsafe ordering in either section is
 * caught.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DOC_PATH = path.join(REPO_ROOT, 'docs/guides/merge-train.md');

function loadDoc(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

function sectionText(doc: string, heading: string): string {
  const start = doc.indexOf(heading);
  if (start === -1) throw new Error(`heading "${heading}" not found`);
  const next = doc.indexOf('\n## ', start + heading.length);
  return doc.slice(start, next === -1 ? undefined : next);
}

const DISABLE_MARKER = 'gh variable set MERGE_TRAIN_ENABLED --repo nalfeo/Crawler --body false';
const ROLLBACK_MARKER = 'node .github/scripts/merge-train/protection.mjs rollback';

describe('merge-train.md rollback ordering is fail-closed (disable flag before rolling back protection)', () => {
  it('orders the Rollout/Rollback section as: disable the flag, then roll back protection', () => {
    const doc = loadDoc();
    const rollback = sectionText(doc, '## Rollout');
    const disableAt = rollback.indexOf(DISABLE_MARKER);
    const rollbackAt = rollback.indexOf(ROLLBACK_MARKER);
    expect(disableAt, 'disable-flag command should be present in Rollout/Rollback').toBeGreaterThan(
      -1,
    );
    expect(
      rollbackAt,
      'protection.mjs rollback command should be present in Rollout/Rollback',
    ).toBeGreaterThan(-1);
    expect(disableAt).toBeLessThan(rollbackAt);
  });

  it('orders the Emergency repair lane section as: disable the flag, then roll back protection', () => {
    const doc = loadDoc();
    const emergency = sectionText(doc, '## Emergency repair lane');
    const disableAt = emergency.indexOf(DISABLE_MARKER);
    const rollbackAt = emergency.indexOf(ROLLBACK_MARKER);
    expect(
      disableAt,
      'disable-flag command should be present in Emergency repair lane',
    ).toBeGreaterThan(-1);
    expect(
      rollbackAt,
      'protection.mjs rollback command should be present in Emergency repair lane',
    ).toBeGreaterThan(-1);
    expect(disableAt).toBeLessThan(rollbackAt);
  });

  it('documents the fail-closed rationale for disabling the flag before rolling back protection', () => {
    const doc = loadDoc();
    const rollback = sectionText(doc, '## Rollout');
    expect(rollback).toMatch(/fails closed/i);
    expect(rollback).toMatch(/Do not\s+reverse this\s+order/i);
  });
});
