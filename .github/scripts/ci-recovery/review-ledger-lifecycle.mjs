import {
  findReviewLedgerPaths,
  formatLedgerResult,
  validateLedgerText,
} from '../../../scripts/agent/review/ledger.mjs';

function addedLedgerPaths(changedFiles) {
  return findReviewLedgerPaths(
    (changedFiles || [])
      .filter((file) => String(file?.status || '').toLowerCase() === 'added')
      .map((file) => String(file?.filename || '')),
  );
}

export async function reviewLedgerBlockers(changedFiles, fetchLedgerText) {
  const blockers = [];
  const warnings = [];
  for (const path of addedLedgerPaths(changedFiles)) {
    let text;
    try {
      text = await fetchLedgerText(path);
    } catch (error) {
      warnings.push(
        `review-ledger fetch skipped path=${path} reason=${String(error?.message || error || 'unknown')}`,
      );
      continue;
    }
    const result = validateLedgerText(text, { requireCurrentSchema: true });
    if (result.ok) continue;
    blockers.push({
      kind: 'review-ledger',
      id: `review-ledger:${path}`,
      path,
      summary: [
        'The added review ledger is invalid or incomplete on the current PR head.',
        formatLedgerResult(result, path),
        `Repair it after all code, CI, and review-thread fixes, then run \`npm run review:ledger -- validate ${path}\` on the final head.`,
      ].join('\n'),
    });
  }
  return { blockers, warnings };
}

export { addedLedgerPaths };
