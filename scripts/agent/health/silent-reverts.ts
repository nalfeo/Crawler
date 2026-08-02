#!/usr/bin/env node
/**
 * health/silent-reverts.ts — deterministic guard against merge commits that
 * SILENTLY discard incoming changes (issue #2282).
 *
 * See `silent-reverts-lib.ts` for the bug class, the detection rule, and why a
 * survival-to-head filter is mandatory. This file is only git plumbing plus
 * reporting.
 *
 * Deterministic script + exit code (AGENTS.md rule #2 — no LLM-as-judge):
 *   exit 0 → no surviving silent reverts on this branch.
 *   exit 1 → at least one (or a malformed allowlist entry).
 *   exit 2 → the guard itself could not run. It FAILS CLOSED rather than
 *            passing vacuously, because the most likely cause is a shallow
 *            clone, which would otherwise make the guard silently inspect
 *            nothing.
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { Report, repoRoot } from '../shared/report.js';
import {
  ACK_TRAILER,
  type FileTriple,
  type MergeInput,
  dedupeByPath,
  findSilentReverts,
  findUnusedAcks,
  parseAckTrailers,
} from './silent-reverts-lib.js';

const BASE_REF = process.env.SILENT_REVERT_BASE_REF ?? 'origin/main';
/** Overridable so the guard can be pointed at a specific branch under test. */
const HEAD_REF = process.env.SILENT_REVERT_HEAD_REF ?? 'HEAD';
/**
 * Overridable so integration tests can point the guard at a synthetic fixture
 * repo. `repoRoot()` resolves relative to this file, which is correct in CI but
 * makes the guard untestable against purpose-built merge histories.
 */
const REPO = process.env.SILENT_REVERT_REPO ?? repoRoot();

function git(args: string[], cwd: string = REPO): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 256,
  }).trim();
}

