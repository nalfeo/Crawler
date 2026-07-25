/**
 * Trial runner — executes ONE agent session against ONE task under ONE arm.
 *
 * Isolation is the whole game here. A replayed PR's real solution lives in this
 * repository's future history, so a naive worktree would let the agent simply
 * read the answer. Every trial therefore runs in a **history-free snapshot**:
 * the base commit's files are copied out, `.git` is discarded, and a fresh
 * single-commit repository is initialised in its place. There is no remote, no
 * reflog, and no future commit to find.
 *
 * The snapshot is a mitigation, not a proof, so `metrics.auditLeak` independently
 * scans every transcript for solution identifiers and the experiment excludes
 * any trial that trips it.
 */
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { readTrialMetrics } from './metrics.js';
import { EMPTY_METRICS } from './metrics.js';
import { EMPTY_CONTEXT, readContextMetrics } from './context.js';
import type { ArmSpec, TaskSpec, TrialResult } from './types.js';

export interface TrialOptions {
  repoRoot: string;
  /** Directory that holds every trial workspace for this experiment. */
  trialsRoot: string;
  experimentId: string;
  repetition: number;
  defaultModel?: string;
  maxAiCredits?: number;
  timeoutMs: number;
  /** Run `npm ci` instead of linking the host `node_modules`. Slow but exact. */
  install: boolean;
  /** Tools denied to the trial agent (leak-surface reduction). */
  denyTools: readonly string[];
  /** Skip the agent and verifier; used to smoke-test isolation cheaply. */
  dryRun?: boolean;
}

export const DEFAULT_DENY_TOOLS = [
  // Anything that can reach the public repo can hand the agent the original
  // patch. Denying network tools is necessary but not sufficient — see
  // `TRIAL_ENV_SCRUB` for the credential half.
  'web_search',
  'web_fetch',
  'github-mcp-server-get_file_contents',
  'github-mcp-server-search_code',
  'github-mcp-server-get_copilot_space',
  'session_store_sql',
] as const;

/**
 * Environment variables blanked for trial sessions.
 *
 * This is a **partial** control and must not be mistaken for a sandbox. It
 * removes one path — a token inherited by subprocesses — but three routes to
 * the solution remain open, all verified empirically:
 *
 * 1. `gh` falls back to the **OS keyring** when these vars are unset, so it
 *    still authenticates.
 * 2. An unauthenticated `git ls-remote` against a public repo succeeds.
 * 3. Poisoning the vars with an invalid token *does* block `gh` — but it also
 *    breaks the Copilot CLI under test, which requires a valid token to start.
 *
 * Because prevention is unachievable in-process, the real control is detection:
 * `auditCommandLeak` flags any trial that attempted remote access, and flagged
 * trials are excluded from the verdict.
 */
export const TRIAL_ENV_SCRUB = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GITHUB_ENTERPRISE_TOKEN',
  'GH_ENTERPRISE_TOKEN',
  'GH_CONFIG_DIR',
  'GIT_ASKPASS',
  'SSH_AUTH_SOCK',
] as const;

/**
 * Build the environment a trial runs in: the ambient environment minus the
 * credentials that are safe to remove.
 *
 * Verified: the Copilot CLI still authenticates with all of these unset (it
 * uses its own trampoline credentials), so removing them costs nothing.
 */
