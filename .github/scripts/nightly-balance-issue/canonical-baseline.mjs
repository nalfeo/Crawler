import { encodeRefPath, request } from '../ci-recovery/github.mjs';
import { FINAL_AGGREGATE_ARTIFACTS } from './nightly-balance-issue.mjs';

export const CANONICAL_SWEEP_WORKFLOW = 'weapon-sweep.yml';

// The exact dispatch inputs the nightly balance contract calls "canonical":
// 100 seeds per weapon, all six Floor-1 weapons, weapon personas on, and the
// hill-climb frame budget. Anything else produces telemetry the issue's
// baseline gate must reject.
export const CANONICAL_SWEEP_INPUTS = Object.freeze({
  seed_count: '100',
  weapons: 'sword,bow,baseball-bat,pistol,throwing-knife,fireball',
  weapon_personas: 'true',
  max_frames: '19800',
});

// `weapon-sweep.yml` stamps these same fields into its `run-name`, so a run's
// display title is deterministic proof of the sample size, weapon list, and
// flags it used. Without it, eligibility can only be judged by downloading
// every artifact — and a 30-seed or 3-weapon dispatch looks identical to a
// canonical one in the runs list.
export function buildCanonicalRunName(inputs = CANONICAL_SWEEP_INPUTS) {
  return `Weapon Sweep · seeds=${inputs.seed_count} · weapons=${inputs.weapons} · personas=${inputs.weapon_personas} · frames=${inputs.max_frames}`;
}

export function isCanonicalSweepRun(run, inputs = CANONICAL_SWEEP_INPUTS) {
  return String(run?.display_title || '').trim() === buildCanonicalRunName(inputs);
}

async function resolveDefaultBranch({ requestFn, token, owner, repo }) {
  const response = await requestFn(token, `/repos/${owner}/${repo}`);
  const branch = response?.data?.default_branch;
  if (!branch) {
    throw new Error(`Could not resolve the default branch for ${owner}/${repo}`);
  }
  return branch;
}

async function resolveHeadSha({ requestFn, token, owner, repo, branch }) {
  const response = await requestFn(
    token,
    `/repos/${owner}/${repo}/commits/${encodeRefPath(branch)}`,
  );
  const sha = response?.data?.sha;
  if (!sha) {
    throw new Error(`Could not resolve the head SHA of ${owner}/${repo}@${branch}`);
  }
  return sha;
}

async function hasEveryFinalAggregate({ requestFn, token, owner, repo, runId }) {
  const response = await requestFn(
    token,
    `/repos/${owner}/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
  );
  const artifacts = response?.data?.artifacts ?? [];
  const available = new Set(
    artifacts.filter((artifact) => !artifact?.expired).map((artifact) => artifact?.name),
  );
  return FINAL_AGGREGATE_ARTIFACTS.every((name) => available.has(name));
}

/**
 * Guarantee the nightly balance session has an eligible baseline to reason
 * about: a successful canonical `weapon-sweep.yml` run at the exact current
 * default-branch head SHA, with all six FINAL aggregate artifacts still
 * downloadable.
 *
 * Copilot sessions cannot dispatch workflows themselves, so if this filer does
 * not start the sweep, every nightly run inherits whatever ad-hoc sweep a human
 * last ran (historically 30 seeds, or a 3-weapon subset, at a week-old SHA) and
 * terminates on the baseline gate without ever examining telemetry.
 */
export async function ensureCanonicalBaselineSweep({
  token,
  owner,
  repo,
  branch,
  requestFn = request,
  inputs = CANONICAL_SWEEP_INPUTS,
}) {
  const targetBranch = branch || (await resolveDefaultBranch({ requestFn, token, owner, repo }));
  const headSha = await resolveHeadSha({ requestFn, token, owner, repo, branch: targetBranch });

  const runsResponse = await requestFn(
    token,
    `/repos/${owner}/${repo}/actions/workflows/${CANONICAL_SWEEP_WORKFLOW}/runs?branch=${encodeURIComponent(targetBranch)}&per_page=100`,
  );
  const runsAtHead = (runsResponse?.data?.workflow_runs ?? []).filter(
    (run) => run?.head_sha === headSha && isCanonicalSweepRun(run, inputs),
  );

  const pending = runsAtHead.find((run) => run?.status !== 'completed');
  if (pending) {
    return { status: 'pending', branch: targetBranch, headSha, runId: pending.id };
  }

  for (const run of runsAtHead.filter((candidate) => candidate?.conclusion === 'success')) {
    if (await hasEveryFinalAggregate({ requestFn, token, owner, repo, runId: run.id })) {
      return { status: 'fresh', branch: targetBranch, headSha, runId: run.id };
    }
  }

  await requestFn(
    token,
    `/repos/${owner}/${repo}/actions/workflows/${CANONICAL_SWEEP_WORKFLOW}/dispatches`,
    { method: 'POST', body: { ref: targetBranch, inputs: { ...inputs } } },
  );
  return { status: 'dispatched', branch: targetBranch, headSha, runId: null };
}

/**
 * Wrapper used by the nightly filer: parses `owner/repo`, and never lets a
 * baseline-sweep problem stop the issue from being filed. A missing baseline is
 * a documented terminal outcome for the session; a missing issue is a silent
 * skipped night.
 */
export async function ensureCanonicalBaselineSweepSafely({
  token,
  repository,
  branch,
  requestFn = request,
}) {
  const parts = String(repository || '').split('/');
  if (parts.length !== 2 || parts.some((part) => !part)) {
    return { status: 'skipped', reason: 'GITHUB_REPOSITORY must be in owner/repo form' };
  }
  if (!token) {
    return { status: 'skipped', reason: 'Missing CRAWLER_CI_PAT; cannot dispatch a sweep' };
  }
  try {
    return await ensureCanonicalBaselineSweep({
      token,
      owner: parts[0],
      repo: parts[1],
      branch,
      requestFn,
    });
  } catch (error) {
    return { status: 'failed', reason: error?.message ?? String(error) };
  }
}
