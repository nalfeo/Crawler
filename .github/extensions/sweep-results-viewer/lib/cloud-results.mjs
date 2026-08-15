import { normalizeFloors } from './result-data.mjs';

const AGGREGATE_ARTIFACT_PATTERN = /^weapon-sweep-(?!shard-)([a-z0-9][a-z0-9-]*)$/;
const SWEEP_JOB_PATTERN = /^(?:weapon-sweep|aggregate) \(([a-z0-9][a-z0-9-]*)/;

/** Artifact name for the AI Sweep Eval final leaderboard. */
export const LEADERBOARD_ARTIFACT_NAME = 'leaderboard';

/**
 * The post-release baseline-sweep job (`deploy.yml`'s `baseline-sweep`)
 * uploads its complete cohort + fun-eval report as `baseline-<short-sha>`
 * (see "Upload baseline as artifact" in `deploy.yml`).
 */
const BASELINE_ARTIFACT_PATTERN = /^baseline-[0-9a-f]{6,40}$/i;

/**
 * Maps AI Sweep Eval job name prefixes to their phase keys.
 *
 * The "search" phase key covers BOTH the legacy single `Search <combo>` job
 * (pre round-DAG runs) and the bounded round-DAG's `Baseline <combo>`,
 * `Checkpoint init <combo>`, and `Round N — plan candidates` / `Round N eval
 * <combo>` / `Round N select <combo>` jobs, so historical and current runs
 * both surface progress under the same "Search in progress" UI copy.
 */
const AI_SWEEP_PHASE_PATTERNS = /** @type {const} */ ([
  ['preflight', /^preflight\b/i],
  ['search', /^(?:search|baseline|checkpoint init|round\s*\d+)\b/i],
  ['validate', /^validate\b/i],
  ['aggregate', /^aggregate\b/i],
]);

function asString(value) {
  return typeof value === 'string' ? value : '';
}

function asRunId(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid workflow run id: ${value}`);
  }
  return parsed;
}

export function normalizeRun(raw) {
  return {
    id: asRunId(raw.id ?? raw.databaseId),
    status: asString(raw.status) || 'unknown',
    conclusion: raw.conclusion == null ? null : asString(raw.conclusion),
    headBranch: asString(raw.head_branch ?? raw.headBranch) || null,
    headSha: asString(raw.head_sha ?? raw.headSha) || null,
    createdAt: asString(raw.created_at ?? raw.createdAt) || null,
    updatedAt: asString(raw.updated_at ?? raw.updatedAt) || null,
    url: asString(raw.html_url ?? raw.url) || null,
    event: asString(raw.event) || null,
    attempt: Number(raw.run_attempt ?? raw.attempt) || 1,
  };
}

export function sortRunsNewestFirst(runs) {
  return [...runs].sort((left, right) => {
    const leftTime = Date.parse(left.createdAt ?? '') || 0;
    const rightTime = Date.parse(right.createdAt ?? '') || 0;
    return rightTime - leftTime || right.id - left.id;
  });
}

export function isTerminalRun(run) {
  return run?.status === 'completed';
}

export function shouldPollRun(run) {
  return Boolean(run) && !isTerminalRun(run);
}

export function selectDefaultRun(runs, branch) {
  const ordered = sortRunsNewestFirst(runs);
  if (branch) {
    const activeBranchRun = ordered.find((run) => run.headBranch === branch && !isTerminalRun(run));
    if (activeBranchRun) {
      return { run: activeBranchRun, reason: 'active-session-branch' };
    }
    const branchRun = ordered.find((run) => run.headBranch === branch);
    if (branchRun) {
      return { run: branchRun, reason: 'latest-session-branch' };
    }
  }
  return {
    run: ordered[0] ?? null,
    reason: ordered.length > 0 ? 'latest-repository' : 'no-runs',
  };
}

export function aggregateArtifactWeapon(artifact) {
  if (!artifact || artifact.expired === true) {
    return null;
  }
  return AGGREGATE_ARTIFACT_PATTERN.exec(asString(artifact.name))?.[1] ?? null;
}

export function expectedWeaponsFromJobs(jobs) {
  const weapons = [];
  const seen = new Set();
  for (const job of jobs ?? []) {
    const weapon = SWEEP_JOB_PATTERN.exec(asString(job?.name))?.[1];
    if (weapon && !seen.has(weapon)) {
      seen.add(weapon);
      weapons.push(weapon);
    }
  }
  return weapons;
}

function sameArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertAggregateShape(weapon, data) {
  if (
    !data ||
    !Array.isArray(data.seeds) ||
    !Array.isArray(data.weapons) ||
    data.weapons.length !== 1 ||
    data.weapons[0] !== weapon ||
    !Number.isInteger(data.maxFrames) ||
    data.maxFrames <= 0 ||
    typeof data.weaponPersonas !== 'boolean' ||
    !Array.isArray(data.summaries) ||
    data.summaries.length !== 1 ||
    data.summaries[0]?.weapon !== weapon ||
    !Array.isArray(data.allRecords)
  ) {
    throw new Error(`Malformed aggregate payload for weapon "${weapon}"`);
  }
  if (
    data.allRecords.length !== data.seeds.length ||
    data.summaries[0]?.records?.length !== data.seeds.length
  ) {
    throw new Error(`Incomplete aggregate payload for weapon "${weapon}"`);
  }
}

export function mergeAggregateOutputs(entries, options = {}) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  const byWeapon = new Map();
  const floorsByWeapon = new Map();
  for (const entry of entries) {
    const weapon = asString(entry?.weapon);
    assertAggregateShape(weapon, entry?.data);
    if (byWeapon.has(weapon)) {
      throw new Error(`Duplicate aggregate payload for weapon "${weapon}"`);
    }
    byWeapon.set(weapon, entry.data);
    floorsByWeapon.set(weapon, normalizeFloors(entry.data.floors));
  }

  const requestedOrder = options.expectedWeapons ?? [];
  const orderedWeapons = [
    ...requestedOrder.filter((weapon) => byWeapon.has(weapon)),
    ...[...byWeapon.keys()].filter((weapon) => !requestedOrder.includes(weapon)).sort(),
  ];
  const first = byWeapon.get(orderedWeapons[0]);
  const hasLegacyFloorMetadata = orderedWeapons.some(
    (weapon) => floorsByWeapon.get(weapon) === undefined,
  );
  const floors = [
    ...new Set(orderedWeapons.flatMap((weapon) => floorsByWeapon.get(weapon) ?? [])),
  ].sort((left, right) => left - right);

  for (const weapon of orderedWeapons.slice(1)) {
    const data = byWeapon.get(weapon);
    if (!sameArray(data.seeds, first.seeds)) {
      throw new Error(`Seed-set mismatch between "${orderedWeapons[0]}" and "${weapon}"`);
    }
    if (data.maxFrames !== first.maxFrames) {
      throw new Error(`Frame-budget mismatch between "${orderedWeapons[0]}" and "${weapon}"`);
    }
    if (data.weaponPersonas !== first.weaponPersonas) {
      throw new Error(`Persona-mode mismatch between "${orderedWeapons[0]}" and "${weapon}"`);
    }
  }

  return {
    runAt: options.runCreatedAt ?? first.runAt,
    ...(hasLegacyFloorMetadata ? {} : { floors }),
    seeds: [...first.seeds],
    weapons: orderedWeapons,
    maxFrames: first.maxFrames,
    weaponPersonas: first.weaponPersonas,
    budgetSec: first.budgetSec,
    summaries: orderedWeapons.map((weapon) => byWeapon.get(weapon).summaries[0]),
    allRecords: orderedWeapons.flatMap((weapon) => byWeapon.get(weapon).allRecords),
  };
}

export function floorProvenanceWarning(entries) {
  if (
    Array.isArray(entries) &&
    entries.length > 0 &&
    entries.some((entry) => entry?.data?.floors === undefined)
  ) {
    return 'Floors are Unknown because one or more contributing artifacts lack floor provenance.';
  }
  return null;
}

export function cloudResultWarning({ run, expectedWeapons, availableWeapons, expiredCount }) {
  if (expiredCount > 0 && availableWeapons.length === 0) {
    return 'This run no longer has downloadable aggregate artifacts.';
  }
  if (!isTerminalRun(run) && availableWeapons.length === 0) {
    return 'No aggregate weapon results are available yet. This active run will refresh automatically.';
  }
  const missing = expectedWeapons.filter((weapon) => !availableWeapons.includes(weapon));
  if (missing.length > 0) {
    if (isTerminalRun(run)) {
      return `Run finished with partial results. Missing: ${missing.join(', ')}.`;
    }
    return `Partial results available. Waiting for: ${missing.join(', ')}.`;
  }
  if (isTerminalRun(run) && run.conclusion && run.conclusion !== 'success') {
    return `Run concluded ${run.conclusion}; showing every available aggregate result.`;
  }
  return null;
}

/**
 * Returns true when the artifact is the post-release baseline-sweep bundle
 * (`baseline-<short-sha>`, uploaded by `deploy.yml`'s "Upload baseline as
 * artifact" step). It carries `baseline.json` and, when fun evaluation scored
 * successfully for that release, a sibling `fun-report.json`.
 *
 * @param {object} artifact
 */
export function isBaselineArtifact(artifact) {
  return (
    artifact != null &&
    artifact.expired !== true &&
    BASELINE_ARTIFACT_PATTERN.test(asString(artifact.name))
  );
}

/**
 * Produce a user-facing warning/status string for a baseline-sweep
 * (`deploy.yml`) run. Unlike weapon-sweep/AI Sweep Eval, there is only ever
 * one relevant artifact per run and no job-phase breakdown to report on, so
 * this stays deliberately simple.
 *
 * A missing fun-eval report is expected and non-fatal: it is diagnostic-only
 * data that legacy runs (captured before fun evaluation existed) or a scoring
 * failure will not have, so the baseline itself still renders.
 *
 * @param {{ run: object, hasArtifact: boolean, hasFunReport: boolean, expiredArtifactCount?: number }} options
 * @returns {string | null}
 */
export function baselineSweepWarning({ run, hasArtifact, hasFunReport, expiredArtifactCount = 0 }) {
  if (!isTerminalRun(run)) {
    return 'Baseline sweep is still running (can take up to ~2 hours). This will refresh automatically.';
  }
  if (!hasArtifact) {
    if (expiredArtifactCount > 0) {
      return "This run's baseline artifact has expired and is no longer downloadable.";
    }
    if (run.conclusion && run.conclusion !== 'success') {
      return `Run concluded ${run.conclusion}; no baseline artifact is available for this deploy.`;
    }
    return 'This deploy run has no baseline-sweep artifact (baseline-sweep only runs for a released push to main).';
  }
  if (run.conclusion && run.conclusion !== 'success') {
    return `Run concluded ${run.conclusion}; showing the baseline captured before failure.`;
  }
  if (!hasFunReport) {
    return 'Fun evaluation report is not available for this run (captured before fun evaluation existed, or scoring failed for this release).';
  }
  return null;
}

/**
 * Classify each AI Sweep Eval job into preflight / search / validate / aggregate
 * and return per-phase counters.
 *
 * @param {readonly object[]} jobs - Raw job objects from the GitHub API.
 * @returns {{ preflight: PhaseCount, search: PhaseCount, validate: PhaseCount, aggregate: PhaseCount }}
 */
export function parseAiSweepJobPhases(jobs) {
  /** @type {Record<string, { total: number, done: number, failed: number, running: number, pending: number }>} */
  const phases = {
    preflight: { total: 0, done: 0, failed: 0, running: 0, pending: 0 },
    search: { total: 0, done: 0, failed: 0, running: 0, pending: 0 },
    validate: { total: 0, done: 0, failed: 0, running: 0, pending: 0 },
    aggregate: { total: 0, done: 0, failed: 0, running: 0, pending: 0 },
  };

  for (const job of jobs ?? []) {
    const name = asString(job?.name);
    let phaseKey = null;
    for (const [key, pattern] of AI_SWEEP_PHASE_PATTERNS) {
      if (pattern.test(name)) {
        phaseKey = key;
        break;
      }
    }
    if (!phaseKey) continue;

    const phase = phases[phaseKey];
    phase.total += 1;
    const status = asString(job?.status);
    const conclusion = asString(job?.conclusion);
    if (status === 'completed') {
      if (conclusion === 'success' || conclusion === 'skipped') {
        phase.done += 1;
      } else {
        phase.failed += 1;
      }
    } else if (status === 'in_progress') {
      phase.running += 1;
    } else {
      phase.pending += 1;
    }
  }

  return phases;
}

/**
 * Returns true when the artifact represents the AI Sweep Eval final leaderboard.
 *
 * @param {object} artifact
 */
export function isLeaderboardArtifact(artifact) {
  return (
    artifact != null &&
    artifact.expired !== true &&
    asString(artifact.name) === LEADERBOARD_ARTIFACT_NAME
  );
}

/**
 * Produce a user-facing warning/status string for an AI Sweep Eval run.
 *
 * @param {{ run: object, jobPhases: object | null, hasLeaderboard: boolean, expiredArtifactCount?: number }} options
 * @returns {string | null}
 */
export function aiSweepWarning({ run, jobPhases, hasLeaderboard, expiredArtifactCount = 0 }) {
  if (isTerminalRun(run)) {
    if (!hasLeaderboard) {
      if (expiredArtifactCount > 0) {
        return 'Leaderboard artifact has expired and is no longer available.';
      }
      if (run.conclusion && run.conclusion !== 'success') {
        return `Run concluded ${run.conclusion}; no leaderboard artifact is available.`;
      }
      return 'Run completed without a leaderboard artifact.';
    }
    if (run.conclusion && run.conclusion !== 'success') {
      return `Run concluded ${run.conclusion}; leaderboard may be partial.`;
    }
    return null;
  }

  // Active run — describe phase progress.
  if (jobPhases) {
    if (jobPhases.aggregate.running > 0) {
      return 'Aggregating results into leaderboard…';
    }
    if (jobPhases.validate.running > 0 || jobPhases.validate.done > 0) {
      const done = jobPhases.validate.done + jobPhases.validate.failed;
      return `Validation in progress: ${done}/${jobPhases.validate.total} combos complete. Refreshing automatically.`;
    }
    if (jobPhases.search.running > 0 || jobPhases.search.done > 0) {
      const done = jobPhases.search.done + jobPhases.search.failed;
      return `Search in progress: ${done}/${jobPhases.search.total} combos complete. Refreshing automatically.`;
    }
    return 'AI Sweep Eval starting up. Refreshing automatically.';
  }
  return 'No leaderboard results available yet. This active run will refresh automatically.';
}
