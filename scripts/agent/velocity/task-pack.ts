/**
 * Task-pack builder — turns merged Crawler PRs into replayable benchmark tasks.
 *
 * Construction (the SWE-bench recipe, applied to this repo):
 *   1. Find the PR's merge commit and its first parent (the state of `main`
 *      immediately before the PR landed). That parent is the trial start point.
 *   2. Split the PR's changed files into TESTS and SOLUTION.
 *   3. Freeze the test files as the verifier, captured at the merged commit and
 *      hashed. The verifier therefore exists before any experiment arm does, so
 *      no arm can tune the goalposts.
 *   4. Record the solution commit + file list for the leak audit only. Neither
 *      is ever handed to a trial.
 *
 * Usage:
 *   npm run velocity:pack -- build --prs 1930,1875 --id floor1-core
 *   npm run velocity:pack -- validate --pack <path>
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { prepareTrialWorkspace, defaultWorkRoot } from './trial-runner.js';
import { TASK_PACK_SCHEMA, type TaskPack, type TaskSpec, type VerifierFile } from './types.js';

const DEFAULT_PACK_DIR = 'docs/knowledge/metrics/velocity/packs';

/** Paths that count as verifier (frozen) rather than solution (hidden). */
const TEST_PATH_PATTERN = /^tests\//;

/**
 * Documentation the PR happened to carry (handoffs, review ledgers). It is not
 * something a replaying agent must reproduce, so it is excluded from the
 * solution-file list that gauges task difficulty.
 */
const NON_SOLUTION_PATTERN = /^docs\//;

/**
 * Vitest project membership, mirroring `vitest.config.ts`. A verifier must name
 * its project explicitly: a filter that matches zero files would let a trial
 * "pass" without running anything.
 */
