import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createCliEntryResolver } from './cli-bundle.mjs';

const execFileAsync = promisify(execFile);
const cliEntryResolvers = new Map();

function cliEntryResolverFor(repoRoot, log) {
  let resolver = cliEntryResolvers.get(repoRoot);
  if (!resolver) {
    resolver = createCliEntryResolver({ repoRoot, log });
    cliEntryResolvers.set(repoRoot, resolver);
  }
  return resolver;
}

export { cliEntryResolverFor };
const SERIALIZED_ACTIONS = new Set([
  'state',
  'item-review',
  'set-review',
  'advance',
  'save-plan',
  'approve-remaining',
  'save-and-approve-brief',
]);
const SET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Roster synthesis makes a chat call; give it more headroom than a state read. */
const SYNTH_TIMEOUT_MS = 240_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;

export function listAuthoredThemeSetIds(repoRoot) {
  let entries;
  try {
    entries = readdirSync(path.join(repoRoot, 'data', 'theme-equipment-sets'), {
      withFileTypes: true,
    });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => entry.name.slice(0, -'.json'.length))
    .filter((id) => SET_ID_PATTERN.test(id))
    .sort();
}

/**
 * Resolve which set a freshly-opened canvas should show.
 *
 * Returns `null` when there is no unambiguous choice (zero authored
 * plans, or several). The canvas then opens on its set index instead of
 * refusing to open — a picker is a better answer to "which set?" than an
 * error telling the user to reopen with different arguments.
 */
export function resolveThemeSetId(repoRoot, requestedSetId) {
  if (requestedSetId) return requestedSetId;
  const available = listAuthoredThemeSetIds(repoRoot);
  return available.length === 1 ? available[0] : null;
}

export function createSerializedThemeEquipmentReviewRunner(execute) {
  const tails = new Map();
  return (command) => {
    if (!SERIALIZED_ACTIONS.has(command.action)) return execute(command);
    const key = serializationKey(command);
    const previous = tails.get(key) ?? Promise.resolve();
    const current = previous.then(() => execute(command));
    const tail = current.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    void tail.finally(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return current;
  };
}

/**
 * Serialize per set. `save-plan` carries the set id inside the plan
 * rather than at the top level, so two concurrent saves of the same
 * plan still queue behind each other.
 */
function serializationKey(command) {
  if (command.action === 'save-plan') return `plan:${command.plan?.id ?? ''}`;
  return command.setId;
}

export async function runThemeEquipmentReviewCommand(command, repoRoot, log) {
  const encoded = Buffer.from(JSON.stringify(command), 'utf8').toString('base64url');
  const env = loadRepoEnv(repoRoot);
  const argv = await cliEntryResolverFor(repoRoot, log)();
  try {
    const { stdout } = await execFileAsync('node', [...argv, encoded], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      maxBuffer: 24 * 1024 * 1024,
      windowsHide: true,
      timeout: command.action === 'synth-roster' ? SYNTH_TIMEOUT_MS : DEFAULT_COMMAND_TIMEOUT_MS,
    });
    return JSON.parse(stdout);
  } catch (error) {
    const detail = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(detail || error?.message || String(error));
  }
}

/**
 * Long-lived branch that holds authored plans as the shared "common place".
 * `init` reads the plan from here (via an immutable commit pinned at dispatch),
 * not from whatever workspace branch happens to be checked out.
 */
const PLANS_BRANCH = 'assets/plans';

/**
 * Resolve the git ref the workflow should run against.
 *
 * `gh workflow run` without `--ref` dispatches against the repository's
 * DEFAULT branch, and the workflow then reads `plan_path` from that ref.
 * Telling the user to "commit and push first" is therefore not enough on
 * its own — a plan pushed to a feature branch would still be invisible to
 * a default-branch run. Every dispatch pins the current branch explicitly.
 */
export async function resolveDispatchRef(repoRoot, env = loadRepoEnv(repoRoot)) {
  const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
  });
  const ref = stdout.trim();
  if (!ref || ref === 'HEAD') {
    throw new Error(
      'Cannot dispatch from a detached HEAD. Check out a branch and push it before running the workflow.',
    );
  }
  return ref;
}

/**
 * Resolve the repository's DEFAULT branch. `init` runs the pipeline *tooling*
 * from here (not the caller's workspace branch) so a stale feature branch can
 * never ship out-of-date scripts, while the plan itself comes from the pinned
 * `assets/plans` commit.
 */
