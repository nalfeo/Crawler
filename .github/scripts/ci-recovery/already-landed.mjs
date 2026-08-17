/**
 * already-landed.mjs — Deterministic "content already on main" detection.
 *
 * Pure module: no side effects, no async, no GitHub API calls.  The caller is
 * responsible for fetching and supplying all required facts.
 *
 * Algorithm
 * ---------
 * For each file changed by a PR vs. its merge base:
 *   1. Fetch the file's blob SHA at PR HEAD via the PR files API.
 *   2. Fetch the file's blob SHA at main HEAD via the contents API (null = absent).
 *   3. Classify the file using classifyFile().
 *
 * Verdict rules (analyzeFiles):
 *   ALL_LANDED         — every file is LANDED or DELETION_LANDED → auto-close proof.
 *   PARTIAL            — some files landed, rest not confirmed (differ or absent).
 *                        Comments + label, leave open.
 *   NOT_LANDED         — no files landed → no action.
 *
 * DIFFERS files (blob SHA mismatch) are treated as "not confirmed landed" rather
 * than regression evidence; a two-way mismatch cannot establish regression direction.
 *
 * Design source: GitHub issue #2227.
 *
 * Golden fixtures (issue table):
 *   PR #2057 — 6 files, 0 absent → ALL_LANDED
 *   PR #1975 — 14 files, 0 absent, 2 differ → REGRESSION_CANDIDATE
 *   PR #2112 — 11 files, 0 absent → ALL_LANDED
 *   PR #2124 — 18 files, 4 absent → PARTIAL (14 landed, 4 new-on-pr)
 */

import { ALREADY_LANDED_COMMENT_MARKER } from './markers.mjs';

export { ALREADY_LANDED_COMMENT_MARKER };
export const MAX_COMMENT_FILE_ROWS = 20;

// ---------------------------------------------------------------------------
// File classification constants
// ---------------------------------------------------------------------------

/**
 * Possible outcomes for a single file in an already-landed analysis.
 *
 * LANDED           — content at PR HEAD equals content at main HEAD (same blob SHA).
 *                    Applies to added / modified / renamed / copied files.
 * NEW_ON_PR        — file exists at PR HEAD but not on main HEAD (404).
 *                    The PR introduces genuinely new content.
 * DIFFERS          — file exists on both PR HEAD and main HEAD, but with different
 *                    blob SHAs.  Merging the PR would change main — could be a
 *                    regression if main's version is newer.
 * DELETION_LANDED  — PR deletes this file and it no longer exists on main either.
 *                    The deletion has already happened by another route.
 * DELETION_DIFFERS — PR deletes this file but it still exists on main.
 *                    The deletion is NOT yet landed; merging would remove content.
 */
export const FILE_STATUS = Object.freeze({
  LANDED: 'landed',
  NEW_ON_PR: 'new-on-pr',
  DIFFERS: 'differs',
  DELETION_LANDED: 'deletion-landed',
  DELETION_DIFFERS: 'deletion-differs',
});

// ---------------------------------------------------------------------------
// PR-level verdict constants
// ---------------------------------------------------------------------------

/**
 * ALL_LANDED         — auto-close proof: every changed file is already on main.
 * PARTIAL            — some files landed, rest not confirmed (absent, differ, or
 *                      deletion pending); no files known to be fully absent.
 * NOT_LANDED         — no files are landed; PR has genuinely new or differing content.
 *
 * Note: REGRESSION_CANDIDATE is retained for API compatibility but is no longer
 * returned by analyzeFiles.  A two-way SHA mismatch alone cannot establish
 * regression direction (the PR might be ahead of main, not behind), so differing
 * files are treated as "not confirmed landed" rather than regression evidence.
 */
export const VERDICT = Object.freeze({
  ALL_LANDED: 'all-landed',
  /** @deprecated Not returned by analyzeFiles; retained for API compatibility. */
  REGRESSION_CANDIDATE: 'regression-candidate',
  PARTIAL: 'partial',
  NOT_LANDED: 'not-landed',
});

// ---------------------------------------------------------------------------
// Core classification logic
// ---------------------------------------------------------------------------

/**
 * Classify a single PR file given its PR status and the blob SHA at main HEAD.
 *
 * @param {object} prFile
 *   { filename: string, sha: string, status: string, previous_filename?: string }
 *   `sha` is the blob SHA at PR HEAD (from the pull files API).
 *   `status` is one of: 'added' | 'modified' | 'renamed' | 'removed' | 'copied'.
 * @param {string|null} mainBlobSha
 *   Blob SHA of this file at main HEAD, or null if the file is absent from main.
 *   For renamed files, this should be the blob SHA of the *new* filename on main.
 * @param {string|null|undefined} [mainPreviousFileBlobSha]
 *   For renamed files only: blob SHA of the *previous* filename at main HEAD.
 *   - undefined (default): not checked.
 *   - null: previous path is absent from main (deletion has landed).
 *   - string: previous path still exists on main (deletion has NOT yet landed).
 * @returns {{ filename: string, status: string, fileStatus: string }}
 */