const TEST_PROJECTS: { project: string; pattern: RegExp }[] = [
  { project: 'unit', pattern: /^tests\/(unit|ecs|game|property|determinism|sensors)\// },
  { project: 'integration', pattern: /^tests\/(integration|balance)\// },
  { project: 'headless', pattern: /^tests\/headless\// },
  { project: 'sprites', pattern: /^tests\/sprites\// },
];

export function resolveTestProject(testPaths: readonly string[]): string {
  const projects = new Set<string>();
  for (const path of testPaths) {
    const match = TEST_PROJECTS.find((candidate) => candidate.pattern.test(path));
    if (!match) throw new Error(`Test file "${path}" belongs to no known vitest project.`);
    projects.add(match.project);
  }
  if (projects.size > 1) {
    throw new Error(
      `Verifier spans multiple vitest projects (${[...projects].join(', ')}). Replay tasks must ` +
        `verify within one project so a trial cannot go green on a partially-run suite.`,
    );
  }
  const [only] = [...projects];
  if (!only) throw new Error('Verifier has no test files.');
  return only;
}

function run(command: string, args: string[], cwd: string): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function repoRoot(cwd: string = process.cwd()): string {
  return run('git', ['rev-parse', '--show-toplevel'], cwd).trim();
}

interface PrFile {
  path: string;
  additions: number;
  deletions: number;
}

interface PrView {
  number: number;
  title: string;
  body: string;
  mergeCommit: { oid: string } | null;
  files: PrFile[];
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

export function hashVerifier(command: string, files: readonly VerifierFile[]): string {
  const payload = JSON.stringify({
    command,
    files: [...files]
      .sort((a, b) => a.path.localeCompare(b.path))
      .map((file) => ({ path: file.path, contents: file.contents })),
  });
  return createHash('sha256').update(payload).digest('hex');
}

export function buildVerifierCommand(testPaths: readonly string[]): string {
  const project = resolveTestProject(testPaths);
  // Explicit project + explicit files: vitest fails rather than passing when the
  // filter matches nothing, so a trial cannot go green on an empty run.
  return `npx vitest run --project ${project} ${testPaths.map((p) => JSON.stringify(p)).join(' ')}`;
}

/**
 * The task statement handed to the agent. Deliberately states the goal and the
 * acceptance tests, never the implementation. The PR body is excluded by
 * default because Crawler PR descriptions routinely narrate the solution.
 */
export function buildPrompt(pr: PrView, testPaths: readonly string[]): string {
  return [
    `Implement the following change in the Crawler repository.`,
    ``,
    `## Goal`,
    pr.title,
    ``,
    `## Acceptance`,
    `The following test files are already present and MUST pass unmodified:`,
    ...testPaths.map((p) => `- \`${p}\``),
    ``,
    `Run them with:`,
    '```bash',
    buildVerifierCommand(testPaths),
    '```',
    ``,
    `## Rules`,
    `- Do NOT modify, weaken, skip, or delete any of the acceptance test files.`,
    `- Follow the repository conventions in AGENTS.md and the layer rules in ESLint.`,
    `- You are finished when the acceptance command exits 0.`,
  ].join('\n');
}

export function buildTask(root: string, prNumber: number): TaskSpec {
  const raw = run(
    'gh',
    ['pr', 'view', String(prNumber), '--json', 'number,title,body,mergeCommit,files'],
    root,
  );
  const pr = JSON.parse(raw) as PrView;

  if (!pr.mergeCommit?.oid) {
    throw new Error(`PR #${prNumber} has no merge commit — only merged PRs can be replayed.`);
  }
  const solutionCommit = pr.mergeCommit.oid;
  const baseCommit = run('git', ['rev-parse', `${solutionCommit}^1`], root).trim();

  const testPaths = pr.files.map((f) => f.path).filter((p) => TEST_PATH_PATTERN.test(p));
  const solutionFiles = pr.files
    .map((f) => f.path)
    .filter((p) => !TEST_PATH_PATTERN.test(p) && !NON_SOLUTION_PATTERN.test(p));

  if (testPaths.length === 0) {
    throw new Error(
      `PR #${prNumber} ("${pr.title}") changed no files under tests/ — it has no frozen verifier ` +
        `and cannot be replayed. Pick a PR that shipped its own tests.`,
    );
  }
  if (solutionFiles.length === 0) {
    throw new Error(
      `PR #${prNumber} ("${pr.title}") changed only tests and docs — there is nothing to build.`,
    );
  }

  const verifierFiles: VerifierFile[] = testPaths.map((path) => ({
    path,
    contents: run('git', ['show', `${solutionCommit}:${path}`], root),
  }));
  const verifierCommand = buildVerifierCommand(testPaths);

  return {
    id: `pr${pr.number}-${slugify(pr.title)}`,
    prNumber: pr.number,
    title: pr.title,
    baseCommit,
    solutionCommit,
    prompt: buildPrompt(pr, testPaths),
    verifierCommand,
    verifierFiles,
    verifierHash: hashVerifier(verifierCommand, verifierFiles),
    solutionFiles,
  };
}

export function validatePack(pack: TaskPack): string[] {
  const problems: string[] = [];
  if (pack.schema !== TASK_PACK_SCHEMA) {
    problems.push(`Unknown schema "${pack.schema}" (expected "${TASK_PACK_SCHEMA}").`);
  }
  if (pack.tasks.length === 0) problems.push('Pack contains no tasks.');

  const seen = new Set<string>();
  for (const task of pack.tasks) {
    if (seen.has(task.id)) problems.push(`Duplicate task id "${task.id}".`);
    seen.add(task.id);

    const expected = hashVerifier(task.verifierCommand, task.verifierFiles);
    if (expected !== task.verifierHash) {
      problems.push(
        `Task "${task.id}": verifier hash mismatch — the frozen verifier was edited after ` +
          `pack construction (expected ${task.verifierHash}, got ${expected}).`,
      );
    }
    if (task.verifierFiles.length === 0) problems.push(`Task "${task.id}": no verifier files.`);
    if (task.prompt.includes(task.solutionCommit)) {
      problems.push(`Task "${task.id}": prompt leaks the solution commit.`);
    }
    for (const file of task.solutionFiles) {
      if (task.prompt.includes(file)) {
        problems.push(`Task "${task.id}": prompt names solution file "${file}".`);
      }
    }
  }
  return problems;
}

export function loadPack(path: string): TaskPack {
  return JSON.parse(readFileSync(path, 'utf8')) as TaskPack;
}

function parseArgs(argv: readonly string[]): { command: string; flags: Map<string, string> } {
  const [command = 'help', ...rest] = argv;
  const flags = new Map<string, string>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i] as string;
    if (token.startsWith('--')) flags.set(token.slice(2), rest[i + 1] ?? 'true');
  }
  return { command, flags };
}

function main(): void {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const root = repoRoot();

  if (command === 'build') {
    const prs = (flags.get('prs') ?? '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    if (prs.length === 0) {
      throw new Error('Pass --prs <comma-separated merged PR numbers>.');
    }
    const id = flags.get('id') ?? `pack-${new Date().toISOString().slice(0, 10)}`;
    const out = resolve(root, flags.get('out') ?? `${DEFAULT_PACK_DIR}/${id}.json`);

    const tasks: TaskSpec[] = [];
    for (const pr of prs) {
      process.stdout.write(`• building task from PR #${pr}…\n`);
      tasks.push(buildTask(root, pr));
    }
    const pack: TaskPack = {
      schema: TASK_PACK_SCHEMA,
      id,
      createdAt: new Date().toISOString(),
      repo: run('git', ['remote', 'get-url', 'origin'], root).trim(),
      tasks,
    };
    const problems = validatePack(pack);
    if (problems.length > 0) {
      throw new Error(`Pack failed validation:\n  - ${problems.join('\n  - ')}`);
    }
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(pack, null, 2)}\n`, 'utf8');
    process.stdout.write(`\n✅ wrote ${tasks.length} task(s) → ${out}\n`);
    return;
  }

  if (command === 'validate') {
    const packPath = flags.get('pack');
    if (!packPath) throw new Error('Pass --pack <path to task pack JSON>.');
    const problems = validatePack(loadPack(resolve(root, packPath)));
    if (problems.length > 0) {
      process.stderr.write(`❌ pack invalid:\n  - ${problems.join('\n  - ')}\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write('✅ pack valid\n');
    return;
  }

  if (command === 'verify-base') {
    const packPath = flags.get('pack');
    if (!packPath) throw new Error('Pass --pack <path to task pack JSON>.');
    const pack = loadPack(resolve(root, packPath));
    const workRootFlag = flags.get('work-root');
    const workRoot = workRootFlag ? resolve(root, workRootFlag) : defaultWorkRoot('basecheck');
    let failures = 0;

    for (const task of pack.tasks) {
      const workspace = join(workRoot, task.id);
      process.stdout.write(`• ${task.id}: preparing base workspace…\n`);
      prepareTrialWorkspace(root, task, workspace, flags.get('install') === 'true');
      const result = spawnSync(task.verifierCommand, {
        cwd: workspace,
        shell: true,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      });
      // The whole point of a replay task is that the verifier is RED before the
      // work is done. A green base means the tests do not actually cover the
      // change, and any trial would score a free win.
      if (result.status === 0) {
        failures++;
        process.stderr.write(
          `  ❌ verifier already PASSES at the base commit — this task measures nothing.\n`,
        );
      } else {
        process.stdout.write(`  ✅ verifier fails at base (exit ${result.status}) as required\n`);
      }
      rmSync(workspace, { recursive: true, force: true });
    }

    if (failures > 0) {
      process.stderr.write(`\n❌ ${failures} task(s) are not fail-to-pass; remove them.\n`);
      process.exitCode = 1;
      return;
    }
    process.stdout.write('\n✅ every task is fail-to-pass\n');
    return;
  }

  process.stdout.write(
    [
      'Usage:',
      '  npm run velocity:pack -- build --prs 1930,1875 [--id <slug>] [--out <path>]',
      '  npm run velocity:pack -- validate --pack <path>',
      '  npm run velocity:pack -- verify-base --pack <path> [--install]',
      '',
    ].join('\n'),
  );
}

// Only run the CLI when invoked directly, so the pure helpers stay unit-testable.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'))) {
  main();
}