export async function resolveDefaultBranch(repoRoot, env = loadRepoEnv(repoRoot)) {
  const { stdout } = await execFileAsync(
    'gh',
    ['repo', 'view', '--json', 'defaultBranchRef', '--jq', '.defaultBranchRef.name'],
    { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true, timeout: 20_000 },
  );
  const branch = stdout.trim();
  if (!branch) {
    throw new Error(
      'Could not resolve the repository default branch for the theme-equipment workflow.',
    );
  }
  return branch;
}

/**
 * Confirm the authored plan is visible on the remote ref the workflow
 * will check out, and return the **immutable commit SHA** of that ref's tip
 * so the dispatch can pin it (rather than the mutable branch name). Pinning
 * the SHA closes a dispatch TOCTOU: without it, a concurrent save could swap
 * the branch's bytes between this check and the workflow's fetch.
 *
 * This must be judged against the *remote*, so the fetch has to succeed: a
 * failed fetch leaves any local ref at whatever it was last time, and stale
 * local state can still contain a plan that is no longer on the branch the
 * workflow will run.
 *
 * The tip is fetched into a private, per-call ref rather than read from
 * `FETCH_HEAD` or `origin/<ref>`, both of which are shared per repository
 * and can be overwritten by a concurrent git process mid-check.
 *
 * The durable `assets/plans` blob is authoritative. A local copy may be
 * missing (another machine authored the plan) or stale (another machine
 * overwrote it on the durable branch). In either case `init` must still use
 * the pinned remote bytes because that is what the workflow will fetch.
 */
export async function assertPlanOnRef(repoRoot, ref, planPath, env = loadRepoEnv(repoRoot)) {
  const options = { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true, timeout: 30_000 };
  const scratch = `refs/theme-equipment-dispatch/${randomUUID()}`;
  try {
    try {
      await execFileAsync('git', ['fetch', '--quiet', 'origin', `+${ref}:${scratch}`], options);
    } catch (error) {
      throw new Error(
        `Could not fetch origin/${ref} to confirm ${planPath} is pushed. The workflow reads the ` +
          `plan from the remote ref, so initialization is refused rather than trusting stale local ` +
          `state. Push this branch (and check your connection), then initialize.`,
        { cause: error },
      );
    }
    let sha;
    try {
      const { stdout } = await execFileAsync('git', ['rev-parse', scratch], options);
      sha = stdout.trim();
    } catch (error) {
      throw new Error(`Could not resolve the tip commit of origin/${ref}.`, { cause: error });
    }
    if (!sha) throw new Error(`Could not resolve the tip commit of origin/${ref}.`);
    try {
      await execFileAsync('git', ['cat-file', '-p', `${scratch}:${planPath}`], options);
    } catch {
      throw new Error(
        `${planPath} was not found on origin/${ref}. Commit the plan and push this branch, ` +
          `then initialize — the workflow reads the plan from the ref it runs on.`,
      );
    }
    return sha;
  } finally {
    await execFileAsync('git', ['update-ref', '-d', scratch], options).catch(() => {});
  }
}