function gitOrNull(args: string[], cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/** `path -> blob sha` for an entire tree, cached per rev. */
const treeCache = new Map<string, Map<string, string>>();
function treeOf(rev: string, cwd: string): Map<string, string> {
  const cached = treeCache.get(rev);
  if (cached) return cached;
  const map = new Map<string, string>();
  // One process per rev rather than one per file: merges here touch 250+ files.
  const out = git(['ls-tree', '-r', '--format=%(objectname) %(path)', rev], cwd);
  for (const line of out.split('\n')) {
    if (!line) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    map.set(line.slice(sp + 1), line.slice(0, sp));
  }
  treeCache.set(rev, map);
  return map;
}

const mergeTreeCache = new Map<string, string | null>();
function mergeTree(base: string, other: string, side: string, cwd: string): string | null {
  const key = `${cwd}\u0000${base}\u0000${other}\u0000${side}`;
  if (mergeTreeCache.has(key)) return mergeTreeCache.get(key) ?? null;
  const merged = gitOrNull(['merge-tree', '--write-tree', '--merge-base', base, other, side], cwd);
  mergeTreeCache.set(key, merged);
  return merged;
}

function blob(rev: string, path: string, cwd: string): string | null {
  return treeOf(rev, cwd).get(path) ?? null;
}

export interface CollectResult {
  readonly merges: MergeInput[];
  /** Merges the guard cannot soundly model; these FAIL CLOSED, never skip. */
  readonly unsupported: Array<{ sha: string; reason: string }>;
}

export function collectMergeInputs(cwd: string, baseRef: string, headRef: string): CollectResult {
  const mergeShas = git(['rev-list', '--merges', `${baseRef}..${headRef}`], cwd)
    .split('\n')
    .filter(Boolean);

  const merges: MergeInput[] = [];
  const unsupported: Array<{ sha: string; reason: string }> = [];

  for (const sha of mergeShas) {
    const parents = git(['rev-list', '--parents', '-n', '1', sha], cwd).split(/\s+/).slice(1);
    if (parents.length < 2) continue;

    // An octopus merge has no single opposing parent, so the `result === other`
    // arm is not well defined. Report it rather than skipping: skipping would
    // be a silent hole in a guard whose whole purpose is catching silence.
    if (parents.length > 2) {
      unsupported.push({ sha, reason: `octopus merge with ${parents.length} parents` });
      continue;
    }

    const [a, b] = parents as [string, string];
    // Criss-cross history can yield several equally-good bases. Rather than
    // picking one arbitrarily (unsound) or refusing outright (unactionable for
    // a merge that already landed), evaluate against ALL of them and let
    // findSilentReverts require agreement across every candidate.
    const basesStr = gitOrNull(['merge-base', '--all', a, b], cwd);
    const bases = basesStr ? basesStr.split('\n').filter(Boolean) : [];
    if (bases.length === 0) {
      // Two-parent merge with no common ancestor (e.g. --allow-unrelated-histories).
      // `-s ours` on such a merge silently discards EVERY file from the other side.
      // Report rather than skip: skipping would be a silent hole in a guard whose
      // whole purpose is catching silence.
      unsupported.push({
        sha,
        reason: 'no merge base (unrelated histories, e.g. --allow-unrelated-histories)',
      });
      continue;
    }

    const subject = git(['log', '-1', '--format=%s', sha], cwd);
    const ackedPaths = parseAckTrailers(git(['log', '-1', '--format=%B', sha], cwd));

    // Evaluate BOTH parents: a merge can drop either side's work. Mainline
    // losses are graded harder because they affect everyone.
    for (const [side, other] of [
      [a, b],
      [b, a],
    ] as ReadonlyArray<readonly [string, string]>) {
      // Mainline-ness must not depend on which branch DELIVERED main's work.
      // Two shapes both put mainline content at stake:
      //   (a) side is already merged to main  -> side is on the mainline;
      //   (b) main is reachable FROM side     -> side contains all of main,
      //       so discarding it wholesale drops mainline content.
      // Shape (b) is the third-branch case: a PR merges a colleague branch
      // that had itself merged main. Verified by repro — without (b) a genuine
      // silent revert of a main-only fix graded `warn` and CI exited 0.
      // Over-grading a branch-local loss inside a main-containing parent is
      // deliberate: the finding is still real, and errors are ackable.
      const sideIsMainline =
        gitOrNull(['merge-base', '--is-ancestor', side, baseRef], cwd) !== null ||
        gitOrNull(['merge-base', '--is-ancestor', baseRef, side], cwd) !== null;

      // Path-level provenance: for non-mainline sides, find where side last
      // merged from mainline. If that merge-base had `mainBlob` at a path, side
      // incorporated it and the provenance check in gradeSeverity can upgrade a
      // discard to error even when `side !== mainBlob` (side edited further on
      // top). Not needed when sideIsMainline — ancestry grading already fires.
      const sideMainBaseRev = !sideIsMainline
        ? (gitOrNull(['merge-base', '--all', side, baseRef], cwd) ?? '')
            .split('\n')
            .filter(Boolean)[0]
        : undefined;

      for (const base of bases) {
        // --no-renames keeps this a pure path-keyed comparison; a rename shows
        // up as delete+add, which the null-blob handling already models.
        const changed = git(['diff', '--name-only', '--no-renames', base, side], cwd)
          .split('\n')
          .filter(Boolean);
        if (changed.length === 0) continue;

        const mergedTreeRev = mergeTree(base, other, side, cwd);

        const files: FileTriple[] = changed.map((path) => {
          const baseBlob = blob(base, path, cwd);
          const sideBlob = blob(side, path, cwd);
          const otherBlob = blob(other, path, cwd);
          const resultBlob = blob(sha, path, cwd);
          return {
            path,
            base: baseBlob,
            side: sideBlob,
            other: otherBlob,
            result: resultBlob,
            head: blob(headRef, path, cwd),
            sideAlreadyPresentInOther:
              mergedTreeRev !== null &&
              resultBlob === otherBlob &&
              blob(mergedTreeRev, path, cwd) === otherBlob,
            // Content-based mainline grading: does main STILL hold what this
            // discard threw away? Catches the older-main-tip shape that no
            // ancestry test can see (see gradeSeverity).
            mainBlob: blob(baseRef, path, cwd),
            // Provenance: blob at side's merge-base with mainline. Used by
            // gradeSeverity to detect when side built on top of mainBlob.
            sideMainBase:
              sideMainBaseRev !== undefined ? blob(sideMainBaseRev, path, cwd) : undefined,
          };
        });

        merges.push({
          sha,
          subject,
          sideRef: side.slice(0, 9),
          sideIsMainline,
          ackedPaths,
          files,
          baseCount: bases.length,
        });
      }
    }
  }
  return { merges, unsupported };
}

function main(): void {
  const report = new Report('health-silent-reverts');
  const cwd = REPO;

  // Fail CLOSED on a shallow clone. `actions/checkout` defaults to depth 1, and
  // a shallow repo cannot resolve merge-bases — the guard would inspect zero
  // merges and pass, which is exactly the silent-success failure it exists to
  // prevent.
  if (gitOrNull(['rev-parse', '--is-shallow-repository'], cwd) === 'true') {
    report.error('Repository is a SHALLOW clone — merge history cannot be inspected.', {
      remediation:
        'Add `fetch-depth: 0` to the actions/checkout step for the job that runs ' +
        'check:silent-reverts. The guard fails closed rather than pass vacuously.',
    });
    report.finish();
  }

  if (gitOrNull(['rev-parse', '--verify', `${BASE_REF}^{commit}`], cwd) === null) {
    report.error(`Base ref "${BASE_REF}" could not be resolved.`, {
      remediation:
        `Fetch it (e.g. \`git fetch origin main\`) or set SILENT_REVERT_BASE_REF. ` +
        `The guard fails closed rather than pass vacuously.`,
    });
    report.finish();
  }

  const { merges, unsupported } = collectMergeInputs(cwd, BASE_REF, HEAD_REF);

  for (const u of unsupported) {
    const remediation = u.reason.startsWith('no merge base')
      ? 'Avoid merging branches with completely unrelated histories. If this merge is ' +
        'intentional, re-examine the result manually — the guard cannot inspect it.'
      : 'Re-do this merge as a sequence of ordinary two-parent merges (or rebase), ' +
        'so each resolution can be compared against a single opposing parent. ' +
        'The guard refuses to skip it, because skipping is the silent hole it exists to close.';
    report.error(`Merge ${u.sha.slice(0, 9)} cannot be soundly analysed: ${u.reason}.`, {
      remediation,
    });
  }

  const findings = dedupeByPath(findSilentReverts(merges));
  const unusedAcks = findUnusedAcks(merges);

  for (const u of unusedAcks) {
    report.error(`Merge ${u.mergeSha.slice(0, 9)} acks "${u.path}" but discarded no such file.`, {
      remediation:
        `Remove the stale \`${ACK_TRAILER}: ${u.path}\` trailer. A stale ack looks ` +
        `like coverage while leaving the path unguarded.`,
    });
  }

  for (const f of findings) {
    const also =
      f.mergeCount && f.mergeCount > 1 ? ` (and ${f.mergeCount - 1} other merge(s))` : '';
    const message =
      `Merge ${f.mergeSha.slice(0, 9)} ("${f.mergeSubject}") silently discarded ` +
      `changes to ${f.path} from ${f.sideRef}${also}, and the discard is still present at HEAD.`;
    // When multiple merges discarded the same path, list every SHA so the user
    // knows which commit messages each need an acknowledgement trailer — not only
    // the most recent one (which is what `mergeSha` tracks after deduplication).
    const ackedShas = f.allMergeShas ?? [f.mergeSha];
    const mergeTargets = ackedShas.map((sha) => `merge commit ${sha.slice(0, 9)}`).join(' and ');
    const remediation =
      `Re-apply that side's version of ${f.path} on top of your work, then verify ` +
      `\`git diff ${BASE_REF} -- ${f.path}\` shows only your intended change. ` +
      `If the discard IS intentional, add a \`${ACK_TRAILER}: ${f.path}\` trailer to ` +
      `the ${mergeTargets} explaining why.`;
    if (f.severity === 'error') report.error(message, { file: f.path, remediation });
    else report.warn(`${message} (branch-local work, not mainline)`, { file: f.path, remediation });
  }

  const mergeCount = new Set(merges.map((m) => m.sha)).size;
  const blocking =
    findings.filter((f) => f.severity === 'error').length + unusedAcks.length + unsupported.length;
  if (blocking === 0) {
    report.info(
      `${mergeCount} merge commit(s) inspected against ${BASE_REF}; no surviving silent reverts.`,
    );
  }

  report.finish();
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `silent-reverts crashed: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(2);
}
