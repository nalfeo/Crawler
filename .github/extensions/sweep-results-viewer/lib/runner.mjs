import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { normalizeRun, sortRunsNewestFirst } from './cloud-results.mjs';
import { parseGitHubRepository, sanitizeErrorText } from './github-client.mjs';

const execFileAsync = promisify(execFile);
const MAX_BUFFER = 10 * 1024 * 1024;
const DEFAULT_WEAPONS = ['sword', 'bow', 'baseball-bat'];
const ALLOWED_WEAPONS = new Set([
  'sword',
  'bow',
  'baseball-bat',
  'pistol',
  'throwing-knife',
  'fireball',
]);
const VALID_COMBO_RE = /^[A-Za-z0-9+_.-]+$/;
const VALID_BRANCH_RE = /^[A-Za-z0-9._/@+-]+$/;
const BARE_SHA_RE = /^[0-9a-f]{7,40}$/i;
const VALID_RANGE_RE = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;

async function runCommand(binary, args, options = {}) {
  try {
    const result = await execFileAsync(binary, args, {
      cwd: options.cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GH_PROMPT_DISABLED: '1',
        GIT_TERMINAL_PROMPT: '0',
        GH_PAGER: 'cat',
        PAGER: 'cat',
      },
      maxBuffer: options.maxBuffer ?? MAX_BUFFER,
      signal: options.signal,
      windowsHide: true,
    });
    return result.stdout.trim();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    const detail = sanitizeErrorText(error?.stderr || error?.message || error);
    throw new Error(`${binary} command failed${detail ? `: ${detail}` : ''}`);
  }
}

async function runGhJson(args, options = {}) {
  const output = await runCommand('gh', args, options);
  try {
    return JSON.parse(output || '{}');
  } catch {
    throw new Error('GitHub CLI returned invalid JSON.');
  }
}