export async function dispatchThemeEquipmentWorkflow(repoRoot, setId, action) {
  if (action !== 'init' && action !== 'run-phase' && action !== 'publish') {
    throw new Error(`Unsupported theme-equipment workflow action "${action}".`);
  }
  if (!SET_ID_PATTERN.test(setId ?? '')) {
    throw new Error(`Invalid theme-equipment set id "${setId}".`);
  }
  const env = loadRepoEnv(repoRoot);
  const planPath = `data/theme-equipment-sets/${setId}.json`;

  // `init` runs the pipeline tooling from the DEFAULT branch (never a stale
  // workspace branch) and reads the plan from the durable `assets/plans`
  // branch, pinned to an immutable commit so a concurrent save cannot swap
  // the bytes between the check here and the workflow's fetch. run-phase and
  // publish continue to operate the caller's branch tooling against durable
  // state and are left unchanged.
  let ref;
  let planRef;
  if (action === 'init') {
    ref = await resolveDefaultBranch(repoRoot, env);
    planRef = await assertPlanOnRef(repoRoot, PLANS_BRANCH, planPath, env);
  } else {
    ref = await resolveDispatchRef(repoRoot, env);
  }

  const args = [
    'workflow',
    'run',
    'theme-equipment.yml',
    '--ref',
    ref,
    '--field',
    `action=${action}`,
    '--field',
    `set_id=${setId}`,
  ];
  if (action === 'init') {
    args.push('--field', `plan_path=${planPath}`, '--field', `plan_ref=${planRef}`);
  }
  try {
    await execFileAsync('gh', args, {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
    return { dispatched: true, action, setId, ref, ...(planRef ? { planRef } : {}) };
  } catch (error) {
    const detail = typeof error?.stderr === 'string' ? error.stderr.trim() : '';
    throw new Error(detail || error?.message || String(error));
  }
}

/** Bound the run-status probe tightly — it polls, so a hung gh call must not pile up. */
const RUN_STATUS_TIMEOUT_MS = 20_000;
const RUN_STATUS_WORKFLOW = 'theme-equipment.yml';

/**
 * Report the most recent GitHub Actions run for this set on the current branch,
 * so the canvas can show a dispatched run progressing without leaving the board.
 *
 * Correlation: the workflow's run-name ends in " · <set_id>" (see
 * theme-equipment.yml). Matching on that exact suffix is collision-safe because a
 * set id cannot contain " · " — "… · classic-fantasy" never matches
 * "classic-fantasy-basic-leather".
 *
 * Three distinct outcomes, kept separate so the UI can tell a quiet pipeline from
 * a broken one:
 *   { available: true,  run: {...}, ref }  — a matching run was found
 *   { available: true,  run: null,  ref }  — gh worked, no matching run yet
 *   { available: false, errorKind }        — gh/auth/network failure
 */
/**
 * Pure correlation + normalization for a `gh run list --json …` payload. Kept
 * separate from the `gh` shell so the collision-safe title match and the
 * field-by-field normalization can be unit-tested without a live GitHub call.
 * Returns the normalized run object, or null when nothing matches (or the
 * payload is not an array).
 *
 * The run-name is "Theme Equipment <action> · <setId>". We anchor the WHOLE
 * title rather than only its " · <setId>" suffix: the action segment cannot
 * contain the "·" separator, so a run dispatched with a crafted set_id like
 * "x · classic-fantasy" (title "… · x · classic-fantasy", suffix-matches
 * "classic-fantasy") introduces a second "·" and fails the anchored match — it
 * can no longer masquerade as the run for "classic-fantasy". Anchoring on "$"
 * also preserves the prefix-collision safety (a shorter id never matches a
 * longer id's run). setId is regex-escaped defensively; authored ids are
 * kebab-case and contain no metacharacters.
 */
export function selectThemeEquipmentRun(runs, setId) {
  if (!Array.isArray(runs)) return null;
  const escapedSetId = String(setId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const titlePattern = new RegExp('^Theme Equipment [^·]+ · ' + escapedSetId + '$');
  const match = runs.find(
    (run) => typeof run?.displayTitle === 'string' && titlePattern.test(run.displayTitle),
  );
  if (!match) return null;
  const databaseId = Number(match.databaseId);
  return {
    databaseId: Number.isInteger(databaseId) && databaseId > 0 ? databaseId : null,
    status: typeof match.status === 'string' ? match.status : null,
    conclusion: typeof match.conclusion === 'string' && match.conclusion ? match.conclusion : null,
    url: typeof match.url === 'string' ? match.url : null,
    createdAt: typeof match.createdAt === 'string' ? match.createdAt : null,
    displayTitle: typeof match.displayTitle === 'string' ? match.displayTitle : null,
  };
}

export async function themeEquipmentRunStatus(repoRoot, setId) {
  if (!SET_ID_PATTERN.test(setId ?? '')) {
    return { available: false, errorKind: 'invalid-set-id' };
  }
  const env = loadRepoEnv(repoRoot);
  let stdout;
  try {
    // No `--branch` filter: `init` now runs on the default branch while
    // run-phase/publish run on the caller's branch, so a branch filter would
    // hide half the runs for a set. Correlation is by displayTitle+setId via
    // selectThemeEquipmentRun, which is branch-agnostic.
    ({ stdout } = await execFileAsync(
      'gh',
      [
        'run',
        'list',
        `--workflow=${RUN_STATUS_WORKFLOW}`,
        '--limit',
        '30',
        '--json',
        'databaseId,status,conclusion,url,createdAt,displayTitle',
      ],
      { cwd: repoRoot, env, encoding: 'utf8', windowsHide: true, timeout: RUN_STATUS_TIMEOUT_MS },
    ));
  } catch (error) {
    const detail = typeof error?.stderr === 'string' ? error.stderr.trim() : error?.message;
    return { available: false, errorKind: 'gh-failed', detail };
  }
  let runs;
  try {
    runs = JSON.parse(stdout);
  } catch {
    return { available: false, errorKind: 'parse-failed' };
  }
  return { available: true, run: selectThemeEquipmentRun(runs, setId) };
}

export function loadRepoEnv(repoRoot, baseEnv = process.env) {
  const env = { ...baseEnv };
  const envPath = path.join(repoRoot, '.env.local');
  if (!existsSync(envPath)) return env;
  for (const rawLine of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || env[key] !== undefined) continue;
    let value = line.slice(separator + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
