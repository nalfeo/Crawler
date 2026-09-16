/**
 * A small, manifest-driven alternative to several agent inspection round trips.
 * Requests are deliberately data, never commands: this module executes no shell
 * and resolves every file reference beneath the supplied repository root.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

import { boundOutput } from './bounded-output.js';

const SECTION_LIMITS = { maxChars: 1_200, maxLines: 40 };
const AGGREGATE_LIMITS = { maxChars: 7_200, maxLines: 180 };
const MAX_REQUESTS = 12;

type Request =
  | {
      readonly kind: 'file';
      readonly path: string;
      readonly startLine?: number;
      readonly lineCount?: number;
    }
  | { readonly kind: 'search'; readonly pattern: string; readonly paths?: readonly string[] }
  | { readonly kind: 'package-script'; readonly name: string }
  | { readonly kind: 'git-status' };

export interface InspectManifest {
  readonly requests: readonly Request[];
}

function safePath(repoRoot: string, value: string): string {
  if (!value || value.includes('\0')) throw new Error('path must be a non-empty relative path');
  const candidate = resolve(repoRoot, value);
  const relation = relative(repoRoot, candidate);
  if (
    relation === '' ||
    relation === '..' ||
    relation.startsWith(`..${sep}`) ||
    relation.includes('\0')
  )
    throw new Error(`path escapes repository root: ${value}`);
  if (existsSync(candidate)) {
    const resolvedRelation = relative(realpathSync(repoRoot), realpathSync(candidate));
    if (resolvedRelation === '..' || resolvedRelation.startsWith(`..${sep}`))
      throw new Error(`path resolves outside repository root: ${value}`);
  }
  return candidate;
}

function assertRequest(value: unknown): Request {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('request must be an object');
  const request = value as Record<string, unknown>;
  if (request.kind === 'file' && typeof request.path === 'string') {
    return {
      kind: 'file',
      path: request.path,
      startLine: numberOption(request.startLine),
      lineCount: numberOption(request.lineCount),
    };
  }
  if (request.kind === 'search' && typeof request.pattern === 'string') {
    if (
      request.paths !== undefined &&
      (!Array.isArray(request.paths) || !request.paths.every((path) => typeof path === 'string'))
    )
      throw new Error('search.paths must be an array of paths');
    return {
      kind: 'search',
      pattern: request.pattern,
      paths: request.paths as readonly string[] | undefined,
    };
  }
  if (request.kind === 'package-script' && typeof request.name === 'string')
    return { kind: 'package-script', name: request.name };
  if (request.kind === 'git-status') return { kind: 'git-status' };
  throw new Error(`unknown or malformed request kind: ${String(request.kind)}`);
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 1_000)
    throw new Error('line options must be integers from 1 to 1000');
  return value as number;
}

export function parseManifest(value: unknown): InspectManifest {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('manifest must be an object');
  const requests = (value as Record<string, unknown>).requests;
  if (!Array.isArray(requests) || requests.length === 0 || requests.length > MAX_REQUESTS)
    throw new Error(`manifest.requests must contain 1 to ${MAX_REQUESTS} requests`);
  return { requests: requests.map(assertRequest) };
}

function fileSection(request: Extract<Request, { kind: 'file' }>, repoRoot: string): string {
  const path = safePath(repoRoot, request.path);
  const stat = statSync(path);
  if (!stat.isFile()) throw new Error('path is not a file');
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u);
  const start = (request.startLine ?? 1) - 1;
  const count = request.lineCount ?? 30;
  return `${request.path} (${stat.size} bytes)\n${lines
    .slice(start, start + count)
    .map((line, index) => `${start + index + 1}: ${line}`)
    .join('\n')}`;
}

function searchSection(request: Extract<Request, { kind: 'search' }>, repoRoot: string): string {
  if (!request.pattern) throw new Error('search.pattern must not be empty');
  const paths = request.paths?.length
    ? request.paths.map((path) => {
        const resolved = safePath(repoRoot, path);
        if (!existsSync(resolved)) throw new Error(`search path does not exist: ${path}`);
        return relative(repoRoot, resolved);
      })
    : ['.'];
  // The executable and all flags are fixed. `--fixed-strings` makes manifest
  // patterns literal and prevents both shell interpolation and regex surprises.
  const result = spawnSync(
    'rg',
    [
      '--fixed-strings',
      '--line-number',
      '--no-heading',
      '--color',
      'never',
      '--',
      request.pattern,
      ...paths,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  if (result.error) throw result.error;
  if (result.status === 1) return `[no literal matches for ${JSON.stringify(request.pattern)}]`;
  if (result.status !== 0) throw new Error((result.stderr || 'rg failed').trim());
  return result.stdout;
}

function packageScriptSection(
  request: Extract<Request, { kind: 'package-script' }>,
  repoRoot: string,
): string {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
    scripts?: Record<string, unknown>;
  };
  const command = packageJson.scripts?.[request.name];
  return typeof command === 'string'
    ? `${request.name}: ${command}`
    : `[no package script named ${JSON.stringify(request.name)}]`;
}

function gitStatusSection(repoRoot: string): string {
  // Arguments are fixed here; no manifest value is ever interpreted as a command.
  if (!existsSync(resolve(repoRoot, '.git'))) return '[not a git worktree]';
  const status = execFileSync('git', ['status', '--short'], { cwd: repoRoot, encoding: 'utf8' });
  return status || '[clean worktree]';
}

function inspectOne(request: Request, repoRoot: string): string {
  switch (request.kind) {
    case 'file':
      return fileSection(request, repoRoot);
    case 'search':
      return searchSection(request, repoRoot);
    case 'package-script':
      return packageScriptSection(request, repoRoot);
    case 'git-status':
      return gitStatusSection(repoRoot);
  }
}

export function inspect(manifest: InspectManifest, repoRoot: string): string {
  const sections = manifest.requests.map((request, index) => {
    let body: string;
    try {
      body = inspectOne(request, repoRoot);
    } catch (error) {
      body = `[request error: ${error instanceof Error ? error.message : String(error)}]`;
    }
    return `## ${index + 1}. ${request.kind}\n${boundOutput(body, SECTION_LIMITS).text}`;
  });
  return boundOutput(sections.join('\n\n'), AGGREGATE_LIMITS).text;
}

export function main(argv = process.argv.slice(2)): number {
  if (argv.length !== 2 || argv[0] !== '--manifest') {
    process.stderr.write('Usage: npm run agent:inspect -- --manifest <relative-json-file>\n');
    return 2;
  }
  try {
    const repoRoot = process.cwd();
    const manifestPath = safePath(repoRoot, argv[1]!);
    const manifest = parseManifest(JSON.parse(readFileSync(manifestPath, 'utf8')));
    process.stdout.write(`${inspect(manifest, repoRoot)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(
      `agent:inspect: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

if (process.argv[1]?.endsWith('inspect.ts')) process.exitCode = main();
