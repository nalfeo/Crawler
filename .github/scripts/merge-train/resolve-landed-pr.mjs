import { request } from '../ci-recovery/github.mjs';
import { parseMergeTrainPrNumber } from './state.mjs';

// Resolve the origin PR for a landed commit and print its number to stdout
// (empty when none resolves). Best-effort by design: every failure path prints
// nothing and exits 0 so callers degrade gracefully.
//
// Resolution order (durable mapping first, GitHub inference only as fallback,
// per the merge-train completion-semantics design):
//   1. The `Merge-Train-PR: <n>` trailer written into the squash commit by the
//      merge train. This is the reliable mapping that does not depend on
//      GitHub's commit-to-PR inference.
//   2. GitHub's own commit-to-PR association, preferring the PR whose merge
//      commit is exactly this SHA.
const [sha] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY || '';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const [owner, repo] = repository.split('/');

async function resolve() {
  if (!sha || !owner || !repo || !token) return '';

  try {
    const commit = (
      await request(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`)
    ).data;
    const fromTrailer = parseMergeTrainPrNumber(commit?.commit?.message || '');
    if (fromTrailer) return String(fromTrailer);
  } catch {
    // fall through to GitHub inference
  }

  try {
    const pulls = (
      await request(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/pulls`, {
        headers: { Accept: 'application/vnd.github+json' },
      })
    ).data;
    if (Array.isArray(pulls) && pulls.length > 0) {
      const exact = pulls.find((pr) => pr.merge_commit_sha === sha);
      return String((exact || pulls[0]).number);
    }
  } catch {
    // fall through
  }

  return '';
}

resolve()
  .then((number) => {
    if (number) process.stdout.write(number);
  })
  .catch(() => {});