export function classifyFile(prFile, mainBlobSha, mainPreviousFileBlobSha = undefined) {
  const filename = String(prFile?.filename ?? '');
  const prStatus = String(prFile?.status ?? '');
  const prBlobSha = String(prFile?.sha ?? '');

  if (prStatus === 'removed') {
    // PR deletes this file.
    if (mainBlobSha === null) {
      // File is also absent from main — deletion has already landed.
      return { filename, status: prStatus, fileStatus: FILE_STATUS.DELETION_LANDED };
    }
    // File still exists on main — deletion has NOT landed.
    return { filename, status: prStatus, fileStatus: FILE_STATUS.DELETION_DIFFERS };
  }

  // File is added, modified, renamed, or copied by the PR.
  if (mainBlobSha === null) {
    // File does not exist on main — genuinely new content.
    return { filename, status: prStatus, fileStatus: FILE_STATUS.NEW_ON_PR };
  }
  if (prBlobSha === mainBlobSha) {
    // Blob SHAs match — content is byte-identical on the new path.
    // For renamed files, also require that the old path is absent from main.
    if (
      prStatus === 'renamed' &&
      mainPreviousFileBlobSha !== undefined &&
      mainPreviousFileBlobSha !== null
    ) {
      // Old path still exists on main — the rename's deletion has NOT landed.
      return { filename, status: prStatus, fileStatus: FILE_STATUS.DELETION_DIFFERS };
    }
    return { filename, status: prStatus, fileStatus: FILE_STATUS.LANDED };
  }
  // File exists on both sides with different content.
  return { filename, status: prStatus, fileStatus: FILE_STATUS.DIFFERS };
}

// ---------------------------------------------------------------------------
// Verdict logic
// ---------------------------------------------------------------------------

/**
 * Compute the PR-level verdict from an array of classified files.
 *
 * Conservatism invariant: never returns ALL_LANDED if any file has NEW_ON_PR,
 * DIFFERS, or DELETION_DIFFERS status (i.e., when there is any real remaining
 * content not yet on main, or any content that cannot be confirmed as landed).
 *
 * DIFFERS files are treated as "content not confirmed on main" rather than
 * regression evidence — a two-way SHA mismatch cannot determine which side is
 * newer without a three-way merge-base comparison.  They contribute to
 * differsCount (informational) but do not trigger REGRESSION_CANDIDATE; instead
 * they prevent ALL_LANDED and yield PARTIAL or NOT_LANDED.
 *
 * @param {{ filename: string, status: string, fileStatus: string }[]} classifiedFiles
 * @returns {{
 *   verdict: string,
 *   totalCount: number,
 *   landedCount: number,
 *   differsCount: number,
 *   newCount: number,
 *   files: { filename: string, status: string, fileStatus: string }[]
 * }}
 */
export function analyzeFiles(classifiedFiles) {
  const files = Array.isArray(classifiedFiles) ? classifiedFiles : [];
  const totalCount = files.length;

  if (totalCount === 0) {
    return {
      verdict: VERDICT.NOT_LANDED,
      totalCount: 0,
      landedCount: 0,
      differsCount: 0,
      newCount: 0,
      files: [],
    };
  }

  let landedCount = 0;
  let differsCount = 0;
  let newCount = 0;

  for (const f of files) {
    const s = f.fileStatus;
    if (s === FILE_STATUS.LANDED || s === FILE_STATUS.DELETION_LANDED) {
      landedCount += 1;
    } else if (s === FILE_STATUS.DIFFERS) {
      differsCount += 1;
    } else {
      // NEW_ON_PR or DELETION_DIFFERS
      newCount += 1;
    }
  }

  let verdict;
  if (landedCount === totalCount) {
    // All files landed — deterministic proof that PR adds nothing.
    verdict = VERDICT.ALL_LANDED;
  } else if (landedCount > 0) {
    // Some files landed, rest have unconfirmed or unmerged content.
    // DIFFERS files count as "not confirmed landed" — don't treat as regression.
    verdict = VERDICT.PARTIAL;
  } else {
    // No files landed.
    verdict = VERDICT.NOT_LANDED;
  }

  return { verdict, totalCount, landedCount, differsCount, newCount, files };
}

// ---------------------------------------------------------------------------
// Comment rendering
// ---------------------------------------------------------------------------

/**
 * Row icon for a file status in the evidence table.
 */
