import { request } from '../ci-recovery/github.mjs';
import {
  hasLeadingMarker,
  LANDED_LABEL,
  LANDED_MARKER,
  parseMergeTrainPrNumber,
} from './state.mjs';

// Backfill the durable landed signal onto historical PRs that the merge train
// promoted via the RETIRED atomic force-push. That mechanism bypassed GitHub's
// merge machinery, so those PRs are permanently GitHub `state: closed`,
// `merged: false`, `merged_at: null` even though their commit reached `main`.
//
// This adds the `merge-train-landed` label + a TRUTHFUL comment so the PR is
// discoverable as train-landed. It does NOT and CANNOT change GitHub's
// merged-state, and it never claims GitHub recorded the PR merged. It then
// VERIFIES the historical state is still closed/unmerged (never falsified).
// Idempotent: re-running does not duplicate the label or comment.
//
// Usage:
//   node backfill-historical-landed.mjs <pr>=<landed-sha> [<pr>=<landed-sha> ...]
// Example:
//   node backfill-historical-landed.mjs 1149=c8c57f8b

const repository = process.env.GITHUB_REPOSITORY || 'nalfeo/Crawler';
const token =
  process.env.MERGE_TRAIN_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const [owner, repo] = repository.split('/');

if (!token || !owner || !repo) {
  process.stderr.write(
    'backfill-historical-landed: require a write token (MERGE_TRAIN_TOKEN/GITHUB_TOKEN) and GITHUB_REPOSITORY\n',
  );
  process.exit(1);
}

const targets = process.argv.slice(2).map((arg) => {
  const [number, sha] = arg.split('=');
  return { number: Number(number), sha: (sha || '').trim() };
});
if (targets.length === 0 || targets.some((t) => !Number.isInteger(t.number))) {
  process.stderr.write('backfill-historical-landed: pass one or more <pr>=<landed-sha> args\n');
  process.exit(1);
}

function historicalComment(sha) {
  return [
    LANDED_MARKER,
    '## Landed on `main` via the merge train (historical) ✅',
    '',
    `- Landed commit: \`${sha || 'unknown'}\``,
    "- This PR's change reached `main` through the merge train's earlier atomic",
    "  force-push promotion, which bypassed GitHub's own merge machinery.",
    '',
    "⚠️ **GitHub's own record of this PR intentionally remains `state: closed`,",
    '`merged: false`, `merged_at: null`.** That historical state is accurate for',
    'the force-push era and is deliberately **not** altered here — this backfill',
    'never claims GitHub marked the PR merged, and cannot retroactively create a',
    'merge event. Future train-landed PRs record real `merged: true` with a real',
    'merge commit (see ADR 0063). This label and comment are a durable, truthful',
    'record so the PR is discoverable as train-landed.',
  ].join('\n');
}

async function hasLandedComment(number) {
  let page = 1;
  for (;;) {
    const comments = (
      await request(
        token,
        `/repos/${owner}/${repo}/issues/${number}/comments?per_page=100&page=${page}`,
      )
    ).data;
    if (comments.some((comment) => hasLeadingMarker(comment.body, LANDED_MARKER))) return true;
    if (!Array.isArray(comments) || comments.length < 100) return false;
    page += 1;
  }
}

async function backfill({ number, sha }) {
  const pr = (await request(token, `/repos/${owner}/${repo}/pulls/${number}`)).data;

  // SAFETY PRECONDITION FIRST: only a genuinely historical force-push-era PR
  // (closed + never GitHub-merged) may receive this backfill. Verify BEFORE any
  // mutation so a mistaken target (an open PR, or a truly-merged PR) never gets
  // a false historical record written to it.
  const isHistorical = pr.state === 'closed' && pr.merged === false;
  if (!isHistorical) {
    throw new Error(
      `#${number} is not a closed/unmerged historical PR (state=${pr.state}, merged=${pr.merged}); refusing to write a historical landed record to it`,
    );
  }

  // Provenance: the supplied landed commit must actually exist AND carry this
  // PR's Merge-Train-PR trailer (every force-push-era train commit does). This
  // rejects an arbitrary, empty, mistyped, or non-train SHA before mutating.
  if (!/^[0-9a-f]{7,40}$/i.test(String(sha || ''))) {
    throw new Error(
      `#${number}: supplied landed sha ${sha || '<empty>'} is not a valid commit hash`,
    );
  }
  let landedCommit;
  try {
    landedCommit = (
      await request(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`)
    ).data;
  } catch (error) {
    throw new Error(
      `#${number}: landed commit ${sha} is not readable (${error?.status ?? 'network'}); refusing to backfill`,
    );
  }
  if (parseMergeTrainPrNumber(landedCommit?.commit?.message || '') !== number) {
    throw new Error(
      `#${number}: commit ${sha} does not carry a matching Merge-Train-PR trailer; refusing to attribute it to this PR`,
    );
  }
  const resolvedSha = landedCommit.sha || sha;

  // A readable, trailer-bearing commit is NOT proof it reached `main` -- the
  // immutable candidate refs also contain these trailers. Verify the commit is
  // actually an ancestor of current `main` via the compare API before claiming
  // it landed. compare base...head = `${resolvedSha}...main`: status `ahead`
  // (main has commits after it) or `identical` (it IS main's tip) both mean the
  // commit is reachable from main; `behind`/`diverged` means it is not.
  let comparison;
  try {
    comparison = (
      await request(
        token,
        `/repos/${owner}/${repo}/compare/${encodeURIComponent(resolvedSha)}...main`,
      )
    ).data;
  } catch (error) {
    throw new Error(
      `#${number}: could not verify ${resolvedSha} is on main (${error?.status ?? 'network'}); refusing to backfill`,
    );
  }
  if (comparison?.status !== 'ahead' && comparison?.status !== 'identical') {
    throw new Error(
      `#${number}: commit ${resolvedSha} is not an ancestor of main (compare status: ${comparison?.status}); refusing to claim it landed`,
    );
  }
  // Ensure the durable label (idempotent: POST is a no-op if already present).
  if (!(pr.labels || []).some((label) => label.name === LANDED_LABEL)) {
    await request(token, `/repos/${owner}/${repo}/issues/${number}/labels`, {
      method: 'POST',
      body: { labels: [LANDED_LABEL] },
    });
  }

  // Post the truthful comment once.
  if (!(await hasLandedComment(number))) {
    await request(token, `/repos/${owner}/${repo}/issues/${number}/comments`, {
      method: 'POST',
      body: { body: historicalComment(resolvedSha) },
    });
  }

  // Re-verify the historical GitHub state is still unchanged (never falsified).
  const after = (await request(token, `/repos/${owner}/${repo}/pulls/${number}`)).data;
  const preserved = after.state === 'closed' && after.merged === false;
  process.stdout.write(
    `#${number}: labeled+commented landed=${resolvedSha}; historical state state=${after.state} merged=${after.merged} merged_at=${after.merged_at} (${
      preserved ? 'preserved, not falsified' : 'UNEXPECTED — state changed!'
    })\n`,
  );
  if (!preserved) {
    throw new Error(
      `#${number} historical state is not the expected closed/unmerged; refusing to misreport it as landed-merged`,
    );
  }
}

for (const target of targets) {
  await backfill(target);
}
process.stdout.write('backfill complete\n');