export function buildTrialEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of TRIAL_ENV_SCRUB) delete env[key];
  // Force git to fail fast rather than prompt or reuse a stored credential.
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function git(args: readonly string[], cwd: string): string {
  // `core.longpaths` is required on Windows: this repo has doc paths that blow
  // past MAX_PATH once nested under a trial-workspace root.
  return execFileSync('git', ['-c', 'core.longpaths=true', ...args], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
}

/**
 * Default root for trial workspaces.
 *
 * Deliberately outside the repo and as short as possible — nesting a full repo
 * checkout under an already-deep worktree path exceeds Windows' MAX_PATH.
 */
export function defaultWorkRoot(...segments: string[]): string {
  return join(tmpdir(), 'crawler-velocity', ...segments);
}

/**
 * Materialise `commit` as a plain directory with no git history.
 *
 * Implemented as `git worktree add --detach` + copy-without-`.git`, which is
 * cross-platform and avoids depending on `tar` being present.
 */
export function createHistoryFreeSnapshot(
  repoRoot: string,
  commit: string,
  destination: string,
): void {
  const staging = `${destination}__staging`;
  rmSync(staging, { recursive: true, force: true });
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(dirname(destination), { recursive: true });

  git(['worktree', 'add', '--detach', '--force', staging, commit], repoRoot);
  try {
    cpSync(staging, destination, {
      recursive: true,
      // `.git` in a linked worktree is a pointer file back to the real repo —
      // copying it would hand the trial the entire future history.
      filter: (source) => {
        const rel = relative(staging, source);
        return rel !== '.git' && !rel.startsWith(`.git${sep}`);
      },
    });
  } finally {
    git(['worktree', 'remove', '--force', staging], repoRoot);
  }

  if (existsSync(join(destination, '.git'))) {
    throw new Error(`Snapshot leak: ${destination} still contains a .git entry.`);
  }
}

/** Assert the snapshot really cannot reach the solution commit. */
export function assertIsolated(snapshot: string, solutionCommit: string): void {
  const probe = spawnSync('git', ['cat-file', '-e', `${solutionCommit}^{commit}`], {
    cwd: snapshot,
    encoding: 'utf8',
  });
  if (probe.status === 0) {
    throw new Error(
      `Isolation failure: solution commit ${solutionCommit} is reachable from the trial ` +
        `workspace ${snapshot}. Aborting rather than measuring a contaminated trial.`,
    );
  }
}

function linkNodeModules(repoRoot: string, snapshot: string, install: boolean): void {
  const target = join(snapshot, 'node_modules');
  if (install) {
    execFileSync('npm', ['ci'], {
      cwd: snapshot,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    return;
  }
  const source = join(repoRoot, 'node_modules');
  if (!existsSync(source)) {
    throw new Error(
      `Cannot link node_modules: ${source} does not exist. Run npm ci, or pass --install.`,
    );
  }
  symlinkSync(source, target, 'junction');
}

/**
 * The prompt actually passed on the command line.
 *
 * The task brief is written to `TASK.md` in the workspace instead of being
 * inlined: a multi-line prompt containing quotes and backticks cannot survive
 * `cmd.exe` argument concatenation on Windows, and silently produced empty
 * sessions. The indirection costs every arm exactly one file read, so it does
 * not bias the comparison.
 */
export const TRIAL_PROMPT =
  'Read TASK.md in the current directory and fully implement the change it describes.';

/** Restore the frozen verifier and commit the starting state. */
function seedVerifier(snapshot: string, task: TaskSpec): void {
  for (const file of task.verifierFiles) {
    const destination = join(snapshot, file.path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, file.contents, 'utf8');
  }
  writeFileSync(join(snapshot, 'TASK.md'), `${task.prompt}\n`, 'utf8');
  git(['init', '-q'], snapshot);
  git(['config', 'user.email', 'velocity-lab@crawler.invalid'], snapshot);
  git(['config', 'user.name', 'Velocity Lab'], snapshot);
  git(['add', '-A'], snapshot);
  git(['commit', '-q', '-m', 'velocity-lab: trial baseline'], snapshot);
}

/**
 * Build the exact workspace a trial starts from: a history-free snapshot of the
 * base commit, with the frozen verifier restored and dependencies available.
 *
 * Shared with `velocity:pack verify-base`, so the fail-to-pass check validates
 * the same workspace the agent will actually see.
 */
export function prepareTrialWorkspace(
  repoRoot: string,
  task: TaskSpec,
  destination: string,
  install: boolean,
): void {
  createHistoryFreeSnapshot(repoRoot, task.baseCommit, destination);
  seedVerifier(destination, task);
  assertIsolated(destination, task.solutionCommit);
  linkNodeModules(repoRoot, destination, install);
}

/**
 * Quote one argument for the platform shell.
 *
 * `spawnSync(cmd, args, { shell: true })` does NOT escape — it concatenates
 * args with spaces, so anything containing a space arrives as several
 * arguments. That silently produced empty transcripts, so the command line is
 * assembled and quoted explicitly instead.
 */
export function quoteShellArg(value: string): string {
  if (process.platform === 'win32') {
    // cmd.exe: double quotes, with embedded quotes backslash-escaped.
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`;
  }
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function toShellCommand(command: string, args: readonly string[]): string {
  return [command, ...args.map(quoteShellArg)].join(' ');
}

export function buildCopilotArgs(
  arm: ArmSpec,
  options: TrialOptions,
  sessionId: string,
  snapshot: string,
): string[] {
  const args = [
    '-p',
    TRIAL_PROMPT,
    '-C',
    snapshot,
    '--allow-all-tools',
    '--no-ask-user',
    '--output-format',
    'json',
    '--log-level',
    'none',
    '--no-remote',
    '--no-remote-export',
    '--session-id',
    sessionId,
  ];
  // An arm's model config must be explicit — inheriting an ambient default
  // would let the control arm drift between runs.
  const model = arm.model ?? options.defaultModel;
  if (model) args.push('--model', model);
  if (arm.reasoningEffort) args.push('--effort', arm.reasoningEffort);
  if (arm.contextTier) args.push('--context', arm.contextTier);
  if (arm.agent) args.push('--agent', arm.agent);
  if (options.maxAiCredits !== undefined)
    args.push('--max-ai-credits', String(options.maxAiCredits));
  for (const tool of options.denyTools) args.push('--deny-tool', tool);
  return args;
}

export function runTrial(task: TaskSpec, arm: ArmSpec, options: TrialOptions): TrialResult {
  const startedAt = new Date().toISOString();
  const label = `${task.id}__${arm.id}__r${options.repetition}`;
  const snapshot = resolve(options.trialsRoot, label);
  const transcriptPath = `${snapshot}.jsonl`;
  const sessionId = randomUUID();

  const failure = (error: string): TrialResult => ({
    taskId: task.id,
    armId: arm.id,
    repetition: options.repetition,
    sessionId: null,
    verifierPassed: false,
    verifierExitCode: null,
    error,
    metrics: { ...EMPTY_METRICS },
    context: { ...EMPTY_CONTEXT },
    leakSignals: [],
    budgetExhausted: false,
    transcriptPath,
    startedAt,
    finishedAt: new Date().toISOString(),
  });

  try {
    prepareTrialWorkspace(options.repoRoot, task, snapshot, options.install);

    for (const command of arm.setup ?? []) {
      const setup = spawnSync(command, {
        cwd: snapshot,
        shell: true,
        encoding: 'utf8',
        timeout: options.timeoutMs,
      });
      if (setup.status !== 0) {
        return failure(`Arm setup failed (${command}): ${setup.stderr ?? ''}`.trim());
      }
    }
  } catch (error) {
    return failure(`Trial setup failed: ${(error as Error).message}`);
  }

  if (options.dryRun) {
    writeFileSync(transcriptPath, '', 'utf8');
    return { ...failure('dry-run: agent not executed'), error: null };
  }

  const agent = spawnSync(
    toShellCommand('copilot', buildCopilotArgs(arm, options, sessionId, snapshot)),
    {
      cwd: snapshot,
      encoding: 'utf8',
      timeout: options.timeoutMs,
      maxBuffer: 256 * 1024 * 1024,
      shell: true,
      env: buildTrialEnv(),
    },
  );
  writeFileSync(transcriptPath, agent.stdout ?? '', 'utf8');

  // A launch failure used to surface as a plain "0 turns" row, which reads like
  // a lazy agent rather than a broken harness. Always propagate the reason.
  const agentStderr = (agent.stderr ?? '').trim();
  const agentFailure =
    agent.error != null
      ? `agent: ${agent.error.message}`
      : (agent.stdout ?? '').trim().length === 0
        ? `agent produced no transcript (exit ${agent.status})${agentStderr ? `: ${agentStderr.slice(0, 500)}` : ''}`
        : null;
  if (agentFailure) process.stderr.write(`   ⚠️  ${agentFailure}\n`);

  const verifier = spawnSync(task.verifierCommand, {
    cwd: snapshot,
    shell: true,
    encoding: 'utf8',
    timeout: options.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });

  const {
    metrics,
    sessionId: observedSession,
    leakSignals,
    budgetExhausted,
  } = readTrialMetrics(transcriptPath, task);
  if (budgetExhausted) {
    process.stderr.write(
      `   ⚠️  hit the AI-credit ceiling — raise maxAiCredits; this trial is censored, not failed\n`,
    );
  }

  const sessionIdForContext = observedSession ?? sessionId;
  return {
    taskId: task.id,
    armId: arm.id,
    repetition: options.repetition,
    sessionId: sessionIdForContext,
    verifierPassed: verifier.status === 0,
    verifierExitCode: verifier.status,
    error: agentFailure,
    metrics,
    context: readContextMetrics(sessionIdForContext),
    leakSignals,
    budgetExhausted,
    transcriptPath,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