function fileStatusIcon(fileStatus) {
  switch (fileStatus) {
    case FILE_STATUS.LANDED:
      return '✅';
    case FILE_STATUS.DELETION_LANDED:
      return '✅';
    case FILE_STATUS.NEW_ON_PR:
      return '🆕';
    case FILE_STATUS.DIFFERS:
      return '⚠️';
    case FILE_STATUS.DELETION_DIFFERS:
      return '🔄';
    default:
      return '❓';
  }
}

/**
 * Human-readable description of a file status.
 */
function fileStatusLabel(fileStatus) {
  switch (fileStatus) {
    case FILE_STATUS.LANDED:
      return 'already on main (byte-identical)';
    case FILE_STATUS.DELETION_LANDED:
      return 'deleted from main (deletion landed)';
    case FILE_STATUS.NEW_ON_PR:
      return 'not on main (genuinely new)';
    case FILE_STATUS.DIFFERS:
      return 'differs from main (content not confirmed landed)';
    case FILE_STATUS.DELETION_DIFFERS:
      return 'still on main (deletion not landed)';
    default:
      return 'unknown';
  }
}

/**
 * Render the already-landed detection comment body.
 *
 * @param {number} prNumber
 * @param {{
 *   verdict: string,
 *   totalCount: number,
 *   landedCount: number,
 *   differsCount: number,
 *   newCount: number,
 *   files: { filename: string, status: string, fileStatus: string }[]
 * }} analysis
 * @param {string} mainSha  — current main HEAD SHA (for evidence)
 * @returns {string}
 */
export function renderAlreadyLandedComment(prNumber, analysis, mainSha) {
  const { verdict, totalCount, landedCount, differsCount, newCount, files } = analysis;
  const sha = String(mainSha || 'main').slice(0, 12);

  const headings = {
    [VERDICT.ALL_LANDED]: `## ✅ PR #${prNumber} — all content already on \`main\``,
    [VERDICT.PARTIAL]: `## 🔍 PR #${prNumber} — content analysis: ${landedCount} of ${totalCount} files already on \`main\``,
    [VERDICT.NOT_LANDED]: `## 🆕 PR #${prNumber} — content analysis: no files landed yet`,
  };

  const differNote =
    differsCount > 0
      ? [
          `**${differsCount} file${differsCount === 1 ? '' : 's'}** have different content from \`main\` — cannot confirm these are landed (no merge-base comparison).`,
          '',
        ]
      : [];

  const summaries = {
    [VERDICT.ALL_LANDED]: [
      `All ${totalCount} file${totalCount === 1 ? '' : 's'} changed by this PR are already present on \`main\` (byte-identical content at \`${sha}\`).`,
      '',
      'This PR delivers zero net content. It was auto-closed by the already-landed detector.',
    ],
    [VERDICT.PARTIAL]: [
      `**${landedCount} of ${totalCount} file${totalCount === 1 ? '' : 's'}** are already on \`main\` (byte-identical at \`${sha}\`).`,
      ...differNote,
      `**${newCount} file${newCount === 1 ? '' : 's'}** contain genuinely new or unconfirmed content not yet on \`main\`.`,
      '',
      'This PR was NOT auto-closed — it still has unmerged content.',
    ],
    [VERDICT.NOT_LANDED]: ['No files from this PR are present on `main` yet.'],
  };

  const heading = headings[verdict] ?? `## PR #${prNumber} — already-landed analysis`;
  const summaryLines = summaries[verdict] ?? [];

  // Keep the proof readable and safely below GitHub's comment limit. Sort the
  // sample so identical analysis input always yields identical comment text.
  const sortedFiles = [...files].sort(
    (left, right) =>
      String(left.filename).localeCompare(String(right.filename)) ||
      String(left.status).localeCompare(String(right.status)),
  );
  const hiddenCount = Math.max(0, sortedFiles.length - MAX_COMMENT_FILE_ROWS);
  const tableRows = sortedFiles.slice(0, MAX_COMMENT_FILE_ROWS).map((f) => {
    const icon = fileStatusIcon(f.fileStatus);
    const label = fileStatusLabel(f.fileStatus);
    const name = f.filename.length > 80 ? `…${f.filename.slice(-77)}` : f.filename;
    return `| ${icon} | \`${name}\` | ${f.status} | ${label} |`;
  });
  if (hiddenCount > 0) {
    tableRows.push(`| | _…and ${hiddenCount} more_ | | |`);
  }

  return [
    ALREADY_LANDED_COMMENT_MARKER,
    heading,
    '',
    ...summaryLines,
    '',
    '| | File | PR change | Status |',
    '|---|---|---|---|',
    ...tableRows,
    '',
    `_Checked against \`main\` at \`${sha}\`. Analysis is deterministic — no heuristics used._`,
    '_If this is incorrect, re-open the PR and the label will be reconsidered on the next sweep._',
  ].join('\n');
}