function parsePositiveInteger(value, name, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} must be an integer in [${min},${max}].`);
  }
  return parsed;
}

function validateBranch(ref) {
  const value = String(ref ?? '').trim();
  if (!value || !VALID_BRANCH_RE.test(value) || value.includes('..') || BARE_SHA_RE.test(value)) {
    throw new Error('branch must be a safe branch name, not a tag or bare SHA.');
  }
  return value;
}

export function parseWeapons(value = DEFAULT_WEAPONS) {
  const raw = Array.isArray(value) ? value : String(value).split(',');
  const weapons = raw.map((weapon) => String(weapon).trim().toLowerCase()).filter(Boolean);
  if (weapons.length === 0) throw new Error('weapons must contain at least one entry.');
  const seen = new Set();
  for (const weapon of weapons) {
    if (!ALLOWED_WEAPONS.has(weapon)) throw new Error(`Unsupported weapon: ${weapon}.`);
    if (seen.has(weapon)) throw new Error(`Duplicate weapon: ${weapon}.`);
    seen.add(weapon);
  }
  return weapons;
}

function validateSeedRange(value, name) {
  const text = String(value ?? '').trim();
  if (!VALID_RANGE_RE.test(text)) {
    throw new Error(`${name} must be a comma-separated list of integers or ranges.`);
  }
  return text;
}

function validateCombos(value) {
  const text = String(value ?? 'all').trim();
  if (text === 'all') return text;
  const combos = text
    .split(',')
    .map((combo) => combo.trim())
    .filter(Boolean);
  if (combos.length === 0) throw new Error('combos must be "all" or a comma-separated combo list.');
  for (const combo of combos) {
    if (!VALID_COMBO_RE.test(combo)) throw new Error(`Unsafe combo id: ${combo}.`);
  }
  return combos.join(',');
}

export function viewerReference(runId) {
  return `project:sweep-results-viewer runId=${runId}`;
}

export function selectDispatchedRun(beforeRuns = [], afterRuns = []) {
  const beforeIds = new Set(beforeRuns.map((run) => Number(run.id)));
  const newRuns = afterRuns.filter((run) => !beforeIds.has(Number(run.id)));
  return newRuns.length === 1 ? newRuns[0] : null;
}

export function weaponSweepDispatchArgs(input = {}) {
  const ref = validateBranch(input.ref ?? input.branch ?? 'main');
  const seedCount = parsePositiveInteger(input.seedCount ?? 100, 'seedCount', 1, 100);
  const weapons = parseWeapons(input.weapons ?? DEFAULT_WEAPONS);
  const maxFrames = parsePositiveInteger(input.maxFrames ?? 19_800, 'maxFrames', 1, 600_000);
  const weaponPersonas = input.weaponPersonas === false ? 'false' : 'true';
  return [
    'workflow',
    'run',
    'weapon-sweep.yml',
    '--ref',
    ref,
    '-f',
    `seed_count=${seedCount}`,
    '-f',
    `weapons=${weapons.join(',')}`,
    '-f',
    `weapon_personas=${weaponPersonas}`,
    '-f',
    `max_frames=${maxFrames}`,
  ];
}

export function aiSweepDispatchArgs(input = {}) {
  const ref = validateBranch(input.ref ?? input.branch ?? 'main');
  const combos = validateCombos(input.combos ?? 'all');
  const trainSeeds = validateSeedRange(input.trainSeeds ?? '1-24', 'trainSeeds');
  const validateSeeds = validateSeedRange(input.validateSeeds ?? '1-40', 'validateSeeds');
  const weapons = parseWeapons(input.weapons ?? DEFAULT_WEAPONS);
  const rounds = parsePositiveInteger(input.rounds ?? 2, 'rounds', 0, 3);
  const secondary = input.secondary === false ? 'false' : 'true';
  const args = [
    'workflow',
    'run',
    'ai-sweep.yml',
    '--ref',
    ref,
    '-f',
    `combos=${combos}`,
    '-f',
    `train_seeds=${trainSeeds}`,
    '-f',
    `validate_seeds=${validateSeeds}`,
    '-f',
    `weapons=${weapons.join(',')}`,
    '-f',
    `rounds=${rounds}`,
    '-f',
    `secondary=${secondary}`,
  ];
  if (input.resumeRunId != null && String(input.resumeRunId).trim() !== '') {
    args.push(
      '-f',
      `resume_run_id=${parsePositiveInteger(input.resumeRunId, 'resumeRunId', 1, Number.MAX_SAFE_INTEGER)}`,
    );
  }
  return args;
}

async function resolveRepository(cwd, signal) {
  const remote = await runCommand('git', ['remote', 'get-url', 'origin'], { cwd, signal });
  const repository = parseGitHubRepository(remote);
  if (!repository) throw new Error('Origin remote is not a supported github.com repository.');
  return repository;
}

async function listWorkflowRuns(repository, workflowFile, branch, signal) {
  const response = await runGhJson(
    [
      'api',
      '--method',
      'GET',
      `repos/${repository}/actions/workflows/${workflowFile}/runs?branch=${encodeURIComponent(branch)}&event=workflow_dispatch&per_page=10`,
    ],
    { signal },
  );
  if (!Array.isArray(response.workflow_runs)) {
    throw new Error('GitHub API did not return workflow_runs.');
  }
  return sortRunsNewestFirst(response.workflow_runs.map((run) => normalizeRun(run)));
}

export async function dispatchSweep(input = {}, options = {}) {
  const type = input.type === 'ai-sweep' ? 'ai-sweep' : 'weapon-sweep';
  const args = type === 'ai-sweep' ? aiSweepDispatchArgs(input) : weaponSweepDispatchArgs(input);
  const workflowFile = type === 'ai-sweep' ? 'ai-sweep.yml' : 'weapon-sweep.yml';
  const ref = args[args.indexOf('--ref') + 1];
  const repository = options.repository ?? (await resolveRepository(options.cwd, options.signal));
  const beforeRuns = await listWorkflowRuns(repository, workflowFile, ref, options.signal);
  await runCommand('gh', args, { cwd: options.cwd, signal: options.signal });
  const runs = await listWorkflowRuns(repository, workflowFile, ref, options.signal);
  const run = selectDispatchedRun(beforeRuns, runs);
  if (!run) {
    return {
      workflow: workflowFile,
      ref,
      repository,
      status: 'dispatched',
      warning:
        'Workflow dispatch succeeded, but an exact new run id is not identifiable yet. Recheck workflow runs and only cite a Sweep Results Viewer runId after the run is exact.',
    };
  }
  return {
    workflow: workflowFile,
    ref,
    repository,
    run,
    status: run.status,
    viewerReference: viewerReference(run.id),
  };
}

export const _private = {
  runCommand,
  runGhJson,
  validateBranch,
  validateSeedRange,
  validateCombos,
};
