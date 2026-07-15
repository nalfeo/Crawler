import { request } from '../ci-recovery/github.mjs';
import { parseMergeTrainPrNumber } from './state.mjs';

// Resolve the origin PR for a landed commit and print its number to stdout.
//
// Exit codes let callers distinguish a genuine no-match from an outage:
//   - exit 0 + a number  => resolved.
//   - exit 0 + empty      => resolved cleanly to NO associated PR (e.g. a direct
//                            push to main, or a PR-less commit).
//   - exit 3 + empty      => resolution could not be completed because a GitHub
//                            API request FAILED (outage/permissions). Callers
//                            (deploy.yml / manual-preview.yml) treat this as a
//                            warning, not a "no PR" notice.
//
// Resolution order (durable mapping first, GitHub inference only as fallback):
//   1. The `Merge-Train-PR: <n>` trailer written into the squash commit by the
//      merge train, corroborated against GitHub's own merge record.
//   2. GitHub's commit-to-PR association, preferring the PR whose merge commit
//      is exactly this SHA.
const [sha] = process.argv.slice(2);
const repository = process.env.GITHUB_REPOSITORY || '';
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const [owner, repo] = repository.split('/');

const EXIT_API_FAILURE = 3;

async function resolve() {
  if (!sha || !owner || !repo || !token) {
    // Missing inputs is a configuration error, not a clean no-match.
    return { number: '', apiFailed: true };
  }

  let apiFailed = false;

  // 1. Durable trailer, corroborated against GitHub's merge record.
  try {
    const commit = (
      await request(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}`)
    ).data;
    const fromTrailer = parseMergeTrainPrNumber(commit?.commit?.message || '');
    if (fromTrailer) {
      const pr = (await request(token, `/repos/${owner}/${repo}/pulls/${fromTrailer}`)).data;
      if (pr?.merged === true && pr.merge_commit_sha === sha) {
        return { number: String(fromTrailer), apiFailed: false };
      }
    }
  } catch {
    // Record the failure and fall back to inference; only report an outage if
    // inference also cannot complete.
    apiFailed = true;
  }

  // 2. GitHub commit-to-PR inference.
  try {
    const pulls = (
      await request(token, `/repos/${owner}/${repo}/commits/${encodeURIComponent(sha)}/pulls`, {
        headers: { Accept: 'application/vnd.github+json' },
      })
    ).data;
    if (Array.isArray(pulls) && pulls.length > 0) {
      const exact = pulls.find((pr) => pr.merge_commit_sha === sha);
      return { number: String((exact || pulls[0]).number), apiFailed: false };
    }
    // The inference request succeeded and found no PR: a genuine clean no-match.
    return { number: '', apiFailed: false };
  } catch {
    apiFailed = true;
  }

  return { number: '', apiFailed };
}

resolve()
  .then(({ number, apiFailed }) => {
    if (number) {
      process.stdout.write(number);
      return;
    }
    if (apiFailed) process.exitCode = EXIT_API_FAILURE;
  })
  .catch(() => {
    process.exitCode = EXIT_API_FAILURE;
  });
